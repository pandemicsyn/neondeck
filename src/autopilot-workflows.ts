import { defineAction, type JsonValue } from '@flue/runtime';
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
} from './github';
import {
  checkAutopilotConcurrency,
  checkAutopilotPolicy,
  pathDeniedByAutopilotPolicy,
  repoAutopilotPolicy,
  withAutopilotLocalExecutionSlot,
} from './autopilot-policy';
import {
  addNotification,
  addWorkflowSummary,
  updateWorkflowSummary,
} from './app-state';
import { buildPreparedDiffAuditSummary } from './autonomous-audit';
import { runApprovedExecution } from './execution-actions';
import {
  getGitHubPrBranchPermissions,
  postGitHubPrComment,
} from './pr-event-state';
import {
  ensurePreparedDiffForWorktree,
  markPreparedDiffPushBlocked,
  markPreparedDiffPushed,
  readPreparedDiff,
  readPreparedDiffRecord,
  recordPreparedDiffVerification,
} from './prepared-diffs';
import { readRepoRegistrySnapshot, repoFullName } from './repos';
import {
  gitCurrentSha,
  gitCommitAll,
  gitCommitPaths,
  gitPushHead,
  gitStatus,
  type GitCommitResult,
} from './repo-edit/git';
import {
  patchRepoFiles,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
} from './repo-edit';
import { parseV4APatch } from './repo-edit/patch-parser';
import { repoRelativePathSchema } from './repo-edit/schemas';
import {
  type RuntimePaths,
  parseAppConfig,
  ensureRuntimeHome,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
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
} from './worktrees';

export type AutopilotTriageClass =
  | 'no-op'
  | 'notify-only'
  | 'explain-only'
  | 'draft-fix'
  | 'auto-fix-no-push'
  | 'auto-fix-push-after-checks';

