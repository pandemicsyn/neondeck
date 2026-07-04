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
} from '../../github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  pathDeniedByAutopilotPolicy,
  repoAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from '../../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../../app-state';
import {
  notifyAutopilotState,
  recoveryActionsForPreparedDiff,
} from '../../autopilot-notifications';
import { buildPreparedDiffAuditSummary } from '../../autonomous-audit';
import { runApprovedExecution } from '../../execution-actions';
import {
  getGitHubPrBranchPermissions,
  postGitHubPrComment,
} from '../../pr-event-state';
import {
  ensurePreparedDiffForWorktree,
  markPreparedDiffPushBlocked,
  markPreparedDiffPushed,
  readPreparedDiff,
  readPreparedDiffByWorktree,
  readPreparedDiffRecord,
  recordPreparedDiffVerification,
  type PreparedDiffRecord,
} from '../../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
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
} from '../../worktrees';
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
import { unique } from './utils';

export function repoSummary(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
) {
  return {
    id: repo.id,
    fullName: repoFullName(repo),
    path: repo.path,
    defaultBranch: repo.defaultBranch,
  };
}

export function prFactsFromDetail(
  detail: GitHubPullRequestDetail,
): v.InferOutput<typeof prFactsSchema> {
  const [owner, name] = detail.repo.split('/');
  return {
    number: detail.number,
    title: detail.title,
    repo: detail.repo,
    url: detail.url,
    state: detail.state,
    draft: detail.draft,
    merged: detail.merged,
    mergeCommitSha: detail.mergeCommitSha,
    headSha: detail.headSha,
    headRef: detail.headRef ?? detail.headSha,
    headOwner: detail.headOwner ?? owner,
    headName: detail.headName ?? name,
    baseRef: detail.baseRef,
    updatedAt: detail.updatedAt,
    maintainerCanModify: detail.maintainerCanModify ?? false,
  };
}

export function classifySignals(
  current: v.InferOutput<typeof prEventSnapshotSchema> | undefined,
  deltas: Array<v.InferOutput<typeof prEventDeltaSchema>>,
) {
  return {
    noChange: deltas.length === 0,
    closed: current?.state === 'closed' || current?.merged === true,
    draft: current?.draft === true,
    failingChecks:
      current?.checkStatus === 'failure' ||
      deltas.some((delta) => delta.type === 'check-failure'),
    requestedChanges: deltas.some(
      (delta) => delta.type === 'requested-changes',
    ),
    reviewFeedback: deltas.some((delta) => delta.type === 'review-comment'),
    mergeBlocked:
      current?.mergeable === false ||
      current?.outOfDate === true ||
      deltas.some(
        (delta) =>
          delta.type === 'merge-conflict' ||
          delta.type === 'branch-out-of-date',
      ),
    recoveryOnly:
      deltas.length > 0 &&
      deltas.every(
        (delta) =>
          delta.type === 'check-recovery' ||
          delta.type === 'review-thread-resolved' ||
          delta.type === 'metadata',
      ),
    explanatory: deltas.some(
      (delta) => delta.requiresExplanation || delta.type === 'new-commit',
    ),
    actionable: deltas.some((delta) => delta.actionable === true),
  };
}

export function classificationFor(
  mode: v.InferOutput<typeof autopilotModeSchema>,
  signals: ReturnType<typeof classifySignals>,
): AutopilotTriageClass {
  if (signals.noChange) return 'no-op';
  if (signals.closed || signals.recoveryOnly || signals.draft) {
    return 'notify-only';
  }
  if (signals.mergeBlocked) return 'explain-only';
  if (
    signals.failingChecks ||
    signals.requestedChanges ||
    signals.reviewFeedback ||
    signals.actionable
  ) {
    return mode;
  }
  if (signals.explanatory) return 'explain-only';
  return 'notify-only';
}

export function reasonsFor(
  classification: AutopilotTriageClass,
  mode: v.InferOutput<typeof autopilotModeSchema>,
  signals: ReturnType<typeof classifySignals>,
  deltas: Array<v.InferOutput<typeof prEventDeltaSchema>>,
) {
  const reasons: string[] = [];
  if (classification === 'no-op') {
    reasons.push('No structured PR deltas were supplied.');
  }
  if (signals.closed) reasons.push('PR is closed or merged.');
  if (signals.draft) reasons.push('Draft PRs are not prepared for autofix.');
  if (signals.recoveryOnly) {
    reasons.push('Only recovery or metadata deltas were present.');
  }
  if (signals.mergeBlocked) {
    reasons.push('Merge conflict or out-of-date branch needs explanation.');
  }
  if (signals.failingChecks) reasons.push('Failing checks are actionable.');
  if (signals.requestedChanges)
    reasons.push('Requested changes are actionable.');
  if (signals.reviewFeedback) reasons.push('Review feedback is actionable.');
  if (signals.actionable)
    reasons.push('At least one delta is marked actionable.');
  if (
    classification === 'draft-fix' ||
    classification === 'auto-fix-no-push' ||
    classification === 'auto-fix-push-after-checks'
  ) {
    reasons.push(`Autopilot mode allows ${mode}.`);
  }
  if (reasons.length === 0 && deltas.length > 0) {
    reasons.push(
      'Delta should be surfaced but does not justify worktree prep.',
    );
  }
  return reasons;
}
