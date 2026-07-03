/* eslint-disable no-unused-vars */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { type GitHubCheckSummary, type GitHubFailingCheckFact, type GitHubPullRequestDetail, type GitHubPullRequestEventState, fetchPullRequestEventState, fetchCheckSummary, fetchFailingCheckFacts, fetchPullRequestDetail } from '../../github';
import { checkAutopilotConcurrency, checkAutopilotPolicy, pathDeniedByAutopilotPolicy, repoAutopilotPolicy, withAutopilotLocalExecutionSlot } from '../../autopilot-policy';
import { addWorkflowSummary, updateWorkflowSummary } from '../../app-state';
import { notifyAutopilotState, recoveryActionsForPreparedDiff } from '../../autopilot-notifications';
import { buildPreparedDiffAuditSummary } from '../../autonomous-audit';
import { runApprovedExecution } from '../../execution-actions';
import { getGitHubPrBranchPermissions, postGitHubPrComment } from '../../pr-event-state';
import { ensurePreparedDiffForWorktree, markPreparedDiffPushBlocked, markPreparedDiffPushed, readPreparedDiff, readPreparedDiffByWorktree, readPreparedDiffRecord, recordPreparedDiffVerification, type PreparedDiffRecord } from '../../prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../../repos';
import { gitCurrentSha, gitCommitAll, gitCommitPaths, gitPushHead, gitStatus, type GitCommitResult } from '../../repo-edit/git';
import { patchRepoFiles, readRepoDiff, readRepoFile, replaceRepoFile } from '../../repo-edit';
import { parseV4APatch } from '../../repo-edit/patch-parser';
import { repoRelativePathSchema } from '../../repo-edit/schemas';
import { type RuntimePaths, parseAppConfig, ensureRuntimeHome, readRuntimeJson, runtimePaths } from '../../runtime-home';
import { createWorktree, listWorktrees, lockWorktree, recordWorktreePushBlocked, recordWorktreePushSucceeded, readManagedWorktree, readWorktreeStatus, releaseWorktreeLock, syncWorktree, type WorktreeRecord } from '../../worktrees';

export type AutopilotTriageClass =
  | 'no-op'
  | 'notify-only'
  | 'explain-only'
  | 'draft-fix'
  | 'auto-fix-no-push'
  | 'auto-fix-push-after-checks';

export type AutopilotActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  data?: JsonValue;
  workflowSummary?: JsonValue;
  error?: JsonValue;
  requires?: string[];
  errors?: string[];
};

export type AutopilotDependencies = {
  fetchPullRequestDetail?: typeof fetchPullRequestDetail;
  fetchCheckSummary?: typeof fetchCheckSummary;
  fetchFailingCheckFacts?: typeof fetchFailingCheckFacts;
  fetchPullRequestEventState?: typeof fetchPullRequestEventState;
  getBranchPermissions?: typeof getGitHubPrBranchPermissions;
  runExecution?: typeof runApprovedExecution;
  postPullRequestComment?: NonNullable<
    Parameters<typeof postGitHubPrComment>[2]
  >['postPullRequestComment'];
  pushGit?: typeof gitPushHead;
  token?: string;
};

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
export const autopilotModeSchema = v.picklist([
  'notify-only',
  'draft-fix',
  'auto-fix-no-push',
  'auto-fix-push-after-checks',
]);
export const prEventDeltaSchema = v.object({
  type: v.picklist([
    'new-commit',
    'review-comment',
    'requested-changes',
    'review-thread-resolved',
    'check-failure',
    'check-recovery',
    'merge-conflict',
    'branch-out-of-date',
    'metadata',
    'unknown',
  ]),
  id: v.optional(nonEmptyStringSchema),
  summary: v.optional(nonEmptyStringSchema),
  actionable: v.optional(v.boolean()),
  requiresExplanation: v.optional(v.boolean()),
  severity: v.optional(v.picklist(['low', 'medium', 'high', 'urgent'])),
});
export const prEventSnapshotSchema = v.object({
  state: v.optional(nonEmptyStringSchema),
  draft: v.optional(v.boolean()),
  merged: v.optional(v.boolean()),
  mergeable: v.optional(v.boolean()),
  outOfDate: v.optional(v.boolean()),
  headSha: v.optional(nonEmptyStringSchema),
  baseRef: v.optional(nonEmptyStringSchema),
  checkStatus: v.optional(
    v.picklist(['success', 'failure', 'pending', 'none']),
  ),
});
export const triagePrEventInputSchema = v.object({
  repoId: v.optional(nonEmptyStringSchema),
  repoFullName: v.optional(nonEmptyStringSchema),
  prNumber: positiveIntegerSchema,
  watchId: v.optional(nonEmptyStringSchema),
  eventId: v.optional(nonEmptyStringSchema),
  source: v.optional(v.picklist(['watch', 'api', 'fixture'])),
  autopilotMode: v.optional(autopilotModeSchema),
  previous: v.optional(prEventSnapshotSchema),
  current: v.optional(prEventSnapshotSchema),
  deltas: v.optional(v.array(prEventDeltaSchema)),
});