type AutopilotActionResult = {
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

type AutopilotDependencies = {
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

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const autopilotModeSchema = v.picklist([
  'notify-only',
  'draft-fix',
  'auto-fix-no-push',
  'auto-fix-push-after-checks',
]);
const prEventDeltaSchema = v.object({
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
const prEventSnapshotSchema = v.object({
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
const triagePrEventInputSchema = v.object({
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

const prFactsSchema = v.object({
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
const checkSummarySchema = v.object({
  status: v.picklist(['success', 'failure', 'pending', 'none']),
  total: v.number(),
  successful: v.number(),
  failed: v.number(),
  pending: v.number(),
  statusContexts: v.optional(v.number()),
  checkedAt: nonEmptyStringSchema,
});
const nullableStringSchema = v.nullable(v.string());
const reviewCommentSchema = v.object({
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
const reviewThreadSchema = v.object({
  id: nonEmptyStringSchema,
  isResolved: v.boolean(),
  isOutdated: v.boolean(),
  path: nullableStringSchema,
  line: v.nullable(v.number()),
  comments: v.array(reviewCommentSchema),
});
const reviewSchema = v.object({
  id: v.number(),
  nodeId: nullableStringSchema,
  state: nonEmptyStringSchema,
  authorLogin: nullableStringSchema,
  submittedAt: nullableStringSchema,
  commitId: nullableStringSchema,
  url: nullableStringSchema,
});
const requestedChangesStateSchema = v.object({
  active: v.array(reviewSchema),
  latestByReviewer: v.array(reviewSchema),
  history: v.array(reviewSchema),
});
const prCommitSchema = v.object({
  sha: nonEmptyStringSchema,
  url: nonEmptyStringSchema,
  authorLogin: nullableStringSchema,
  committedAt: nullableStringSchema,
});
const checkSuiteSchema = v.looseObject({
  id: v.number(),
  headSha: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  conclusion: nullableStringSchema,
});
const checkRunSchema = v.looseObject({
  id: v.number(),
  name: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  conclusion: nullableStringSchema,
});
const branchPermissionsSchema = v.object({
  headRepoFullName: nullableStringSchema,
  baseRepoFullName: nullableStringSchema,
  isFork: v.boolean(),
  maintainerCanModify: v.boolean(),
  headRepoPush: v.nullable(v.boolean()),
  baseRepoPush: v.nullable(v.boolean()),
  canLikelyPush: v.nullable(v.boolean()),
  checkedAt: nonEmptyStringSchema,
});
const prReviewEventStateSchema = v.object({
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
const preparePrWorktreeInputSchema = v.strictObject({
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
const verifyPrWorktreeInputSchema = v.strictObject({
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
const pushPrAutofixInputSchema = v.strictObject({
  preparedDiffId: nonEmptyStringSchema,
  force: v.optional(v.boolean()),
  lockOwner: v.optional(nonEmptyStringSchema),
  lockTtlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
});
const fixPrCiFailureInputSchema = v.strictObject({
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
const reviewFixReplacementSchema = v.strictObject({
  path: repoRelativePathSchema,
  oldString: nonEmptyStringSchema,
  newString: v.string(),
  replaceAll: v.optional(v.boolean()),
  fuzzy: v.optional(v.picklist(['off', 'safe'])),
});
const fixPrReviewFeedbackInputSchema = v.strictObject({
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
const commentPrAutofixResultInputSchema = v.strictObject({
  preparedDiffId: nonEmptyStringSchema,
});
const autopilotOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const triagePrEventAction = defineAction({
  name: 'neondeck_autopilot_triage_pr_event',
  description:
    'Classify a structured PR watch delta into no-op, notify-only, explain-only, draft-fix, auto-fix-no-push, or auto-fix-push-after-checks without applying fixes.',
  input: triagePrEventInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return triagePrEvent(input);
  },
});

export const preparePrWorktreeAction = defineAction({
  name: 'neondeck_autopilot_prepare_pr_worktree',
  description:
    'Create, sync, lock, and inspect an isolated PR worktree while gathering deterministic PR and check facts.',
  input: preparePrWorktreeInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return preparePrWorktree(input);
  },
});

export const autopilotPolicyCheckAction = defineAction({
  name: 'neondeck_autopilot_policy_check',
  description:
    'Classify an autopilot worktree diff against repo policy limits, high-risk file classes, push destination rules, and concurrency settings.',
  input: v.strictObject({
    repoId: v.optional(nonEmptyStringSchema),
    worktreeId: v.optional(nonEmptyStringSchema),
    diffBaseRef: v.optional(nonEmptyStringSchema),
    pushDestination: v.optional(nonEmptyStringSchema),
    forcePush: v.optional(v.boolean()),
  }),
  output: autopilotOutputSchema,
  async run({ input }) {
    const result = await checkAutopilotPolicy(input);
    return {
      ok: result.ok,
      action: result.action,
      changed: false,
      message: result.message,
      data: asJsonValue(result),
      requires: result.requires,
    };
  },
});

export const verifyPrWorktreeAction = defineAction({
  name: 'neondeck_autopilot_verify_pr_worktree',
  description:
    'Run configured repo checks for a PR worktree through Neondeck execution approval policy and summarize pass, fail, or approval-blocked results.',
  input: verifyPrWorktreeInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return verifyPrWorktree(input);
  },
});

export const pushPrAutofixAction = defineAction({
  name: 'neondeck_autopilot_push_pr_autofix',
  description:
    'Push an approved and verified prepared diff back to the PR head branch only when autopilot policy, GitHub permissions, and clean committed worktree state allow it.',
  input: pushPrAutofixInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return pushPrAutofix(input);
  },
});

export const fixPrCiFailureAction = defineAction({
  name: 'neondeck_autopilot_fix_pr_ci_failure',
  description:
    'Fetch failing check facts/logs for a managed PR worktree, run approved diagnostics, optionally apply a scoped repo-edit patch, commit locally, and create a prepared diff.',
  input: fixPrCiFailureInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return fixPrCiFailure(input);
  },
});

export const fixPrReviewFeedbackAction = defineAction({
  name: 'neondeck_autopilot_fix_pr_review_feedback',
  description:
    'Fetch unresolved PR review feedback, group it by file/topic, read affected files through repo-edit, apply bounded caller-supplied repo-edit replacements or patches in an isolated worktree, commit locally, and prepare a diff for operator review.',
  input: fixPrReviewFeedbackInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return fixPrReviewFeedback(input);
  },
});

export const commentPrAutofixResultAction = defineAction({
  name: 'neondeck_autopilot_comment_pr_autofix_result',
  description:
    'Post a concise GitHub PR comment from deterministic prepared-diff/autopilot result facts and persist a human-readable audit summary.',
  input: commentPrAutofixResultInputSchema,
  output: autopilotOutputSchema,
  async run({ input }) {
    return commentPrAutofixResult(input);
  },
});

export const neondeckAutopilotActions = [
  triagePrEventAction,
  preparePrWorktreeAction,
  autopilotPolicyCheckAction,
  verifyPrWorktreeAction,
  pushPrAutofixAction,
  fixPrCiFailureAction,
  fixPrReviewFeedbackAction,
  commentPrAutofixResultAction,
];

export async function triagePrEvent(
  rawInput: unknown,
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    triagePrEventInputSchema,
    rawInput,
    'autopilot_triage_pr_event',
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const deltas = input.deltas ?? [];
  const mode = input.autopilotMode ?? 'draft-fix';
  const signals = classifySignals(input.current, deltas);
  const classification = classificationFor(mode, signals);
  const shouldPrepareWorktree =
    classification === 'draft-fix' ||
    classification === 'auto-fix-no-push' ||
    classification === 'auto-fix-push-after-checks';
  const reasons = reasonsFor(classification, mode, signals, deltas);

  return {
    ok: true,
    action: 'autopilot_triage_pr_event',
    changed: classification !== 'no-op',
    message:
      classification === 'no-op'
        ? 'PR event does not require autopilot action.'
        : `PR event classified as ${classification}.`,
    data: asJsonValue({
      classification,
      autopilotMode: mode,
      shouldPrepareWorktree,
      nextWorkflow: shouldPrepareWorktree ? 'prepare_pr_worktree' : null,
      source: input.source ?? 'api',
      eventId: input.eventId ?? null,
      watchId: input.watchId ?? null,
      repoId: input.repoId ?? null,
      repoFullName: input.repoFullName ?? null,
      prNumber: input.prNumber,
      reasons,
      deltas,
      previous: input.previous ?? null,
      current: input.current ?? null,
    }),
  };
}

export async function preparePrWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    preparePrWorktreeInputSchema,
    rawInput,
    'autopilot_prepare_pr_worktree',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const registry = await readRepoRegistrySnapshot(paths);
    const repo = registry.repos.find((item) => item.id === input.repoId);
    if (!repo) {
      return failResult(
        'autopilot_prepare_pr_worktree',
        `Repository "${input.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const pr = await fetchPreparedPrFacts(
      repo.github.owner,
      repo.github.name,
      input.prNumber,
      dependencies,
    );
    if ('ok' in pr && !pr.ok) return pr;

    const prFacts = pr as v.InferOutput<typeof prFactsSchema>;
    const checks = await fetchPreparedCheckFacts(
      repo.github.owner,
      repo.github.name,
      prFacts.headSha,
      dependencies,
    );
    if ('ok' in checks && !checks.ok) return checks;

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: input.prNumber,
        workflow: 'prepare_pr_worktree',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_prepare_pr_worktree',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    let worktree: unknown = null;
    let lock: unknown = null;
    let status: unknown = null;
    const createEnabled = input.createWorktree ?? true;

    if (createEnabled) {
      const created = await createWorktree(
        {
          repoId: repo.id,
          prNumber: input.prNumber,
          baseRef: prFacts.baseRef || repo.defaultBranch,
          headOwner: prFacts.headOwner,
          headName: prFacts.headName,
          headRef: prFacts.headRef ?? prFacts.headSha,
          headSha: prFacts.headSha,
          directPushAllowed: Boolean(prFacts.maintainerCanModify),
        },
        paths,
      );
      if (!created.ok) {
        return lowerLevelFailure(
          'autopilot_prepare_pr_worktree',
          'worktree_create',
          created,
        );
      }
      worktree = objectField(created, 'worktree');
      const worktreeId = stringField(worktree, 'id');
      if (!worktreeId) {
        return failResult(
          'autopilot_prepare_pr_worktree',
          'Worktree creation did not return a worktree id.',
          { errors: ['Missing worktree id.'] },
        );
      }

      if (input.sync ?? true) {
        const synced = await syncWorktree(
          {
            worktreeId,
            headRef: prFacts.headRef ?? prFacts.headSha,
            headSha: prFacts.headSha,
            fetch: input.fetch,
          },
          paths,
        );
        if (!synced.ok) {
          return lowerLevelFailure(
            'autopilot_prepare_pr_worktree',
            'worktree_sync',
            synced,
          );
        }
        worktree = objectField(synced, 'worktree') ?? worktree;
      }

      if (input.lock ?? true) {
        const locked = await lockWorktree(
          {
            worktreeId,
            scope: 'pr',
            owner: input.lockOwner ?? 'prepare_pr_worktree',
            ttlSeconds: input.lockTtlSeconds ?? 1_800,
          },
          paths,
        );
        if (!locked.ok) {
          return lowerLevelFailure(
            'autopilot_prepare_pr_worktree',
            'worktree_lock',
            locked,
          );
        }
        lock = objectField(locked, 'lock');
      }

      status = await readWorktreeStatus({ worktreeId }, paths);
    }

    return {
      ok: true,
      action: 'autopilot_prepare_pr_worktree',
      changed: Boolean(worktree),
      message: worktree
        ? `Prepared PR worktree for ${repoFullName(repo)}#${input.prNumber}.`
        : `Gathered PR facts for ${repoFullName(repo)}#${input.prNumber}.`,
      data: asJsonValue({
        repo: {
          id: repo.id,
          fullName: repoFullName(repo),
          path: repo.path,
          defaultBranch: repo.defaultBranch,
        },
        pr: prFacts,
        checks,
        concurrency,
        worktree,
        lock,
        status,
        eventId: input.eventId ?? null,
        runLinkage: {
          owningWorkflowRunIdAttached: false,
          reason:
            'Flue ActionContext does not expose workflow identity; caller-supplied run ids are not accepted.',
        },
      }),
    };
  } catch (error) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'Could not prepare PR worktree.',
      { errors: [errorMessage(error)] },
    );
  }
}

export async function verifyPrWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    verifyPrWorktreeInputSchema,
    rawInput,
    'autopilot_verify_pr_worktree',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;
  let acquiredLockId: string | undefined;
  const lockOwner = input.lockOwner ?? 'verify_pr_worktree';
  let finalLockStatus: 'ready' | 'prepared-diff' = 'ready';

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
        'autopilot_verify_pr_worktree',
        `Worktree "${input.worktreeId}" was not found.`,
        { requires: ['worktreeId'] },
      );
    }
    finalLockStatus =
      worktree.lifecycleStatus === 'prepared-diff' ? 'prepared-diff' : 'ready';
    const repo = registry.repos.find(
      (candidate) => candidate.id === worktree.repoId,
    );
    if (!repo) {
      return failResult(
        'autopilot_verify_pr_worktree',
        `Repository "${worktree.repoId}" is not configured.`,
        { requires: ['repo'] },
      );
    }

    const concurrency = await checkAutopilotConcurrency(
      {
        repoId: repo.id,
        prNumber: worktree.prNumber,
        workflow: 'verify_pr_worktree',
        mutation: true,
      },
      paths,
    );
    if (!concurrency.allowed) {
      return {
        ok: false,
        action: 'autopilot_verify_pr_worktree',
        changed: false,
        message: concurrency.message,
        data: asJsonValue({ concurrency }),
        errors: concurrency.reasons,
        requires: ['concurrency'],
      };
    }

    const lockEnabled = input.lock ?? true;
    if (lockEnabled) {
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
          'autopilot_verify_pr_worktree',
          'worktree_lock',
          locked,
        );
      }
      acquiredLockId = stringField(objectField(locked, 'lock'), 'id');
    }

    const policy = await checkAutopilotPolicy(
      {
        worktreeId: worktree.id,
        diffBaseRef: input.diffBaseRef,
        pushDestination: 'pull-request-head',
      },
      paths,
    );
    if (!policy.ok || policy.blocked) {
      return {
        ok: false,
        action: 'autopilot_verify_pr_worktree',
        changed: false,
        message: policy.message,
        data: asJsonValue({ policy, concurrency }),
        errors: policy.reasons,
        requires: policy.requires,
      };
    }
    if (policy.diff.filesChanged > 0) {
      finalLockStatus = 'prepared-diff';
    }

    const checks = resolveVerificationChecks(
      input.checks,
      repo,
      repoAutopilotPolicy(repo, appConfig).limits.requiredChecks,
    );
    if (checks.length === 0) {
      return failResult(
        'autopilot_verify_pr_worktree',
        'No repo checks are configured for this worktree.',
        {
          requires: ['autopilot.limits.requiredChecks', 'repo.packageScripts'],
        },
      );
    }

    const runExecution = dependencies.runExecution ?? runApprovedExecution;
    const results = [];
    for (const command of checks) {
      const slot = await withAutopilotLocalExecutionSlot(
        policy.concurrency,
        () =>
          runExecution(
            {
              command,
              backend: input.backend,
              cwd: worktree.localPath,
              context: input.context ?? 'unattended',
              timeoutMs: input.timeoutMs,
              maxOutputBytes: input.maxOutputBytes,
              requestContext: {
                source: 'autopilot',
                workflow: 'verify_pr_worktree',
                repoId: repo.id,
                repoFullName: repoFullName(repo),
                prNumber: worktree.prNumber,
                worktreeId: worktree.id,
              },
            },
            paths,
          ),
      );
      if ('blocked' in slot) {
        results.push({
          command,
          ok: false,
          message: slot.message,
          requires: ['localExecutionLimit'],
        });
        break;
      }
      results.push({
        command,
        ok: Boolean(slot.ok),
        message: stringField(slot, 'message') ?? 'Execution completed.',
        requires: arrayField(slot, 'requires'),
        approvalId: stringField(objectField(slot, 'approval'), 'id') ?? null,
        exitCode: numberField(objectField(slot, 'result'), 'exitCode') ?? null,
      });
      if (!slot.ok) break;
    }

    const passed =
      results.length === checks.length && results.every((item) => item.ok);
    const blocked = results.some((item) => item.requires.length > 0);
    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);
    const preparedDiffVerification = await recordPreparedDiffVerification(
      {
        worktreeId: worktree.id,
        status: passed ? 'passed' : 'failed',
        summary: {
          checks,
          results,
          blocked,
        },
      },
      paths,
    );

    return {
      ok: passed,
      action: 'autopilot_verify_pr_worktree',
      changed: true,
      message: passed
        ? `Verified ${repoFullName(repo)}#${worktree.prNumber ?? 'worktree'} with ${results.length} check(s).`
        : blocked
          ? 'Verification is blocked by execution approval or concurrency policy.'
          : 'One or more verification checks failed.',
      data: asJsonValue({
        repo: {
          id: repo.id,
          fullName: repoFullName(repo),
          path: repo.path,
          defaultBranch: repo.defaultBranch,
        },
        worktree,
        policy,
        concurrency,
        checks,
        results,
        status,
        preparedDiffVerification,
      }),
      ...(passed
        ? {}
        : {
            errors: results
              .filter((item) => !item.ok)
              .map((item) => item.message),
          }),
      ...(blocked ? { requires: ['approval'] } : {}),
    };
  } catch (error) {
    return failResult(
      'autopilot_verify_pr_worktree',
      'Could not verify PR worktree.',
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
        ok: Boolean(policy.ok && !policy.blocked && !policy.approvalRequired),
        reason:
          policy.ok && !policy.blocked && !policy.approvalRequired
            ? 'Autopilot policy allows this diff and push destination.'
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
    await addNotification(
      {
        level: 'ready',
        title: 'Autofix pushed',
        message: `Pushed ${preparedDiff.repoFullName}#${preparedDiff.prNumber} autofix commit ${currentSha.slice(0, 12)}.`,
        source: 'autopilot',
        sourceId: `prepared-diff:${preparedDiff.id}:pushed`,
        data: {
          preparedDiffId: preparedDiff.id,
          worktreeId: worktree.id,
          commitSha: currentSha,
        },
      },
      paths,
    );

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
  let acquiredLockId: string | undefined;
  const lockOwner = input.lockOwner ?? 'fix_pr_ci_failure';
  let finalLockStatus: 'ready' | 'prepared-diff' | 'failed' = 'ready';
  let mutationApplied = false;

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
      repoAutopilotPolicy(repo, appConfig).limits.requiredChecks,
      input.checks,
      input.diagnostics,
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
    let commit: unknown = null;
    if (dirty) {
      try {
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
    let preparedDiff: unknown = null;
    if (changed) {
      finalLockStatus = 'prepared-diff';
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

    const reviewFacts = reviewFactsFromEventState(eventState);
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
    const preflightPolicy = repoAutopilotPolicy(repo, appConfig);
    const deniedPlannedPaths = plannedPaths.filter((path) =>
      pathDeniedByAutopilotPolicy(path, preflightPolicy.limits),
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
    if (input.worktreeId) {
      worktree = await readManagedWorktree(input.worktreeId, repo.id, paths);
      if (worktree.prNumber !== input.prNumber) {
        return failResult(
          'autopilot_fix_pr_review_feedback',
          `Worktree "${worktree.id}" belongs to PR ${worktree.prNumber ?? 'none'}, not PR ${input.prNumber}.`,
          { requires: ['worktreeId'] },
        );
      }
    } else if (createEnabled) {
      const created = await createWorktree(
        {
          repoId: repo.id,
          prNumber: input.prNumber,
          baseRef: eventState.headSha,
          headRef: eventState.headRef ?? eventState.headSha,
          headSha: eventState.headSha,
          directPushAllowed: Boolean(eventState.maintainerCanModify),
          createdBy: 'neondeck',
        },
        paths,
      );
      if (!created.ok) {
        return lowerLevelFailure(
          'autopilot_fix_pr_review_feedback',
          'worktree_create',
          created,
        );
      }
      worktree = objectField(created, 'worktree') as WorktreeRecord | undefined;
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
      changedFiles > 0
    ) {
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
      if (acquiredLockId) {
        const released = await releaseWorktreeLock(
          {
            lockId: acquiredLockId,
            owner: lockOwner,
            finalStatus: 'prepared-diff',
          },
          paths,
        );
        worktree =
          (objectField(released, 'worktree') as WorktreeRecord | undefined) ??
          worktree;
        acquiredLockId = undefined;
      }
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

export async function commentPrAutofixResult(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
  dependencies: AutopilotDependencies = {},
): Promise<AutopilotActionResult> {
  const parsed = parseInput(
    commentPrAutofixResultInputSchema,
    rawInput,
    'autopilot_comment_pr_autofix_result',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const preparedDiff = readPreparedDiffRecord(input.preparedDiffId, paths);
    if (!preparedDiff) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        `Prepared diff ${input.preparedDiffId} was not found.`,
        { requires: ['preparedDiffId'] },
      );
    }
    if (preparedDiff.prNumber === null) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        'Prepared diff is not attached to a pull request.',
        { requires: ['prNumber'] },
      );
    }
    const [owner, repoName] = preparedDiff.repoFullName.split('/');
    if (!owner || !repoName) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        `Prepared diff ${preparedDiff.id} has an invalid repo name.`,
        { requires: ['repoFullName'] },
      );
    }
    const token = dependencies.token ?? process.env.GITHUB_TOKEN;
    if (!token) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        'GITHUB_TOKEN is not configured.',
        { requires: ['GITHUB_TOKEN'] },
      );
    }
    const fetchEventState =
      dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState;
    const currentState = await fetchEventState({
      token,
      owner,
      repo: repoName,
      number: preparedDiff.prNumber,
    });
    if (
      preparedDiff.headSha &&
      currentState.headSha &&
      preparedDiff.headSha !== currentState.headSha
    ) {
      return {
        ok: false,
        action: 'autopilot_comment_pr_autofix_result',
        changed: false,
        message:
          'Prepared diff is stale because the pull request head has changed.',
        data: asJsonValue({
          preparedDiffId: preparedDiff.id,
          repoFullName: preparedDiff.repoFullName,
          prNumber: preparedDiff.prNumber,
          preparedHeadSha: preparedDiff.headSha,
          currentHeadSha: currentState.headSha,
        }),
        requires: ['currentPrHead'],
        errors: [
          `Prepared diff head ${preparedDiff.headSha} does not match current PR head ${currentState.headSha}.`,
        ],
      };
    }

    const auditSummary = buildPreparedDiffAuditSummary({
      preparedDiff,
      resultUrl: `/api/prepared-diffs/${encodeURIComponent(preparedDiff.id)}/summary`,
    });
    const facts = auditSummary.facts as Record<string, unknown>;
    const resultStatus = stringField(facts, 'status');
    if (
      resultStatus !== 'prepared' &&
      resultStatus !== 'pushed' &&
      resultStatus !== 'blocked' &&
      resultStatus !== 'verification-requested'
    ) {
      return failResult(
        'autopilot_comment_pr_autofix_result',
        `Prepared diff ${preparedDiff.id} is ${preparedDiff.status}, not a prepared, verified, pushed, or blocked autofix result.`,
        { requires: ['preparedResult'] },
      );
    }
    const checkRunIds = numberArrayField(facts, 'checkRunIds');
    const addressedReviewThreadIds = arrayField(
      facts,
      'addressedReviewThreadIds',
    );
    const addressedReviewCommentIds = arrayField(
      facts,
      'addressedReviewCommentIds',
    );
    const commitSha = stringField(facts, 'commitSha') ?? undefined;
    let workflowSummary = await addWorkflowSummary(
      {
        workflow: 'comment_pr_autofix_result',
        status: 'pending',
        summary: {
          humanSummary: auditSummary.markdown,
          audit: auditSummary.facts,
          comment: null,
        },
      },
      paths,
    );

    const comment = await postGitHubPrComment(
      {
        repo: preparedDiff.repoFullName,
        prNumber: preparedDiff.prNumber,
        body: auditSummary.markdown,
        addressedReviewThreadIds,
        addressedReviewCommentIds,
        checkRunIds,
        commitSha,
      },
      paths,
      {
        fetchPullRequestEventState: dependencies.fetchPullRequestEventState,
        postPullRequestComment: dependencies.postPullRequestComment,
      },
    );

    const auditErrors: string[] = [];
    try {
      workflowSummary =
        (await updateWorkflowSummary(
          workflowSummary.id,
          {
            status: comment.ok ? 'completed' : 'failed',
            summary: {
              humanSummary: auditSummary.markdown,
              audit: auditSummary.facts,
              comment,
            },
          },
          paths,
        )) ?? workflowSummary;
    } catch (error) {
      auditErrors.push(
        `Could not update PR autofix comment audit: ${errorMessage(error)}`,
      );
    }

    const errors = unique([
      ...(comment.ok ? [] : (comment.errors ?? [])),
      ...auditErrors,
    ]);

    return {
      ok: comment.ok,
      action: 'autopilot_comment_pr_autofix_result',
      changed: comment.changed,
      message: comment.ok
        ? auditErrors.length > 0
          ? `Posted autopilot result comment for ${preparedDiff.repoFullName}#${preparedDiff.prNumber}, but the audit update failed.`
          : `Posted autopilot result comment for ${preparedDiff.repoFullName}#${preparedDiff.prNumber}.`
        : comment.message,
      workflowSummary: asJsonValue(workflowSummary),
      data: asJsonValue({
        preparedDiff,
        auditSummary,
        comment,
        workflowSummary,
      }),
      ...(errors.length > 0 ? { errors } : {}),
      ...(comment.requires ? { requires: comment.requires } : {}),
    };
  } catch (error) {
    return failResult(
      'autopilot_comment_pr_autofix_result',
      'Could not comment on PR autofix result.',
      { errors: [errorMessage(error)] },
    );
  }
}

async function fetchPreparedPrFacts(
  owner: string,
  repo: string,
  number: number,
  dependencies: AutopilotDependencies,
): Promise<v.InferOutput<typeof prFactsSchema> | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const detail = await (
    dependencies.fetchPullRequestDetail ?? fetchPullRequestDetail
  )({ token, owner, repo, number });
  return prFactsFromDetail(detail);
}

async function fetchPreparedCheckFacts(
  owner: string,
  repo: string,
  ref: string,
  dependencies: AutopilotDependencies,
): Promise<GitHubCheckSummary | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_prepare_pr_worktree',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const checks = await (dependencies.fetchCheckSummary ?? fetchCheckSummary)({
    token,
    owner,
    repo,
    ref,
  });
  return v.parse(checkSummarySchema, checks);
}

async function fetchCiFailureFacts(
  owner: string,
  repo: string,
  ref: string,
  maxLogBytes: number | undefined,
  dependencies: AutopilotDependencies,
): Promise<GitHubFailingCheckFact[] | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_fix_pr_ci_failure',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const facts = await (
    dependencies.fetchFailingCheckFacts ?? fetchFailingCheckFacts
  )({
    token,
    owner,
    repo,
    ref,
    maxLogBytes,
  });
  return facts;
}

