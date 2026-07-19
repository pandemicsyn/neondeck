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
  replaceRepoFilesAtomically,
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
  ensurePrWorktree,
  assertWorktreeMutationAllowed,
  lockWorktree,
  recordWorktreePushBlocked,
  recordWorktreePushSucceeded,
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
  verifyPrWorktreeInputSchema,
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
  formatIds,
  groupReviewFeedback,
  plannedEditPaths,
  readReviewTargetFiles,
  reviewFactsFromEventState,
  reviewFixCommitMessage,
  reviewTargetPathSet,
  worktreeStatusDirty,
} from './review-support';

export async function fixPrReviewFeedback(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    fixPrReviewFeedbackInputSchema,
    rawInput,
    'autopilot_fix_pr_review_feedback',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  dependencies = await dependenciesWithAutopilotFixture(dependencies);
  const lockOwner = input.lockOwner ?? 'fix_pr_review_feedback';
  let acquiredLockId: string | undefined;
  let finalLockStatus: 'ready' | 'prepared-diff' | 'failed' = 'ready';
  let worktree: WorktreeRecord | undefined;

  try {
    await ensureRuntimeHome(paths);
    const [registry, appConfig] = await Promise.all([
      readRepoRegistrySnapshot(paths),
      readRuntimeJson(paths.config, parseAppConfig),
    ]);
    const repo = registry.repos.find((item) => item.id === input.repoId);
    if (!repo) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        `Repository "${input.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const fetchedEventState = await fetchReviewEventState(
      repo.github.owner,
      repo.github.name,
      input.prNumber,
      dependencies,
    );
    if (isAutopilotActionResult(fetchedEventState)) return fetchedEventState;
    const eventState = fetchedEventState;
    if (input.expectedHeadSha && eventState.headSha !== input.expectedHeadSha) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'Pull request HEAD changed before the deterministic review fix began.',
        { requires: ['refreshPrHead'] },
      );
    }

    const reviewFacts = reviewFactsFromEventState(eventState);
    if (reviewFacts.truncated) {
      return {
        ok: false,
        action: 'autopilot_fix_pr_review_feedback',
        changed: false,
        message:
          'PR review facts are incomplete; refusing to apply review-feedback edits from truncated GitHub data.',
        requires: ['completeReviewFacts'],
        data: asJsonValue({
          repo: repoSummary(repo),
          prNumber: input.prNumber,
          truncation: reviewFacts.truncation,
        }),
      };
    }
    const groups = groupReviewFeedback(reviewFacts.unresolvedComments);
    const plan = buildReviewFixPlan(groups, reviewFacts.requestedChanges);
    if (reviewFacts.unresolvedCommentCount === 0) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'No unresolved PR review comments were found.',
        { requires: ['unresolvedReviewComments'] },
      );
    }
    const hasEdits =
      (input.replacements?.length ?? 0) > 0 || typeof input.patch === 'string';
    const reviewTargetPaths = reviewTargetPathSet(groups);
    const plannedPaths = plannedEditPaths(
      input.replacements ?? [],
      input.patch,
    );
    const addressed = addressedFeedback(
      reviewFacts.unresolvedComments,
      input.addressedReviewCommentIds,
      input.addressedReviewThreadIds,
      plannedPaths,
    );
    if (
      addressed.ignoredReviewCommentIds.length > 0 ||
      addressed.ignoredReviewThreadIds.length > 0
    ) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'One or more addressed review ids are not unresolved comments or threads on this PR.',
        {
          errors: [
            `Ignored review comments: ${formatIds(addressed.ignoredReviewCommentIds)}.`,
            `Ignored review threads: ${formatIds(addressed.ignoredReviewThreadIds)}.`,
          ],
        },
      );
    }
    const invalidPlannedPaths = plannedPaths.filter(
      (path) => !reviewTargetPaths.has(path),
    );
    if (invalidPlannedPaths.length > 0) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'Review feedback fixes may only edit files that have unresolved review comments.',
        {
          errors: [
            `Outside review feedback paths: ${invalidPlannedPaths.join(', ')}.`,
          ],
        },
      );
    }
    const preflightGuardrails = repoGuardrails(repo, appConfig);
    const deniedPlannedPaths = plannedPaths.filter((path) =>
      pathDeniedByAutopilotPolicy(path, preflightGuardrails),
    );
    if (deniedPlannedPaths.length > 0) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'Autopilot policy denies one or more planned review feedback paths.',
        {
          errors: [`Denied paths: ${deniedPlannedPaths.join(', ')}.`],
          requires: ['deniedFileGlobs'],
        },
      );
    }

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: input.prNumber,
        workflow: 'fix_pr_review_feedback',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_fix_pr_review_feedback',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency, reviewFacts, plan }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    const createEnabled = input.createWorktree ?? !input.worktreeId;
    if (input.worktreeId || createEnabled) {
      try {
        worktree = await ensurePrWorktree(
          {
            repo,
            prNumber: input.prNumber,
            eventState,
            worktreeId: input.worktreeId,
          },
          paths,
        );
      } catch (error) {
        if (input.worktreeId && errorMessage(error).includes('belongs to PR')) {
          return failResult(
            'autopilot_fix_pr_review_feedback',
            errorMessage(error),
            { requires: ['worktreeId'] },
          );
        }
        throw error;
      }
    }

    if (!worktree) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'A worktreeId is required when createWorktree is false.',
        { requires: ['worktreeId'] },
      );
    }

    if (input.sync ?? true) {
      const synced = await syncWorktree(
        {
          worktreeId: worktree.id,
          headRef: eventState.headRef ?? eventState.headSha,
          headSha: eventState.headSha,
          fetch: input.fetch,
        },
        paths,
      );
      if (!synced.ok) {
        return lowerLevelFailure(
          'autopilot_fix_pr_review_feedback',
          'worktree_sync',
          synced,
        );
      }
      worktree =
        (objectField(synced, 'worktree') as WorktreeRecord | undefined) ??
        worktree;
    }

    if (input.lock ?? true) {
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
          'autopilot_fix_pr_review_feedback',
          'worktree_lock',
          locked,
        );
      }
      acquiredLockId = stringField(objectField(locked, 'lock'), 'id');
    }

    if (
      input.expectedWorktreeHeadSha &&
      (await gitCurrentSha(worktree.localPath)) !==
        input.expectedWorktreeHeadSha
    ) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'Worktree HEAD changed before the deterministic review fix acquired its mutation lease.',
        { requires: ['refreshWorktreeHead'] },
      );
    }

    const baselineStatus = await readWorktreeStatus(
      { worktreeId: worktree.id },
      paths,
    );
    if (worktreeStatusDirty(baselineStatus)) {
      return {
        ok: false,
        action: 'autopilot_fix_pr_review_feedback',
        changed: false,
        message:
          'Review feedback fix requires a clean managed worktree before applying edits.',
        data: asJsonValue({
          repo: repoSummary(repo),
          worktree,
          reviewFacts,
          plan,
          status: baselineStatus,
          concurrency,
        }),
        requires: ['cleanWorktree'],
      };
    }

    const fileReads = await readReviewTargetFiles(
      repo.id,
      worktree.id,
      groups,
      input.maxReadLinesPerFile ?? 2_000,
      paths,
    );
    const failedReads = fileReads.filter((item) => !item.ok);
    if (failedReads.length > 0) {
      return {
        ok: false,
        action: 'autopilot_fix_pr_review_feedback',
        changed: false,
        message: 'Could not read one or more review target files.',
        data: asJsonValue({
          repo: repoSummary(repo),
          worktree,
          reviewFacts,
          plan,
          fileReads,
          concurrency,
        }),
        errors: failedReads.map((item) => item.message),
      };
    }

    const mutationPolicy = hasEdits
      ? await checkAutopilotPolicy(
          {
            worktreeId: worktree.id,
            pushDestination: 'pull-request-head',
          },
          paths,
        )
      : null;
    if (mutationPolicy?.mode === 'notify-only') {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'Current Autopilot policy no longer permits deterministic review edits.',
        { requires: ['autopilotMode'] },
      );
    }
    if (
      hasEdits &&
      input.expectedWorktreeHeadSha &&
      (await gitCurrentSha(worktree.localPath)) !==
        input.expectedWorktreeHeadSha
    ) {
      return failResult(
        'autopilot_fix_pr_review_feedback',
        'Worktree HEAD changed immediately before deterministic review edits.',
        { requires: ['refreshWorktreeHead'] },
      );
    }
    let mutationScopeBound = false;

    const editResults = hasEdits
      ? await applyReviewEdits(
          {
            repoId: repo.id,
            worktreeId: worktree.id,
            lockId: acquiredLockId,
            replacements: input.replacements ?? [],
            patch: input.patch,
            dryRun: input.dryRun,
            fileReads,
            beforeExternalMutation: async (effect) => {
              await dependencies.ownerMutationFence?.(
                mutationScopeBound ? 'before-write' : 'before-mutation',
                effect,
              );
              mutationScopeBound = true;
            },
          },
          paths,
        )
      : [];
    const failedEdits = editResults.filter((item) => !booleanField(item, 'ok'));
    if (failedEdits.length > 0) {
      finalLockStatus = 'failed';
      return {
        ok: false,
        action: 'autopilot_fix_pr_review_feedback',
        changed: editResults.some((item) => booleanField(item, 'changed')),
        message: 'One or more review feedback edits failed.',
        data: asJsonValue({
          repo: repoSummary(repo),
          worktree,
          reviewFacts,
          plan,
          fileReads,
          editResults,
          concurrency,
        }),
        errors: failedEdits.map(
          (item) => stringField(item, 'message') ?? 'Edit failed.',
        ),
      };
    }

    const diff = await readRepoDiff(
      {
        repoId: repo.id,
        worktreeId: worktree.id,
        base: 'HEAD',
        includePatch: false,
      },
      paths,
    );
    const postEditPolicy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        pushDestination: 'pull-request-head',
      },
      paths,
    );
    const diffSummary = objectField(diff, 'diffSummary');
    const changedFiles = numberField(diffSummary, 'files') ?? 0;
    if (!postEditPolicy.ok || postEditPolicy.blocked) {
      finalLockStatus = 'failed';
      return {
        ok: false,
        action: 'autopilot_fix_pr_review_feedback',
        changed: changedFiles > 0,
        message: postEditPolicy.message,
        data: asJsonValue({
          repo: repoSummary(repo),
          worktree,
          reviewFacts,
          plan,
          fileReads,
          editResults,
          diff,
          policy: postEditPolicy,
          concurrency,
        }),
        errors: postEditPolicy.reasons,
        requires: postEditPolicy.requires,
      };
    }

    let commit: GitCommitResult | null = null;
    if (
      hasEdits &&
      !input.dryRun &&
      (input.commit ?? true) &&
      (postEditPolicy.mode === 'autofix-with-approval' ||
        postEditPolicy.mode === 'autofix-push-when-safe') &&
      !postEditPolicy.approvalRequired &&
      changedFiles > 0
    ) {
      await dependencies.ownerMutationFence?.('before-commit');
      assertWorktreeMutationAllowed(
        {
          repoId: repo.id,
          worktreeId: worktree.id,
          lockId: acquiredLockId,
        },
        paths,
      );
      commit = await gitCommitPaths(
        worktree.localPath,
        reviewFixCommitMessage(repoFullName(repo), input.prNumber, addressed),
        plannedPaths,
      );
    }

    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);
    const shouldPrepareDiff = changedFiles > 0 || commit?.committed === true;
    finalLockStatus = shouldPrepareDiff ? 'prepared-diff' : 'ready';
    const preparedSummary = {
      workflow: 'fix_pr_review_feedback',
      repo: repoSummary(repo),
      prNumber: input.prNumber,
      plan,
      addressed,
      requestedChanges: reviewFacts.requestedChanges,
      editResults,
      commit,
      policy: postEditPolicy,
      diffSummary: objectField(diff, 'diffSummary') ?? null,
      dryRun: Boolean(input.dryRun),
    };
    let preparedDiff = null;
    if (shouldPrepareDiff && !input.dryRun) {
      await dependencies.ownerMutationFence?.('before-artifact');
      assertWorktreeMutationAllowed(
        {
          repoId: repo.id,
          worktreeId: worktree.id,
          lockId: acquiredLockId,
        },
        paths,
      );
      const preparedWorktree = {
        ...worktree,
        baseRef: worktree.headSha ?? eventState.headSha,
      };
      preparedDiff = await ensurePreparedDiffForWorktree(
        preparedWorktree,
        paths,
        {
          createdBy: 'fix_pr_review_feedback',
          title: `Review feedback fix for ${repoFullName(repo)}#${input.prNumber}`,
          resetDecisionState: true,
          summary: preparedSummary,
        },
      );
      await notifyAutopilotState(
        {
          state: 'review-fix',
          outcome: 'prepared',
          preparedDiffId: preparedDiff.id,
          worktreeId: worktree.id,
          repoFullName: repoFullName(repo),
          prNumber: input.prNumber,
          workflow: 'fix_pr_review_feedback',
          message: `Prepared review-feedback fix for ${repoFullName(repo)}#${input.prNumber}.`,
          recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
          data: { addressed, plan },
        },
        paths,
      );
    }

    return {
      ok: true,
      action: 'autopilot_fix_pr_review_feedback',
      changed: shouldPrepareDiff,
      message: shouldPrepareDiff
        ? `Prepared review-feedback fix for ${repoFullName(repo)}#${input.prNumber}.`
        : `Planned review-feedback fix for ${repoFullName(repo)}#${input.prNumber}; no edits were applied.`,
      data: asJsonValue({
        repo: repoSummary(repo),
        worktree,
        reviewFacts,
        plan,
        fileReads,
        editResults,
        diff,
        policy: postEditPolicy,
        concurrency,
        status,
        commit,
        preparedDiff,
      }),
      ...(postEditPolicy.approvalRequired ? { requires: ['approval'] } : {}),
    };
  } catch (error) {
    finalLockStatus = 'failed';
    if (worktree) {
      const preparedDiff = readPreparedDiffByWorktree(worktree.id, paths);
      if (preparedDiff) {
        await notifyAutopilotState(
          {
            state: 'failed-workflow',
            outcome: 'failed',
            preparedDiffId: preparedDiff.id,
            worktreeId: worktree.id,
            repoFullName: worktree.repoFullName,
            prNumber: worktree.prNumber,
            workflow: 'fix_pr_review_feedback',
            message: `fix_pr_review_feedback failed: ${errorMessage(error)}`,
            recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
            data: { error: errorMessage(error) },
          },
          paths,
        ).catch(() => undefined);
      }
    }
    return failResult(
      'autopilot_fix_pr_review_feedback',
      'Could not fix PR review feedback.',
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