export const prFactsSchema = v.object({
  number: positiveIntegerSchema,
  title: nonEmptyStringSchema,
  repo: nonEmptyStringSchema,
  url: nonEmptyStringSchema,
  state: nonEmptyStringSchema,
  draft: v.optional(v.boolean()),
  merged: v.optional(v.boolean()),
  mergeCommitSha: v.optional(v.nullable(nonEmptyStringSchema)),
  headSha: nonEmptyStringSchema,
  headRef: v.optional(nonEmptyStringSchema),
  headOwner: v.optional(nonEmptyStringSchema),
  headName: v.optional(nonEmptyStringSchema),
  baseRef: nonEmptyStringSchema,
  updatedAt: nonEmptyStringSchema,
  maintainerCanModify: v.optional(v.boolean()),
});
export const checkSummarySchema = v.object({
  status: v.picklist(['success', 'failure', 'pending', 'none']),
  total: v.number(),
  successful: v.number(),
  failed: v.number(),
  pending: v.number(),
  statusContexts: v.optional(v.number()),
  checkedAt: nonEmptyStringSchema,
});
export const nullableStringSchema = v.nullable(v.string());
export const reviewCommentSchema = v.object({
  id: nonEmptyStringSchema,
  databaseId: v.nullable(v.number()),
  authorLogin: nullableStringSchema,
  body: v.string(),
  url: nullableStringSchema,
  path: nullableStringSchema,
  line: v.nullable(v.number()),
  originalLine: v.nullable(v.number()),
  diffHunk: nullableStringSchema,
  reviewId: v.nullable(v.number()),
  createdAt: nonEmptyStringSchema,
  updatedAt: nonEmptyStringSchema,
});
export const reviewThreadSchema = v.object({
  id: nonEmptyStringSchema,
  isResolved: v.boolean(),
  isOutdated: v.boolean(),
  path: nullableStringSchema,
  line: v.nullable(v.number()),
  comments: v.array(reviewCommentSchema),
});
export const reviewSchema = v.object({
  id: v.number(),
  nodeId: nullableStringSchema,
  state: nonEmptyStringSchema,
  authorLogin: nullableStringSchema,
  submittedAt: nullableStringSchema,
  commitId: nullableStringSchema,
  url: nullableStringSchema,
});
export const requestedChangesStateSchema = v.object({
  active: v.array(reviewSchema),
  latestByReviewer: v.array(reviewSchema),
  history: v.array(reviewSchema),
});
export const prCommitSchema = v.object({
  sha: nonEmptyStringSchema,
  url: nonEmptyStringSchema,
  authorLogin: nullableStringSchema,
  committedAt: nullableStringSchema,
});
export const checkSuiteSchema = v.looseObject({
  id: v.number(),
  headSha: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  conclusion: nullableStringSchema,
});
export const checkRunSchema = v.looseObject({
  id: v.number(),
  name: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  conclusion: nullableStringSchema,
});
export const branchPermissionsSchema = v.object({
  headRepoFullName: nullableStringSchema,
  baseRepoFullName: nullableStringSchema,
  isFork: v.boolean(),
  maintainerCanModify: v.boolean(),
  headRepoPush: v.nullable(v.boolean()),
  baseRepoPush: v.nullable(v.boolean()),
  canLikelyPush: v.nullable(v.boolean()),
  checkedAt: nonEmptyStringSchema,
});
export const failingCheckFixtureSchema = v.looseObject({
  id: v.number(),
  name: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  conclusion: nullableStringSchema,
  url: nullableStringSchema,
  htmlUrl: nullableStringSchema,
  detailsUrl: nullableStringSchema,
  startedAt: nullableStringSchema,
  completedAt: nullableStringSchema,
  outputTitle: nullableStringSchema,
  outputSummary: nullableStringSchema,
  outputText: nullableStringSchema,
  annotations: v.array(
    v.looseObject({
      path: nonEmptyStringSchema,
      startLine: v.nullable(v.number()),
      endLine: v.nullable(v.number()),
      annotationLevel: nonEmptyStringSchema,
      message: nonEmptyStringSchema,
      title: nullableStringSchema,
      rawDetails: nullableStringSchema,
    }),
  ),
  log: v.object({
    available: v.boolean(),
    source: v.nullable(v.picklist(['github-actions-job'])),
    text: nullableStringSchema,
    truncated: v.boolean(),
    unavailableReason: nullableStringSchema,
  }),
});
export const executionFixtureSchema = v.object({
  ok: v.optional(v.boolean()),
  message: v.optional(nonEmptyStringSchema),
  exitCode: v.optional(v.number()),
  requires: v.optional(v.array(nonEmptyStringSchema)),
});
export const prCommentFixtureSchema = v.object({
  id: v.number(),
  nodeId: nullableStringSchema,
  url: nonEmptyStringSchema,
  authorLogin: nullableStringSchema,
  body: v.string(),
  createdAt: nonEmptyStringSchema,
  updatedAt: nonEmptyStringSchema,
});
export const prReviewEventStateSchema = v.object({
  repo: nonEmptyStringSchema,
  number: positiveIntegerSchema,
  url: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  state: nonEmptyStringSchema,
  draft: v.boolean(),
  merged: v.boolean(),
  mergeCommitSha: nullableStringSchema,
  headSha: nonEmptyStringSchema,
  headRef: nullableStringSchema,
  baseRef: nonEmptyStringSchema,
  baseSha: nullableStringSchema,
  mergeable: v.nullable(v.boolean()),
  mergeableState: nullableStringSchema,
  maintainerCanModify: v.boolean(),
  commits: v.array(prCommitSchema),
  reviewThreads: v.array(reviewThreadSchema),
  requestedChangesReviews: v.array(reviewSchema),
  requestedChangesState: requestedChangesStateSchema,
  checkSuites: v.array(checkSuiteSchema),
  checkRuns: v.array(checkRunSchema),
  branchPermissions: branchPermissionsSchema,
  isOutOfDate: v.boolean(),
  fetchedAt: nonEmptyStringSchema,
});
export const autopilotFixtureSchema = v.object({
  token: v.optional(nonEmptyStringSchema),
  pullRequests: v.optional(v.array(prFactsSchema)),
  checkSummaries: v.optional(
    v.array(
      v.object({
        repo: nonEmptyStringSchema,
        ref: nonEmptyStringSchema,
        summary: checkSummarySchema,
      }),
    ),
  ),
  failingChecks: v.optional(
    v.array(
      v.object({
        repo: nonEmptyStringSchema,
        ref: nonEmptyStringSchema,
        checks: v.array(failingCheckFixtureSchema),
      }),
    ),
  ),
  eventStates: v.optional(v.array(prReviewEventStateSchema)),
  branchPermissions: v.optional(
    v.array(
      v.object({
        repo: nonEmptyStringSchema,
        prNumber: positiveIntegerSchema,
        branchPermissions: branchPermissionsSchema,
      }),
    ),
  ),
  execution: v.optional(
    v.object({
      default: v.optional(executionFixtureSchema),
      commands: v.optional(v.record(v.string(), executionFixtureSchema)),
    }),
  ),
  pushRemotes: v.optional(
    v.array(
      v.object({
        repo: nonEmptyStringSchema,
        remote: nonEmptyStringSchema,
      }),
    ),
  ),
  comments: v.optional(v.array(prCommentFixtureSchema)),
});
export const preparePrWorktreeInputSchema = v.strictObject({
  repoId: nonEmptyStringSchema,
  prNumber: positiveIntegerSchema,
  eventId: v.optional(nonEmptyStringSchema),
  createWorktree: v.optional(v.boolean()),
  sync: v.optional(v.boolean()),
  fetch: v.optional(v.boolean()),
  lock: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
});
export const verifyPrWorktreeInputSchema = v.strictObject({
  worktreeId: nonEmptyStringSchema,
  checks: v.optional(v.array(nonEmptyStringSchema)),
  diffBaseRef: v.optional(nonEmptyStringSchema),
  backend: v.optional(v.picklist(['local', 'exe.dev'])),
  context: v.optional(v.picklist(['interactive', 'unattended'])),
  lock: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const pushPrAutofixInputSchema = v.strictObject({
  preparedDiffId: nonEmptyStringSchema,
  force: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
});
export const fixPrCiFailureInputSchema = v.strictObject({
  worktreeId: nonEmptyStringSchema,
  checks: v.optional(v.array(nonEmptyStringSchema)),
  diagnostics: v.optional(v.array(nonEmptyStringSchema)),
  patch: v.optional(
    v.pipe(v.string(), v.minLength(1), v.maxLength(256 * 1024)),
  ),
  patchReason: v.optional(nonEmptyStringSchema),
  confidence: v.optional(v.picklist(['low', 'medium', 'high'])),
  risk: v.optional(v.picklist(['low', 'medium', 'high'])),
  manualAsks: v.optional(v.array(nonEmptyStringSchema)),
  commitMessage: v.optional(nonEmptyStringSchema),
  backend: v.optional(v.picklist(['local', 'exe.dev'])),
  context: v.optional(v.picklist(['interactive', 'unattended'])),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxLogBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256 * 1024)),
  ),
});
export const reviewFixReplacementSchema = v.strictObject({
  path: repoRelativePathSchema,
  oldString: nonEmptyStringSchema,
  newString: v.string(),
  replaceAll: v.optional(v.boolean()),
  fuzzy: v.optional(v.picklist(['off', 'safe'])),
});
export const fixPrReviewFeedbackInputSchema = v.strictObject({
  repoId: nonEmptyStringSchema,
  prNumber: positiveIntegerSchema,
  worktreeId: v.optional(nonEmptyStringSchema),
  addressedReviewCommentIds: v.optional(v.array(nonEmptyStringSchema)),
  addressedReviewThreadIds: v.optional(v.array(nonEmptyStringSchema)),
  replacements: v.optional(v.array(reviewFixReplacementSchema)),
  patch: v.optional(v.pipe(v.string(), v.minLength(1))),
  createWorktree: v.optional(v.boolean()),
  sync: v.optional(v.boolean()),
  fetch: v.optional(v.boolean()),
  lock: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
  commit: v.optional(v.boolean()),
  dryRun: v.optional(v.boolean()),
  maxReadLinesPerFile: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_000)),
  ),
});
export const commentPrAutofixResultInputSchema = v.strictObject({
  preparedDiffId: nonEmptyStringSchema,
});
export const autopilotOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