function identifyLikelyCommands(
  facts: GitHubFailingCheckFact[],
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  policyChecks: string[],
  inputChecks: string[] | undefined,
  inputDiagnostics: string[] | undefined,
) {
  const explicit = unique([
    ...(inputDiagnostics ?? []),
    ...(inputChecks ?? []),
    ...policyChecks,
  ]);
  if (explicit.length > 0) return explicit;

  const scripts = repo.packageScripts ?? {};
  const haystack = facts
    .flatMap((fact) => [
      fact.name,
      fact.outputTitle ?? '',
      fact.outputSummary ?? '',
      fact.outputText ?? '',
      fact.log.text ?? '',
      ...fact.annotations.flatMap((annotation) => [
        annotation.title ?? '',
        annotation.message,
        annotation.rawDetails ?? '',
      ]),
    ])
    .join('\n')
    .toLowerCase();
  const preferred = ['check', 'test', 'typecheck', 'lint'];
  const inferred = preferred
    .filter((script) => scripts[script])
    .filter((script) => {
      if (haystack.includes(`npm run ${script}`)) return true;
      if (haystack.includes(`pnpm ${script}`)) return true;
      if (haystack.includes(`yarn ${script}`)) return true;
      return facts.some((fact) => fact.name.toLowerCase().includes(script));
    })
    .map((script) => `npm run ${script}`);
  return inferred.length > 0
    ? unique(inferred)
    : resolveVerificationChecks(undefined, repo, policyChecks).slice(0, 1);
}

