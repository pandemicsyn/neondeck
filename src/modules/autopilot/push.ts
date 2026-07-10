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
  repoAutopilotPolicy,
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
  listApprovalRecords,
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
  groupReviewFeedback,
  plannedEditPaths,
  readReviewTargetFiles,
  reviewFactsFromEventState,
  reviewFixCommitMessage,
  reviewTargetPathSet,
  worktreeStatusDirty,
} from './review-support';

export async function pushPrAutofix(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    pushPrAutofixInputSchema,
    rawInput,
    'autopilot_push_pr_autofix',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  dependencies = await dependenciesWithAutopilotFixture(dependencies);
  const lockOwner = input.lockOwner ?? 'push_pr_autofix';
  let acquiredLockId: string | undefined;
  let finalLockStatus: 'prepared-diff' | 'succeeded' = 'prepared-diff';
  let pushedSideEffect:
    { commitSha: string; remote: string; branch: string } | undefined;

  try {
    await ensureRuntimeHome(paths);
    const preparedDiff = readPreparedDiff(input.preparedDiffId, paths);
    if (!preparedDiff) {
      return failResult(
        'autopilot_push_pr_autofix',
        `Prepared diff "${input.preparedDiffId}" was not found.`,
        { requires: ['preparedDiffId'] },
      );
    }
    const worktree = await readManagedWorktree(
      preparedDiff.worktreeId,
      preparedDiff.repoId,
      paths,
    );
    const readinessGates = pushReadinessGates(preparedDiff);
    const failedReadinessGates = readinessGates.filter((gate) => !gate.ok);
    if (failedReadinessGates.length > 0) {
      return pushNotReadyResult(
        preparedDiff,
        worktree.id,
        readinessGates,
        recoveryOptionsForPushBlock(failedReadinessGates),
      );
    }
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find(
      (candidate) => candidate.id === preparedDiff.repoId,
    );
    if (!repo) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Repository is not configured.',
        {
          gates: [
            {
              gate: 'repo',
              ok: false,
              reason: `Repository "${preparedDiff.repoId}" is not configured.`,
            },
          ],
          paths,
        },
      );
    }
    if (!preparedDiff.prNumber) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Prepared diff is not linked to a PR.',
        {
          gates: [
            {
              gate: 'pull-request',
              ok: false,
              reason: 'Prepared diff has no PR number.',
            },
          ],
          paths,
        },
      );
    }

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: preparedDiff.prNumber,
        workflow: 'push_pr_autofix',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        concurrency.message,
        {
          gates: [
            {
              gate: 'concurrency',
              ok: false,
              reason: concurrency.message,
            },
          ],
          paths,
          recoveryOptions: [
            'Wait for the active autopilot workflow to finish, then retry push_pr_autofix.',
          ],
        },
      );
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
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        stringField(locked, 'message') ??
          'Worktree lock could not be acquired.',
        {
          gates: [
            {
              gate: 'worktree-lock',
              ok: false,
              reason:
                stringField(locked, 'message') ??
                'Worktree lock could not be acquired.',
            },
          ],
          paths,
          recoveryOptions: [
            'Wait for the active worktree lock to release, then retry push_pr_autofix.',
          ],
        },
      );
    }
    acquiredLockId = stringField(objectField(locked, 'lock'), 'id');

    const policy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        diffBaseRef: preparedDiff.headSha ?? preparedDiff.baseRef,
        pushDestination: 'pull-request-head',
        forcePush: input.force,
      },
      paths,
    );
    const permissions = await (
      dependencies.getBranchPermissions ?? getGitHubPrBranchPermissions
    )(
      {
        repo: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
      },
      paths,
    );
    const status = await gitStatus(worktree.localPath);
    const currentSha = await gitCurrentSha(worktree.localPath);
    const branchPermissions = objectField(
      objectField(permissions, 'data'),
      'branchPermissions',
    );
    const canLikelyPush =
      booleanField(branchPermissions, 'canLikelyPush') === true;
    const approvedCommitSha = preparedDiffCommitSha(
      preparedDiff.summary,
      'pushApproval',
      'approvedCommitSha',
    );
    const verifiedCommitSha = preparedDiffCommitSha(
      preparedDiff.summary,
      'verification',
      'verifiedCommitSha',
    );
    const modeAllowsPush =
      policy.mode === 'autofix-with-approval' ||
      policy.mode === 'autofix-push-when-safe';
    const hasCommittedDiff = policy.diff.filesChanged > 0;
    const matchingPushApproval = listApprovalRecords(
      { status: 'approved', preparedDiffIds: [preparedDiff.id] },
      paths,
    ).find(
      (approval) =>
        approval.approvalType === 'push' &&
        approval.targetSha === currentSha &&
        approval.policyHash === policy.policyHash &&
        approval.policyDecision !== 'deny',
    );
    const gates = [
      {
        gate: 'autopilot-mode',
        ok: modeAllowsPush,
        reason: modeAllowsPush
          ? `Repo policy mode is ${policy.mode}.`
          : `Repo policy mode is ${policy.mode}, not a push-capable mode.`,
      },
      {
        gate: 'autopilot-policy',
        ok: Boolean(policy.decision !== 'deny' && matchingPushApproval),
        reason:
          policy.decision === 'deny'
            ? policy.message
            : matchingPushApproval
              ? 'A matching SHA-bound approval satisfies this policy requirement.'
              : policy.message,
      },
      {
        gate: 'prepared-diff-approval',
        ok: preparedDiff.pushApprovalStatus === 'approved',
        reason:
          preparedDiff.pushApprovalStatus === 'approved'
            ? 'Prepared diff push approval is approved.'
            : `Prepared diff push approval is ${preparedDiff.pushApprovalStatus}.`,
      },
      {
        gate: 'sha-bound-policy-approval',
        ok: Boolean(matchingPushApproval),
        reason: matchingPushApproval
          ? 'A matching SHA-bound approval satisfies this policy requirement.'
          : 'No approved push approval matches the current SHA and policy.',
      },
      {
        gate: 'prepared-diff-status',
        ok: ['push-approved', 'push-blocked'].includes(preparedDiff.status),
        reason: ['push-approved', 'push-blocked'].includes(preparedDiff.status)
          ? `Prepared diff status is ${preparedDiff.status}.`
          : `Prepared diff status is ${preparedDiff.status}, not ready to push.`,
      },
      {
        gate: 'verification',
        ok: preparedDiff.verificationStatus === 'passed',
        reason:
          preparedDiff.verificationStatus === 'passed'
            ? 'Prepared diff verification passed.'
            : `Prepared diff verification is ${preparedDiff.verificationStatus}.`,
      },
      {
        gate: 'approved-commit',
        ok: approvedCommitSha === currentSha,
        reason:
          approvedCommitSha === currentSha
            ? 'Prepared diff push approval matches current HEAD.'
            : approvedCommitSha
              ? 'Current HEAD differs from the approved prepared-diff commit.'
              : 'Prepared diff approval does not record an approved commit SHA.',
      },
      {
        gate: 'verified-commit',
        ok: verifiedCommitSha === currentSha,
        reason:
          verifiedCommitSha === currentSha
            ? 'Prepared diff verification matches current HEAD.'
            : verifiedCommitSha
              ? 'Current HEAD differs from the verified prepared-diff commit.'
              : 'Prepared diff verification does not record a verified commit SHA.',
      },
      {
        gate: 'github-permissions',
        ok: canLikelyPush,
        reason: canLikelyPush
          ? 'GitHub branch permission facts allow likely push-back.'
          : permissions.ok
            ? 'GitHub branch permission facts do not allow direct push-back.'
            : permissions.message,
      },
      {
        gate: 'clean-worktree',
        ok: status.clean,
        reason: status.clean
          ? 'Worktree has no uncommitted changes.'
          : `Worktree has ${status.files.length} uncommitted change(s).`,
      },
      {
        gate: 'committed-diff',
        ok: hasCommittedDiff,
        reason: hasCommittedDiff
          ? `Prepared diff contains ${policy.diff.filesChanged} committed file change(s).`
          : 'No committed diff remains to push.',
      },
      {
        gate: 'force-push',
        ok: input.force !== true,
        reason:
          input.force === true
            ? 'push_pr_autofix does not perform force-pushes in this slice.'
            : 'Force-push is not requested.',
      },
    ];
    const failedGates = gates.filter((gate) => !gate.ok);
    if (failedGates.length > 0) {
      return blockPushAttempt(
        preparedDiff.id,
        worktree.id,
        'Prepared diff is blocked from push-back.',
        {
          gates,
          paths,
          recoveryOptions: recoveryOptionsForPushBlock(failedGates),
          data: { policy, permissions, status, currentSha, concurrency },
        },
      );
    }

    const remote = remoteForPush(worktree, branchPermissions);
    const branch = worktree.headRef || preparedDiff.headRef;
    const push = await (dependencies.pushGit ?? gitPushHead)(
      worktree.localPath,
      {
        remote,
        branch,
        force: false,
      },
    );
    pushedSideEffect = {
      commitSha: currentSha,
      remote: push.remote,
      branch: push.branch,
    };
    finalLockStatus = 'succeeded';
    const updatedPreparedDiff = markPreparedDiffPushed(
      preparedDiff.id,
      {
        commitSha: currentSha,
        remote: push.remote,
        branch: push.branch,
      },
      paths,
    );
    const updatedWorktree = await recordWorktreePushSucceeded(
      worktree.id,
      {
        commitSha: currentSha,
        message: `Pushed prepared diff ${preparedDiff.id} to ${push.branch}.`,
        data: { preparedDiffId: preparedDiff.id, remote: push.remote },
      },
      paths,
    );
    if (updatedPreparedDiff) {
      await notifyAutopilotState(
        {
          state: 'pushed',
          outcome: 'pushed',
          preparedDiffId: updatedPreparedDiff.id,
          worktreeId: worktree.id,
          repoFullName: preparedDiff.repoFullName,
          prNumber: preparedDiff.prNumber,
          workflow: 'push_pr_autofix',
          message: `Pushed ${preparedDiff.repoFullName}#${preparedDiff.prNumber} autofix commit ${currentSha.slice(0, 12)}.`,
          recoveryActions: recoveryActionsForPreparedDiff(updatedPreparedDiff),
          data: {
            commitSha: currentSha,
            remote: push.remote,
            branch: push.branch,
          },
        },
        paths,
      );
    }

    return {
      ok: true,
      action: 'autopilot_push_pr_autofix',
      changed: true,
      message: `Pushed autofix commit ${currentSha.slice(0, 12)} to ${preparedDiff.repoFullName}#${preparedDiff.prNumber}.`,
      data: asJsonValue({
        preparedDiff: updatedPreparedDiff,
        worktree: updatedWorktree,
        push,
        gates,
        policy,
        permissions,
        status,
        currentSha,
        nextWorkflow: 'comment_pr_autofix_result',
        commentsDeferred: true,
      }),
    };
  } catch (error) {
    if (pushedSideEffect) {
      const parsedInput = v.safeParse(pushPrAutofixInputSchema, rawInput);
      const preparedDiff = parsedInput.success
        ? readPreparedDiff(parsedInput.output.preparedDiffId, paths)
        : null;
      if (preparedDiff) {
        await notifyAutopilotState(
          {
            state: 'failed-workflow',
            outcome: 'failed',
            preparedDiffId: preparedDiff.id,
            worktreeId: preparedDiff.worktreeId,
            repoFullName: preparedDiff.repoFullName,
            prNumber: preparedDiff.prNumber,
            workflow: 'push_pr_autofix',
            message:
              'Git push completed, but Neondeck could not finish recording push state.',
            recoveryOptions: [
              'Inspect GitHub and the retained worktree before retrying.',
              'If the commit reached the PR branch, reconcile the prepared-diff state instead of pushing again.',
            ],
            recoveryActions: recoveryActionsForPreparedDiff(preparedDiff),
            data: { push: pushedSideEffect, error: errorMessage(error) },
          },
          paths,
        ).catch(() => undefined);
      }
      return {
        ok: false,
        action: 'autopilot_push_pr_autofix',
        changed: true,
        message:
          'Git push completed, but Neondeck could not finish recording push state. Inspect the retained worktree before retrying.',
        data: asJsonValue({
          push: pushedSideEffect,
          error: errorMessage(error),
          recoveryOptions: [
            'Inspect GitHub and the retained worktree before retrying.',
            'If the commit reached the PR branch, reconcile the prepared-diff state instead of pushing again.',
          ],
        }),
        requires: ['state-reconciliation'],
        errors: [errorMessage(error)],
      };
    }
    const parsedInput = v.safeParse(pushPrAutofixInputSchema, rawInput);
    if (parsedInput.success) {
      const preparedDiff = readPreparedDiff(
        parsedInput.output.preparedDiffId,
        paths,
      );
      if (preparedDiff) {
        return blockPushAttempt(
          preparedDiff.id,
          preparedDiff.worktreeId,
          `Could not push prepared diff: ${errorMessage(error)}`,
          {
            gates: [
              {
                gate: 'git-push',
                ok: false,
                reason: errorMessage(error),
              },
            ],
            paths,
            recoveryOptions: [
              'Inspect the retained worktree and retry after fixing git credentials or branch state.',
              'Push manually from the retained worktree if policy allows.',
            ],
          },
        );
      }
    }
    return failResult(
      'autopilot_push_pr_autofix',
      'Could not push PR autofix.',
      {
        errors: [errorMessage(error)],
      },
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
