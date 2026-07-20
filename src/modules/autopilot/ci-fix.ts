/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  type GitHubCheckSummary,
  type GitHubFailingCheckFact,
  type GitHubPullRequestDetail,
  type GitHubPullRequestEventState,
  fetchPullRequestEventState,
  fetchCheckSummary,
  fetchFailingCheckFacts,
  fetchPullRequestDetail,
} from '../github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  pathDeniedByAutopilotPolicy,
  repoGuardrails,
  withAutopilotLocalExecutionSlot,
} from '../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../app-state';
import {
  notifyAutopilotState,
  recoveryActionsForPreparedDiff,
} from './notifications';
import { buildPreparedDiffAuditSummary } from '../autonomous-audit';
import { runApprovedExecution } from '../execution';
import {
  getGitHubPrBranchPermissions,
  postGitHubPrComment,
} from '../pr-events';
import {
  ensurePreparedDiffForWorktree,
  markPreparedDiffPushBlocked,
  markPreparedDiffPushed,
  readPreparedDiff,
  readPreparedDiffByWorktree,
  readPreparedDiffRecord,
  recordPreparedDiffVerification,
  type PreparedDiffRecord,
} from '../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  gitCurrentSha,
  gitCommitAll,
  gitCommitPaths,
  gitPushHead,
  gitStatus,
  type GitCommitResult,
} from '../../repo-edit/git';
import {
  patchRepoFiles,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
} from '../../repo-edit';
import { parseV4APatch } from '../../repo-edit/patch-parser';
import { repoRelativePathSchema } from '../../repo-edit/schemas';
import {
  type RuntimePaths,
  parseAppConfig,
  ensureRuntimeHome,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import {
  createWorktree,
  assertWorktreeMutationAllowed,
  listWorktrees,
  lockWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
  readManagedWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
  type WorktreeRecord,
} from '../worktrees';
import {
  AutopilotActionResult,
  AutopilotDependencies,
  AutopilotTriageClass,
  autopilotFixtureSchema,
  autopilotModeSchema,
  autopilotOutputSchema,
  checkSummarySchema,
  commentPrAutofixResultInputSchema,
  fixPrCiFailureInputSchema,
  fixPrReviewFeedbackInputSchema,
  prEventDeltaSchema,
  prEventSnapshotSchema,
  prFactsSchema,
  prReviewEventStateSchema,
  preparePrWorktreeInputSchema,
  pushPrAutofixInputSchema,
  reviewFixReplacementSchema,
  triagePrEventInputSchema,
} from './schemas';
import {
  asJsonValue,
  failResult,
  lowerLevelFailure,
  parseInput,
  resolveVerificationChecks,
  objectField,
  stringField,
  booleanField,
  numberField,
  arrayField,
  numberArrayField,
  unique,
  errorMessage,
  isAutopilotActionResult,
} from './utils';
import { dependenciesWithAutopilotFixture } from './fixtures';
import {
  fetchPreparedPrFacts,
  fetchPreparedCheckFacts,
  fetchCiFailureFacts,
  generatedCiFixCommitMessage,
  identifyLikelyCommands,
  runAutopilotDiagnostics,
} from './github-facts';
import {
  prFactsFromDetail,
  repoSummary,
  classifySignals,
  classificationFor,
  reasonsFor,
} from './triage-support';
import {
  blockPushAttempt,
  preparedDiffCommitSha,
  pushNotReadyResult,
  pushReadinessGates,
  recoveryOptionsForPushBlock,
  remoteForPush,
} from './push-support';
import {
  addressedFeedback,
  applyReviewEdits,
  buildReviewFixPlan,
  fetchReviewEventState,
  groupReviewFeedback,
  plannedEditPaths,
  readReviewTargetFiles,
  reviewFactsFromEventState,
  reviewFixCommitMessage,
  reviewTargetPathSet,
  worktreeStatusDirty,
} from './review-support';

export async function fixPrCiFailure(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    fixPrCiFailureInputSchema,
    rawInput,
    'autopilot_fix_pr_ci_failure',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  dependencies = await dependenciesWithAutopilotFixture(dependencies);
  let acquiredLockId: string | undefined;
  const lockOwner = input.lockOwner ?? 'fix_pr_ci_failure';
  let finalLockStatus: 'ready' | 'prepared-diff' | 'failed' = 'ready';
  let mutationApplied = false;
  let notificationWorktree: WorktreeRecord | undefined;
  let notificationRepoFullName: string | undefined;

  try {
    await ensureRuntimeHome(paths);
    const [registry, appConfig, worktreeSnapshot] = await Promise.all([
      readRepoRegistrySnapshot(paths),
      readRuntimeJson(paths.config, parseAppConfig),
      listWorktrees(paths),
    ]);
    const worktree = worktreeSnapshot.worktrees.find(
      (candidate) => candidate.id === input.worktreeId,
    );
    if (!worktree || worktree.lifecycleStatus === 'deleted') {
      return failResult(
        'autopilot_fix_pr_ci_failure',
        `Worktree "${input.worktreeId}" was not found.`,
        { requires: ['worktreeId'] },
      );
    }
    notificationWorktree = worktree;
    const repo = registry.repos.find(
      (candidate) => candidate.id === worktree.repoId,
    );
    if (!repo) {
      return failResult(
        'autopilot_fix_pr_ci_failure',
        `Repository "${worktree.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }
    notificationRepoFullName = repoFullName(repo);

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: worktree.prNumber,
        workflow: 'fix_pr_ci_failure',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_fix_pr_ci_failure',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    const locked = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: 'pr',
        owner: lockOwner,
        ttlSeconds: input.lockTtlSeconds ?? 3_600,
      },
      paths,
    );
    if (!locked.ok) {
      return lowerLevelFailure(
        'autopilot_fix_pr_ci_failure',
        'worktree_lock',
        locked,
      );
    }
    acquiredLockId = stringField(objectField(locked, 'lock'), 'id');

    if (
      input.expectedWorktreeHeadSha &&
      (await gitCurrentSha(worktree.localPath)) !==
        input.expectedWorktreeHeadSha
    ) {
      return failResult(
        'autopilot_fix_pr_ci_failure',
        'Worktree HEAD changed before the deterministic CI fix acquired its mutation lease.',
        { requires: ['refreshWorktreeHead'] },
      );
    }

    const baselineStatus = await readWorktreeStatus(
      { worktreeId: worktree.id },
      paths,
    );
    if (worktreeStatusDirty(baselineStatus)) {
      return failResult(
        'autopilot_fix_pr_ci_failure',
        'Worktree has existing uncommitted changes; refusing to mix them into an autonomous CI fix.',
        { requires: ['cleanWorktree'] },
      );
    }

    const pr =
      worktree.prNumber === null
        ? null
        : await fetchPreparedPrFacts(
            repo.github.owner,
            repo.github.name,
            worktree.prNumber,
            dependencies,
          );
    if (pr && 'ok' in pr && !pr.ok) {
      return { ...pr, action: 'autopilot_fix_pr_ci_failure' };
    }
    if (
      input.expectedHeadSha &&
      pr &&
      !('ok' in pr) &&
      pr.headSha !== input.expectedHeadSha
    ) {
      return failResult(
        'autopilot_fix_pr_ci_failure',
        'Pull request HEAD changed before the deterministic CI fix began.',
        { requires: ['refreshPrHead'] },
      );
    }
    const ref =
      (pr && !('ok' in pr) ? pr.headSha : null) ??
      worktree.headSha ??
      worktree.headRef;
    const checkFactsResult = await fetchCiFailureFacts(
      repo.github.owner,
      repo.github.name,
      ref,
      input.maxLogBytes,
      dependencies,
    );
    if (!Array.isArray(checkFactsResult)) return checkFactsResult;
    const checkFacts = checkFactsResult;

    const likelyCommands = identifyLikelyCommands(
      checkFacts,
      repo,
      repoGuardrails(repo, appConfig).requiredChecks,
      input.checks,
      input.diagnostics,
    );
    assertWorktreeMutationAllowed(
      {
        repoId: repo.id,
        worktreeId: worktree.id,
        lockId: acquiredLockId,
      },
      paths,
    );
    const diagnostics = await runAutopilotDiagnostics(
      likelyCommands,
      concurrency.limits,
      {
        repoId: repo.id,
        repoFullName: repoFullName(repo),
        prNumber: worktree.prNumber,
        worktreeId: worktree.id,
        workflow: 'fix_pr_ci_failure',
      },
      worktree.localPath,
      paths,
      input,
      dependencies,
      () => {
        assertWorktreeMutationAllowed(
          {
            repoId: repo.id,
            worktreeId: worktree.id,
            lockId: acquiredLockId,
          },
          paths,
        );
      },
    );
    const blocked = diagnostics.some((item) => item.requires.length > 0);
    if (blocked && input.patch) {
      return {
        ok: false,
        action: 'autopilot_fix_pr_ci_failure',
        changed: false,
        message:
          'CI failure diagnostics are blocked by execution approval or concurrency policy.',
        data: asJsonValue({
          repo: {
            id: repo.id,
            fullName: repoFullName(repo),
            path: repo.path,
            defaultBranch: repo.defaultBranch,
          },
          worktree,
          pr: pr && !('ok' in pr) ? pr : null,
          ref,
          failingChecks: checkFacts,
          likelyCommands,
          diagnostics,
          patchSkipped: true,
        }),
        errors: diagnostics
          .filter((item) => !item.ok)
          .map((item) => item.message),
        requires: ['approval'],
      };
    }
    const postDiagnosticStatus = await readWorktreeStatus(
      { worktreeId: worktree.id },
      paths,
    );
    if (worktreeStatusDirty(postDiagnosticStatus)) {
      finalLockStatus = 'failed';
      return {
        ok: false,
        action: 'autopilot_fix_pr_ci_failure',
        changed: true,
        message:
          'CI diagnostics modified the worktree; refusing to apply or commit a fix.',
        data: asJsonValue({
          repo: {
            id: repo.id,
            fullName: repoFullName(repo),
            path: repo.path,
            defaultBranch: repo.defaultBranch,
          },
          worktree,
          pr: pr && !('ok' in pr) ? pr : null,
          ref,
          failingChecks: checkFacts,
          likelyCommands,
          diagnostics,
          status: postDiagnosticStatus,
        }),
        errors: ['Diagnostics left the worktree dirty.'],
        requires: ['cleanWorktree'],
      };
    }

    let patchResult: unknown = null;
    if (input.patch) {
      const mutationPolicy = await checkAutopilotPolicy(
        {
          worktreeId: worktree.id,
          pushDestination: 'pull-request-head',
        },
        paths,
      );
      if (mutationPolicy.mode === 'notify-only') {
        return failResult(
          'autopilot_fix_pr_ci_failure',
          'Current Autopilot policy no longer permits deterministic CI edits.',
          { requires: ['autopilotMode'] },
        );
      }
      if (
        input.expectedWorktreeHeadSha &&
        (await gitCurrentSha(worktree.localPath)) !==
          input.expectedWorktreeHeadSha
      ) {
        return failResult(
          'autopilot_fix_pr_ci_failure',
          'Worktree HEAD changed immediately before deterministic CI edits.',
          { requires: ['refreshWorktreeHead'] },
        );
      }
      const patched = await patchRepoFiles(
        {
          repoId: repo.id,
          worktreeId: worktree.id,
          worktreeLockId: acquiredLockId,
          patch: input.patch,
          reason:
            input.patchReason ?? 'Apply scoped fix for failing PR CI checks.',
        },
        paths,
      );
      if (!booleanField(patched, 'ok')) {
        return lowerLevelFailure(
          'autopilot_fix_pr_ci_failure',
          'repo_file_patch',
          patched,
        );
      }
      patchResult = patched;
      mutationApplied = true;

      const policy = await checkAutopilotPolicy(
        {
          worktreeId: worktree.id,
          pushDestination: 'pull-request-head',
        },
        paths,
      );
      if (!policy.ok || policy.blocked || policy.approvalRequired) {
        finalLockStatus = 'prepared-diff';
        assertWorktreeMutationAllowed(
          {
            repoId: repo.id,
            worktreeId: worktree.id,
            lockId: acquiredLockId,
          },
          paths,
        );
        const preparedDiff = await ensurePreparedDiffForWorktree(
          worktree,
          paths,
          {
            title: `CI fix for ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'}`,
            createdBy: 'fix_pr_ci_failure',
            resetDecisionState: true,
            summary: {
              confidence: input.confidence ?? 'low',
              risk: input.risk ?? 'high',
              remainingManualAsks: [
                ...(input.manualAsks ?? []),
                'Review autopilot policy findings before committing or pushing.',
              ],
              failingChecks: checkFacts.map((fact) => ({
                id: fact.id,
                name: fact.name,
                conclusion: fact.conclusion,
                logsAvailable: fact.log.available,
                logsUnavailableReason: fact.log.unavailableReason,
              })),
              diagnostics,
              policy,
              committed: false,
            },
          },
        );
        await notifyAutopilotState(
          {
            state: 'ci-fix',
            outcome: 'prepared',
            preparedDiffId: preparedDiff.id,
            worktreeId: worktree.id,
            repoFullName: repoFullName(repo),
            prNumber: worktree.prNumber,
            workflow: 'fix_pr_ci_failure',
            message: `Prepared a CI-failure fix for ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'} that needs policy review before commit or push.`,
            recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
            data: { policy, diagnostics },
          },
          paths,
        );
        return {
          ok: false,
          action: 'autopilot_fix_pr_ci_failure',
          changed: true,
          message: policy.message,
          data: asJsonValue({
            repo: {
              id: repo.id,
              fullName: repoFullName(repo),
              path: repo.path,
              defaultBranch: repo.defaultBranch,
            },
            worktree,
            pr: pr && !('ok' in pr) ? pr : null,
            ref,
            failingChecks: checkFacts,
            likelyCommands,
            diagnostics,
            patch: patchResult,
            policy,
            preparedDiff,
            status: await readWorktreeStatus(
              { worktreeId: worktree.id },
              paths,
            ),
          }),
          errors: policy.reasons,
          requires: policy.requires.length > 0 ? policy.requires : ['approval'],
        };
      }
    }

    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);
    const dirty = Boolean(booleanField(objectField(status, 'git'), 'dirty'));
    const commitPolicy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        pushDestination: 'pull-request-head',
      },
      paths,
    );
    let commit: unknown = null;
    if (
      dirty &&
      input.commit !== false &&
      commitPolicy.ok &&
      !commitPolicy.blocked &&
      !commitPolicy.approvalRequired &&
      (commitPolicy.mode === 'autofix-with-approval' ||
        commitPolicy.mode === 'autofix-push-when-safe')
    ) {
      try {
        assertWorktreeMutationAllowed(
          {
            repoId: repo.id,
            worktreeId: worktree.id,
            lockId: acquiredLockId,
          },
          paths,
        );
        commit = await gitCommitAll(
          worktree.localPath,
          input.commitMessage ??
            generatedCiFixCommitMessage(
              repoFullName(repo),
              worktree.prNumber,
              checkFacts,
            ),
        );
      } catch (error) {
        finalLockStatus = 'prepared-diff';
        assertWorktreeMutationAllowed(
          {
            repoId: repo.id,
            worktreeId: worktree.id,
            lockId: acquiredLockId,
          },
          paths,
        );
        const preparedDiff = await ensurePreparedDiffForWorktree(
          worktree,
          paths,
          {
            title: `CI fix for ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'}`,
            createdBy: 'fix_pr_ci_failure',
            resetDecisionState: true,
            summary: {
              confidence: input.confidence ?? 'medium',
              risk: input.risk ?? 'medium',
              remainingManualAsks: [
                'Inspect the dirty worktree and commit the retained CI fix manually.',
                ...(input.manualAsks ?? []),
              ],
              failingChecks: checkFacts.map((fact) => ({
                id: fact.id,
                name: fact.name,
                conclusion: fact.conclusion,
                logsAvailable: fact.log.available,
                logsUnavailableReason: fact.log.unavailableReason,
              })),
              diagnostics,
              commitError: errorMessage(error),
            },
          },
        );
        await notifyAutopilotState(
          {
            state: 'ci-fix',
            outcome: 'prepared',
            preparedDiffId: preparedDiff.id,
            worktreeId: worktree.id,
            repoFullName: repoFullName(repo),
            prNumber: worktree.prNumber,
            workflow: 'fix_pr_ci_failure',
            message: `Retained a CI-failure fix for ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'} after commit failed.`,
            recoveryOptions: [
              'Inspect the retained worktree and commit or discard local changes manually.',
              'Retry verification after the worktree is clean and committed.',
            ],
            recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
            data: { diagnostics, commitError: errorMessage(error) },
          },
          paths,
        );
        return {
          ok: false,
          action: 'autopilot_fix_pr_ci_failure',
          changed: true,
          message:
            'Applied a CI-failure fix, but could not create the commit. The dirty worktree was retained as a prepared diff.',
          data: asJsonValue({
            repo: {
              id: repo.id,
              fullName: repoFullName(repo),
              path: repo.path,
              defaultBranch: repo.defaultBranch,
            },
            worktree,
            pr: pr && !('ok' in pr) ? pr : null,
            ref,
            failingChecks: checkFacts,
            likelyCommands,
            diagnostics,
            patch: patchResult,
            preparedDiff,
            status: await readWorktreeStatus(
              { worktreeId: worktree.id },
              paths,
            ),
          }),
          errors: [errorMessage(error)],
          requires: ['manualCommit'],
        };
      }
    }

    const afterStatus = await readWorktreeStatus(
      { worktreeId: worktree.id },
      paths,
    );
    const changed =
      Boolean(patchResult) ||
      Boolean((commit as { committed?: boolean } | null)?.committed);
    let preparedDiff: PreparedDiffRecord | null = null;
    if (changed) {
      finalLockStatus = 'prepared-diff';
      assertWorktreeMutationAllowed(
        {
          repoId: repo.id,
          worktreeId: worktree.id,
          lockId: acquiredLockId,
        },
        paths,
      );
      preparedDiff = await ensurePreparedDiffForWorktree(worktree, paths, {
        title: `CI fix for ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'}`,
        createdBy: 'fix_pr_ci_failure',
        resetDecisionState: true,
        summary: {
          confidence: input.confidence ?? 'medium',
          risk: input.risk ?? 'medium',
          remainingManualAsks: input.manualAsks ?? [],
          failingChecks: checkFacts.map((fact) => ({
            id: fact.id,
            name: fact.name,
            conclusion: fact.conclusion,
            logsAvailable: fact.log.available,
            logsUnavailableReason: fact.log.unavailableReason,
          })),
          diagnostics,
          commit,
        },
      });
      await notifyAutopilotState(
        {
          state: 'ci-fix',
          outcome: 'prepared',
          preparedDiffId: preparedDiff.id,
          worktreeId: worktree.id,
          repoFullName: repoFullName(repo),
          prNumber: worktree.prNumber,
          workflow: 'fix_pr_ci_failure',
          message: `Prepared a CI-failure fix for ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'}.`,
          recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
          data: { diagnostics, commit },
        },
        paths,
      );
    }

    const failedDiagnostics = diagnostics.filter((item) => !item.ok);
    return {
      ok: !blocked && (changed || diagnostics.length > 0),
      action: 'autopilot_fix_pr_ci_failure',
      changed,
      message: changed
        ? `Prepared a CI-failure fix for ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'}.`
        : blocked
          ? 'CI failure diagnostics are blocked by execution approval or concurrency policy.'
          : 'Fetched CI failure facts and ran diagnostics; no patch was supplied, so no fix was applied.',
      data: asJsonValue({
        repo: {
          id: repo.id,
          fullName: repoFullName(repo),
          path: repo.path,
          defaultBranch: repo.defaultBranch,
        },
        worktree,
        pr: pr && !('ok' in pr) ? pr : null,
        ref,
        failingChecks: checkFacts,
        likelyCommands,
        diagnostics,
        patch: patchResult,
        commit,
        preparedDiff,
        status: afterStatus,
        confidence: input.confidence ?? (changed ? 'medium' : 'low'),
        risk: input.risk ?? 'medium',
        remainingManualAsks:
          input.manualAsks ??
          (changed ? [] : ['Provide a scoped repo-edit patch to apply.']),
      }),
      ...(failedDiagnostics.length > 0
        ? { errors: failedDiagnostics.map((item) => item.message) }
        : {}),
      ...(blocked ? { requires: ['approval'] } : {}),
    };
  } catch (error) {
    if (mutationApplied) finalLockStatus = 'failed';
    if (notificationWorktree) {
      const preparedDiff = readPreparedDiffByWorktree(
        notificationWorktree.id,
        paths,
      );
      if (preparedDiff) {
        await notifyAutopilotState(
          {
            state: 'failed-workflow',
            outcome: 'failed',
            preparedDiffId: preparedDiff.id,
            worktreeId: notificationWorktree.id,
            repoFullName:
              notificationRepoFullName ?? notificationWorktree.repoFullName,
            prNumber: notificationWorktree.prNumber,
            workflow: 'fix_pr_ci_failure',
            message: `fix_pr_ci_failure failed: ${errorMessage(error)}`,
            recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
            data: { error: errorMessage(error) },
          },
          paths,
        ).catch(() => undefined);
      }
    }
    return failResult(
      'autopilot_fix_pr_ci_failure',
      'Could not fix PR CI failure.',
      { errors: [errorMessage(error)] },
    );
  } finally {
    if (acquiredLockId) {
      await releaseWorktreeLock(
        {
          lockId: acquiredLockId,
          owner: lockOwner,
          finalStatus: finalLockStatus,
        },
        paths,
      ).catch(() => undefined);
    }
  }
}