async function runAutopilotDiagnostics(
  commands: string[],
  limits: Awaited<ReturnType<typeof checkAutopilotConcurrency>>['limits'],
  requestContext: {
    repoId: string;
    repoFullName: string;
    prNumber: number | null;
    worktreeId: string;
    workflow: string;
  },
  cwd: string,
  paths: RuntimePaths,
  input: v.InferOutput<typeof fixPrCiFailureInputSchema>,
  dependencies: AutopilotDependencies,
) {
  const runExecution = dependencies.runExecution ?? runApprovedExecution;
  const results = [];
  for (const command of commands) {
    const slot = await withAutopilotLocalExecutionSlot(limits, () =>
      runExecution(
        {
          command,
          backend: input.backend,
          cwd,
          context: input.context ?? 'unattended',
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes,
          requestContext: {
            source: 'autopilot',
            ...requestContext,
          },
        },
        paths,
      ),
    );
    if ('blocked' in slot) {
      results.push({
        command,
        ok: false,
        message: slot.message,
        requires: ['localExecutionLimit'],
        approvalId: null,
        exitCode: null,
      });
      break;
    }
    results.push({
      command,
      ok: Boolean(slot.ok),
      message: stringField(slot, 'message') ?? 'Execution completed.',
      requires: arrayField(slot, 'requires'),
      approvalId: stringField(objectField(slot, 'approval'), 'id') ?? null,
      exitCode: numberField(objectField(slot, 'result'), 'exitCode') ?? null,
    });
    if (!slot.ok) break;
  }
  return results;
}

function generatedCiFixCommitMessage(
  repo: string,
  prNumber: number | null,
  facts: GitHubFailingCheckFact[],
) {
  const checkIds = facts
    .map((fact) => fact.id)
    .slice(0, 3)
    .join(', ');
  const pr = prNumber === null ? repo : `${repo}#${prNumber}`;
  return checkIds
    ? `Fix PR CI failure for ${pr} (checks ${checkIds})`
    : `Fix PR CI failure for ${pr}`;
}

async function blockPushAttempt(
  preparedDiffId: string,
  worktreeId: string,
  message: string,
  input: {
    gates: Array<{ gate: string; ok: boolean; reason: string }>;
    paths: RuntimePaths;
    recoveryOptions?: string[];
    data?: unknown;
  },
): Promise<AutopilotActionResult> {
  const recoveryOptions =
    input.recoveryOptions ?? recoveryOptionsForPushBlock(input.gates);
  const preparedDiff = markPreparedDiffPushBlocked(
    preparedDiffId,
    {
      reason: message,
      gates: input.gates,
      recoveryOptions,
    },
    input.paths,
  );
  const worktree = await recordWorktreePushBlocked(
    worktreeId,
    {
      message,
      data: {
        preparedDiffId,
        gates: input.gates,
        recoveryOptions,
        details: input.data ?? null,
      },
    },
    input.paths,
  ).catch(() => null);
  await addNotification(
    {
      level: 'attention',
      title: 'Autofix push blocked',
      message,
      source: 'autopilot',
      sourceId: `prepared-diff:${preparedDiffId}:push-blocked`,
      data: {
        preparedDiffId,
        worktreeId,
        gates: input.gates,
        recoveryOptions,
      },
    },
    input.paths,
  );
  return {
    ok: false,
    action: 'autopilot_push_pr_autofix',
    changed: true,
    message,
    data: asJsonValue({
      preparedDiff,
      worktree,
      gates: input.gates,
      recoveryOptions,
      details: input.data ?? null,
    }),
    requires: input.gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
    errors: input.gates.filter((gate) => !gate.ok).map((gate) => gate.reason),
  };
}

function recoveryOptionsForPushBlock(
  gates: Array<{ gate: string; ok: boolean; reason: string }>,
) {
  const failed = new Set(
    gates.filter((gate) => !gate.ok).map((gate) => gate.gate),
  );
  const options: string[] = [];
  if (failed.has('autopilot-mode') || failed.has('autopilot-policy')) {
    options.push(
      'Review repo autopilot policy or request a lower-risk revision before retrying.',
    );
  }
  if (failed.has('prepared-diff-approval')) {
    options.push('Approve the prepared diff push-back, then retry.');
  }
  if (failed.has('verification')) {
    options.push('Run verify_pr_worktree and retry only after checks pass.');
  }
  if (failed.has('github-permissions')) {
    options.push(
      'Grant branch push permission, ask the PR author to enable maintainer edits, or push manually from the retained worktree.',
    );
  }
  if (failed.has('clean-worktree') || failed.has('committed-diff')) {
    options.push(
      'Commit or discard local worktree changes, then rerun verification and push.',
    );
  }
  if (failed.has('force-push')) {
    options.push(
      'Create a normal forward commit; force-push remains deferred.',
    );
  }
  return options.length > 0
    ? options
    : ['Inspect the retained worktree, resolve the blocked gate, and retry.'];
}

function remoteForPush(worktree: WorktreeRecord, branchPermissions: unknown) {
  const headRepoFullName = stringField(branchPermissions, 'headRepoFullName');
  const worktreeHeadFullName =
    worktree.headOwner && worktree.headName
      ? `${worktree.headOwner}/${worktree.headName}`
      : undefined;
  return githubRemoteUrl(
    headRepoFullName ?? worktreeHeadFullName ?? worktree.repoFullName,
  );
}

function githubRemoteUrl(fullName: string) {
  const [owner, repo, extra] = fullName.split('/');
  if (
    extra !== undefined ||
    !owner ||
    !repo ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner) ||
    !/^[A-Za-z0-9._-]+$/.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  }
  return `https://github.com/${fullName}.git`;
}

function preparedDiffCommitSha(
  summary: JsonValue | null,
  section: string,
  key: string,
) {
  return stringField(objectField(summary, section), key);
}

async function fetchReviewEventState(
  owner: string,
  repo: string,
  number: number,
  dependencies: AutopilotDependencies,
): Promise<GitHubPullRequestEventState | AutopilotActionResult> {
  const token = dependencies.token ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return failResult(
      'autopilot_fix_pr_review_feedback',
      'GITHUB_TOKEN is not configured.',
      { requires: ['GITHUB_TOKEN'] },
    );
  }

  const state = await (
    dependencies.fetchPullRequestEventState ?? fetchPullRequestEventState
  )({
    token,
    owner,
    repo,
    number,
  });
  const parsed = v.safeParse(prReviewEventStateSchema, state);
  if (!parsed.success) {
    return failResult(
      'autopilot_fix_pr_review_feedback',
      'Invalid GitHub PR review event state.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }
  return parsed.output as GitHubPullRequestEventState;
}

type ReviewCommentFact = {
  id: string;
  databaseId: number | null;
  threadId: string;
  authorLogin: string | null;
  body: string;
  url: string | null;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  diffHunk: string | null;
  reviewId: number | null;
  createdAt: string;
  updatedAt: string;
  threadPath: string | null;
  threadLine: number | null;
  threadIsOutdated: boolean;
};

type ReviewFeedbackGroup = {
  path: string | null;
  topic: string;
  comments: ReviewCommentFact[];
};

function reviewFactsFromEventState(state: GitHubPullRequestEventState) {
  const unresolvedThreads = state.reviewThreads.filter(
    (thread) => !thread.isResolved,
  );
  const unresolvedComments = unresolvedThreads.flatMap((thread) =>
    thread.comments.map((comment) => ({
      id: comment.id,
      databaseId: comment.databaseId,
      threadId: thread.id,
      authorLogin: comment.authorLogin,
      body: comment.body,
      url: comment.url,
      path: comment.path ?? thread.path,
      line: comment.line ?? thread.line,
      originalLine: comment.originalLine,
      diffHunk: comment.diffHunk,
      reviewId: comment.reviewId,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      threadPath: thread.path,
      threadLine: thread.line,
      threadIsOutdated: thread.isOutdated,
    })),
  );

  return {
    pr: {
      repo: state.repo,
      number: state.number,
      title: state.title,
      url: state.url,
      state: state.state,
      draft: state.draft,
      headSha: state.headSha,
      headRef: state.headRef,
      baseRef: state.baseRef,
      fetchedAt: state.fetchedAt,
    },
    unresolvedThreadCount: unresolvedThreads.length,
    unresolvedCommentCount: unresolvedComments.length,
    unresolvedComments,
    requestedChanges: state.requestedChangesReviews.map((review) => ({
      id: review.id,
      nodeId: review.nodeId,
      authorLogin: review.authorLogin,
      submittedAt: review.submittedAt,
      commitId: review.commitId,
      url: review.url,
    })),
    requestedChangesState: state.requestedChangesState,
  };
}

function groupReviewFeedback(comments: ReviewCommentFact[]) {
  const groups = new Map<string, ReviewFeedbackGroup>();
  for (const comment of comments) {
    const path = comment.path ?? comment.threadPath;
    const topic = topicFromComment(comment);
    const key = `${path ?? '(general)'}\u0000${topic}`;
    const existing = groups.get(key);
    if (existing) {
      existing.comments.push(comment);
    } else {
      groups.set(key, { path: path ?? null, topic, comments: [comment] });
    }
  }

  return [...groups.values()].sort((a, b) => {
    const path = (a.path ?? '').localeCompare(b.path ?? '');
    return path === 0 ? a.topic.localeCompare(b.topic) : path;
  });
}

function buildReviewFixPlan(
  groups: ReviewFeedbackGroup[],
  requestedChanges: ReturnType<
    typeof reviewFactsFromEventState
  >['requestedChanges'],
) {
  return {
    groupCount: groups.length,
    commentCount: groups.reduce((sum, group) => sum + group.comments.length, 0),
    requestedChangesCount: requestedChanges.length,
    groups: groups.map((group) => ({
      path: group.path,
      topic: group.topic,
      commentIds: group.comments.map((comment) => comment.id),
      threadIds: unique(group.comments.map((comment) => comment.threadId)),
      lineHints: unique(
        group.comments
          .map((comment) => comment.line ?? comment.threadLine)
          .filter((line): line is number => typeof line === 'number')
          .map((line) => String(line)),
      ).map(Number),
      summaries: group.comments.map((comment) => summarizeComment(comment)),
      suggestedAction: group.path
        ? 'Read this file through repo-edit, then apply a bounded replacement or patch that directly addresses the reviewer request.'
        : 'Review the general thread context; no file path was supplied by GitHub.',
    })),
  };
}

function reviewTargetPathSet(groups: ReviewFeedbackGroup[]) {
  return new Set(
    groups
      .map((group) => group.path)
      .filter((path): path is string => Boolean(path)),
  );
}

function plannedEditPaths(
  replacements: Array<v.InferOutput<typeof reviewFixReplacementSchema>>,
  patch: string | undefined,
) {
  const paths = new Set(replacements.map((replacement) => replacement.path));
  if (patch) {
    for (const operation of parseV4APatch(patch).operations) {
      if (operation.type === 'move') {
        paths.add(operation.from);
        paths.add(operation.to);
      } else {
        paths.add(operation.path);
      }
    }
  }
  return [...paths].sort();
}

function worktreeStatusDirty(status: unknown) {
  const git = objectField(status, 'git');
  return Boolean(booleanField(git, 'dirty'));
}

async function readReviewTargetFiles(
  repoId: string,
  worktreeId: string,
  groups: ReviewFeedbackGroup[],
  limit: number,
  paths: RuntimePaths,
) {
  const targetPaths = unique(
    groups
      .map((group) => group.path)
      .filter(
        (path): path is string => typeof path === 'string' && path !== '',
      ),
  );
  const reads = [];
  for (const path of targetPaths) {
    const result = await readRepoFile(
      {
        repoId,
        worktreeId,
        path,
        limit,
        includeLineNumbers: true,
      },
      paths,
    );
    reads.push({
      ok: Boolean(booleanField(result, 'ok')),
      path,
      message: stringField(result, 'message') ?? `Read ${path}.`,
      stamp: objectField(result, 'stamp') ?? null,
      totalLines: numberField(result, 'totalLines') ?? null,
      truncated: Boolean(booleanField(result, 'truncated')),
    });
  }
  return reads;
}

async function applyReviewEdits(
  input: {
    repoId: string;
    worktreeId: string;
    lockId?: string;
    replacements: Array<v.InferOutput<typeof reviewFixReplacementSchema>>;
    patch?: string;
    dryRun?: boolean;
    fileReads: Array<{ path: string; stamp: object | null }>;
  },
  paths: RuntimePaths,
) {
  const results: unknown[] = [];
  const stamps = new Map(
    input.fileReads
      .filter((read) => read.stamp)
      .map((read) => [read.path, read.stamp!]),
  );
  const readPaths = new Set(input.fileReads.map((read) => read.path));

  for (const replacement of input.replacements) {
    if (!readPaths.has(replacement.path) || !stamps.has(replacement.path)) {
      results.push({
        ok: false,
        action: 'repo_file_replace',
        changed: false,
        message: `Replacement target ${replacement.path} was not read from unresolved review feedback.`,
      });
      continue;
    }
    results.push(
      await replaceRepoFile(
        {
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          worktreeLockId: input.lockId,
          path: replacement.path,
          oldString: replacement.oldString,
          newString: replacement.newString,
          replaceAll: replacement.replaceAll,
          fuzzy: replacement.fuzzy ?? 'safe',
          expectedStamp: stamps.get(replacement.path),
          dryRun: input.dryRun,
          reason: 'fix_pr_review_feedback',
        },
        paths,
      ),
    );
  }

  if (input.patch) {
    const patch = parseV4APatch(input.patch);
    const patchPaths = patch.operations.flatMap((operation) =>
      operation.type === 'move'
        ? [operation.from, operation.to]
        : [operation.path],
    );
    const unreadPatchPaths = unique(
      patchPaths.filter((path) => !readPaths.has(path) || !stamps.has(path)),
    );
    if (unreadPatchPaths.length > 0) {
      results.push({
        ok: false,
        action: 'repo_file_patch',
        changed: false,
        message: `Patch target(s) were not read from unresolved review feedback: ${unreadPatchPaths.join(', ')}.`,
      });
      return results;
    }
    results.push(
      await patchRepoFiles(
        {
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          worktreeLockId: input.lockId,
          patch: input.patch,
          expectedStamps: Object.fromEntries(stamps),
          dryRun: input.dryRun,
          reason: 'fix_pr_review_feedback',
        },
        paths,
      ),
    );
  }

  return results;
}

function addressedFeedback(
  comments: ReviewCommentFact[],
  commentIds: string[] | undefined,
  threadIds: string[] | undefined,
  plannedPaths: string[] = [],
) {
  const availableCommentIds = new Set(comments.map((comment) => comment.id));
  const availableThreadIds = new Set(
    comments.map((comment) => comment.threadId),
  );
  const plannedPathSet = new Set(plannedPaths);
  const defaultComments =
    plannedPathSet.size > 0
      ? comments.filter((comment) => {
          const path = comment.path ?? comment.threadPath;
          return path ? plannedPathSet.has(path) : false;
        })
      : comments;
  const selectedCommentIds =
    commentIds && commentIds.length > 0
      ? commentIds.filter((id) => availableCommentIds.has(id))
      : defaultComments.map((comment) => comment.id);
  const selectedThreadIds =
    threadIds && threadIds.length > 0
      ? threadIds.filter((id) => availableThreadIds.has(id))
      : unique(
          comments
            .filter((comment) => selectedCommentIds.includes(comment.id))
            .map((comment) => comment.threadId),
        );

  return {
    reviewCommentIds: unique(selectedCommentIds),
    reviewThreadIds: unique(selectedThreadIds),
    ignoredReviewCommentIds: (commentIds ?? []).filter(
      (id) => !availableCommentIds.has(id),
    ),
    ignoredReviewThreadIds: (threadIds ?? []).filter(
      (id) => !availableThreadIds.has(id),
    ),
  };
}

function reviewFixCommitMessage(
  repo: string,
  prNumber: number,
  addressed: ReturnType<typeof addressedFeedback>,
) {
  const commentIds = formatIds(addressed.reviewCommentIds);
  const threadIds = formatIds(addressed.reviewThreadIds);
  return [
    'Address PR review feedback',
    '',
    `PR: ${repo}#${prNumber}`,
    `Review comments: ${commentIds}`,
    `Review threads: ${threadIds}`,
  ].join('\n');
}

function formatIds(ids: string[]) {
  if (ids.length === 0) return 'none';
  const head = ids.slice(0, 12).join(', ');
  return ids.length > 12 ? `${head}, +${ids.length - 12} more` : head;
}

function topicFromComment(comment: ReviewCommentFact) {
  const firstLine =
    comment.body
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .find(Boolean) ?? 'review feedback';
  return firstLine
    .replace(/\s+/g, ' ')
    .replace(/[`*_#[\]()]/g, '')
    .slice(0, 96);
}

function summarizeComment(comment: ReviewCommentFact) {
  const body = comment.body.replace(/\s+/g, ' ').trim();
  return {
    id: comment.id,
    threadId: comment.threadId,
    authorLogin: comment.authorLogin,
    line: comment.line ?? comment.threadLine,
    outdated: comment.threadIsOutdated,
    url: comment.url,
    body: body.length > 180 ? `${body.slice(0, 177)}...` : body,
  };
}

function repoSummary(
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
) {
  return {
    id: repo.id,
    fullName: repoFullName(repo),
    path: repo.path,
    defaultBranch: repo.defaultBranch,
  };
}

function prFactsFromDetail(
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

function classifySignals(
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

function classificationFor(
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

function reasonsFor(
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

function parseInput<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  schema: TSchema,
  rawInput: unknown,
  action: string,
):
  | { ok: true; input: v.InferOutput<TSchema> }
  | { ok: false; result: AutopilotActionResult } {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: failResult(action, 'Invalid autopilot input.', {
      errors: [v.summarize(parsed.issues)],
    }),
  };
}

function failResult(
  action: string,
  message: string,
  details: Pick<AutopilotActionResult, 'errors' | 'requires'> = {},
): AutopilotActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function lowerLevelFailure(
  action: string,
  sourceAction: string,
  result: unknown,
): AutopilotActionResult {
  const message =
    stringField(result, 'message') ??
    `Could not prepare PR worktree because ${sourceAction} failed.`;
  return {
    ok: false,
    action,
    changed: Boolean(booleanField(result, 'changed')),
    message,
    errors: [message],
    error: asJsonValue({
      sourceAction,
      sourceMessage: message,
      sourceError:
        result && typeof result === 'object'
          ? (result as Record<string, unknown>).error
          : undefined,
    }),
  };
}

function resolveVerificationChecks(
  inputChecks: string[] | undefined,
  repo: Awaited<ReturnType<typeof readRepoRegistrySnapshot>>['repos'][number],
  policyChecks: string[],
) {
  if (policyChecks.length > 0) {
    return unique([...policyChecks, ...(inputChecks ?? [])]);
  }
  if (inputChecks && inputChecks.length > 0) return unique(inputChecks);

  const scripts = repo.packageScripts ?? {};
  const preferred = ['check', 'test', 'typecheck', 'lint'];
  return preferred
    .filter((script) => scripts[script])
    .map((script) => `npm run ${script}`);
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function objectField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' ? field : undefined;
}

function stringField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function booleanField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'boolean' ? field : undefined;
}

function numberField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : undefined;
}

function arrayField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberArrayField(value: unknown, key: string) {
  if (!value || typeof value !== 'object') return [];
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field)
    ? field.filter((item): item is number => typeof item === 'number')
    : [];
}

function isAutopilotActionResult(
  value: GitHubPullRequestEventState | AutopilotActionResult,
): value is AutopilotActionResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    'ok' in value &&
    'action' in value
  );
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
