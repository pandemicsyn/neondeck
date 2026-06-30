import { defineTool } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { listExecutionApprovals } from './execution-actions';
import {
  globalAutopilotPolicy,
  mergeAutopilotConcurrency,
  mergeAutopilotLimits,
  normalizeAutopilotMode,
  readRepoAutopilotConfig,
  type AutopilotConcurrencyPolicy,
  type AutopilotMode,
  type AutopilotModeAlias,
  type AutopilotPolicyLimits,
} from './autopilot-policy';
import {
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type RepoConfig,
  type RuntimePaths,
} from './runtime-home';
import { listNotifications, type NotificationLevel } from './app-state';
import {
  listPreparedDiffs,
  type PreparedDiffApprovalRecord,
  type PreparedDiffRecord,
  type PreparedDiffStatus,
} from './prepared-diffs';
import { listPrWatchRecords, type PrWatch } from './watch-actions';
import {
  listWorktrees,
  type WorktreeLifecycleStatus,
  type WorktreeRecord,
} from './worktrees';

export type AutopilotQueueStatus =
  | 'watching'
  | 'queued'
  | 'running'
  | 'prepared'
  | 'waiting-approval'
  | 'blocked';

export type AutopilotPriority = 'low' | 'normal' | 'high' | 'urgent';

export type AutopilotPolicyConfig = {
  mode: AutopilotMode;
  limits: AutopilotPolicyLimits;
  concurrency: AutopilotConcurrencyPolicy;
};

export type RepoAutopilotPolicy = {
  repoId: string;
  repoFullName: string;
  mode: AutopilotMode;
  source: 'global-default' | 'repo-metadata';
  reason: string;
  limits: AutopilotPolicyLimits;
  concurrency: AutopilotConcurrencyPolicy;
};

export type WatchAutopilotPolicy = {
  watchId: string;
  repoId: string;
  repoFullName: string;
  prNumber: number;
  mode: AutopilotMode;
  source: 'repo-policy' | 'watch-override';
  reason: string;
};

export type AutopilotQueueItem = {
  id: string;
  source: 'watch' | 'worktree' | 'workflow' | 'approval';
  status: AutopilotQueueStatus;
  priority: AutopilotPriority;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  title: string;
  mode: AutopilotMode;
  reason: string;
  nextStep: string;
  worktreeId: string | null;
  runId: string | null;
  updatedAt: string;
};

export type AutopilotPreparedDiff = {
  id: string;
  repoId: string;
  repoFullName: string;
  prNumber: number | null;
  worktreeId: string;
  localPath: string;
  title: string;
  status: PreparedDiffStatus;
  pushApprovalStatus: string;
  verificationStatus: string;
  sourceOfTruth: 'worktree';
  summary: string;
  updatedAt: string;
};

export type AutopilotApproval = {
  id: string;
  repoId: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  command: string;
  risk: string;
  status: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
};

export type AutopilotRunningCheck = {
  id: string;
  runId: string;
  workflow: string;
  repoId: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  status: 'running';
  startedAt: string;
  lastEventAt: string;
  lastMessage: string;
  runUrl: string;
};

export type AutopilotActivity = {
  id: string;
  type: 'workflow' | 'worktree' | 'notification';
  level: NotificationLevel | 'info' | 'attention';
  title: string;
  message: string;
  repoId: string | null;
  repoFullName: string | null;
  prNumber: number | null;
  createdAt: string;
};

export type AutopilotState = {
  ok: true;
  action: 'autopilot_state_read';
  changed: false;
  modeLabels: Record<AutopilotMode, string>;
  summary: {
    activeWatches: number;
    queuedItems: number;
    preparedDiffs: number;
    pendingApprovals: number;
    runningChecks: number;
    recentActivity: number;
    placeholderAdapters: string[];
  };
  queue: AutopilotQueueItem[];
  policies: {
    global: AutopilotPolicyConfig;
    repos: RepoAutopilotPolicy[];
    watches: WatchAutopilotPolicy[];
  };
  preparedDiffs: AutopilotPreparedDiff[];
  pendingApprovals: AutopilotApproval[];
  runningChecks: AutopilotRunningCheck[];
  recentActivity: AutopilotActivity[];
  fetchedAt: string;
};

type AutopilotRepoConfig = Partial<{
  mode: AutopilotMode | AutopilotModeAlias;
  reason: string;
  limits: Partial<AutopilotPolicyLimits>;
  concurrency: Partial<AutopilotConcurrencyPolicy>;
  watchOverrides: Array<{
    watchId?: string;
    prNumber?: number;
    mode?: AutopilotMode | AutopilotModeAlias;
    reason?: string;
  }>;
}>;

type WorkflowRunRow = {
  run_id: string;
  workflow: string;
  status: string;
  started_at: string;
  last_event_at: string;
  last_message: string;
};

type WorkflowEventRow = {
  id: number;
  run_id: string | null;
  workflow: string | null;
  event_type: string;
  message: string;
  is_error: number;
  summary_json: string | null;
  created_at: string;
};

type WorktreeEventRow = {
  id: string;
  worktree_id: string;
  repo_id: string;
  event_type: string;
  status: string;
  message: string;
  created_at: string;
};

const modeLabels: Record<AutopilotMode, string> = {
  'notify-only': 'Notify only',
  'prepare-only': 'Prepare only',
  'autofix-with-approval': 'Autofix with approval',
  'autofix-push-when-safe': 'Autofix push when safe',
};

const autopilotModeOutputSchema = v.picklist([
  'notify-only',
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
]);
const policyLimitsOutputSchema = v.object({
  maxFilesChanged: v.number(),
  maxLinesChanged: v.number(),
  deniedFileGlobs: v.array(v.string()),
  approvalRequiredFileGlobs: v.array(v.string()),
  requiredChecks: v.array(v.string()),
  allowedPushDestinations: v.array(v.string()),
  allowForcePush: v.boolean(),
  highRiskClasses: v.array(v.string()),
  generatedFileSizeThresholdBytes: v.number(),
});
const concurrencyOutputSchema = v.object({
  maxAutonomousJobs: v.number(),
  maxActiveWorkflowRuns: v.number(),
  maxPerRepoAutonomousJobs: v.number(),
  singleMutationPerPr: v.boolean(),
  localExecutionLimit: v.number(),
});
const queueItemSchema = v.object({
  id: v.string(),
  source: v.picklist(['watch', 'worktree', 'workflow', 'approval']),
  status: v.picklist([
    'watching',
    'queued',
    'running',
    'prepared',
    'waiting-approval',
    'blocked',
  ]),
  priority: v.picklist(['low', 'normal', 'high', 'urgent']),
  repoId: v.string(),
  repoFullName: v.string(),
  prNumber: v.nullable(v.number()),
  title: v.string(),
  mode: autopilotModeOutputSchema,
  reason: v.string(),
  nextStep: v.string(),
  worktreeId: v.nullable(v.string()),
  runId: v.nullable(v.string()),
  updatedAt: v.string(),
});
const repoPolicySchema = v.object({
  repoId: v.string(),
  repoFullName: v.string(),
  mode: autopilotModeOutputSchema,
  source: v.picklist(['global-default', 'repo-metadata']),
  reason: v.string(),
  limits: policyLimitsOutputSchema,
  concurrency: concurrencyOutputSchema,
});
const watchPolicySchema = v.object({
  watchId: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  prNumber: v.number(),
  mode: autopilotModeOutputSchema,
  source: v.picklist(['repo-policy', 'watch-override']),
  reason: v.string(),
});
const preparedDiffSchema = v.object({
  id: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  prNumber: v.nullable(v.number()),
  worktreeId: v.string(),
  localPath: v.string(),
  title: v.string(),
  status: v.picklist([
    'prepared',
    'verification-requested',
    'revision-requested',
    'push-approved',
    'push-blocked',
    'pushed',
    'abandoned',
  ]),
  pushApprovalStatus: v.string(),
  verificationStatus: v.string(),
  sourceOfTruth: v.literal('worktree'),
  summary: v.string(),
  updatedAt: v.string(),
});
const approvalSchema = v.object({
  id: v.string(),
  repoId: v.nullable(v.string()),
  repoFullName: v.nullable(v.string()),
  prNumber: v.nullable(v.number()),
  command: v.string(),
  risk: v.string(),
  status: v.string(),
  reason: v.string(),
  createdAt: v.string(),
  updatedAt: v.string(),
});
const runningCheckSchema = v.object({
  id: v.string(),
  runId: v.string(),
  workflow: v.string(),
  repoId: v.nullable(v.string()),
  repoFullName: v.nullable(v.string()),
  prNumber: v.nullable(v.number()),
  status: v.literal('running'),
  startedAt: v.string(),
  lastEventAt: v.string(),
  lastMessage: v.string(),
  runUrl: v.string(),
});
const activitySchema = v.object({
  id: v.string(),
  type: v.picklist(['workflow', 'worktree', 'notification']),
  level: v.picklist(['info', 'ready', 'attention', 'urgent']),
  title: v.string(),
  message: v.string(),
  repoId: v.nullable(v.string()),
  repoFullName: v.nullable(v.string()),
  prNumber: v.nullable(v.number()),
  createdAt: v.string(),
});

export const autopilotStateSchema = v.object({
  ok: v.literal(true),
  action: v.literal('autopilot_state_read'),
  changed: v.literal(false),
  modeLabels: v.record(v.string(), v.string()),
  summary: v.object({
    activeWatches: v.number(),
    queuedItems: v.number(),
    preparedDiffs: v.number(),
    pendingApprovals: v.number(),
    runningChecks: v.number(),
    recentActivity: v.number(),
    placeholderAdapters: v.array(v.string()),
  }),
  queue: v.array(queueItemSchema),
  policies: v.object({
    global: v.object({
      mode: autopilotModeOutputSchema,
      limits: policyLimitsOutputSchema,
      concurrency: concurrencyOutputSchema,
    }),
    repos: v.array(repoPolicySchema),
    watches: v.array(watchPolicySchema),
  }),
  preparedDiffs: v.array(preparedDiffSchema),
  pendingApprovals: v.array(approvalSchema),
  runningChecks: v.array(runningCheckSchema),
  recentActivity: v.array(activitySchema),
  fetchedAt: v.string(),
});

const autopilotWorkflowNames = new Set([
  'triage-pr-event',
  'prepare-pr-worktree',
  'fix-pr-review-feedback',
  'fix-pr-ci-failure',
  'verify-pr-worktree',
  'push-pr-autofix',
  'comment-pr-autofix-result',
  'cleanup-autopilot-worktree',
]);
const checkWorkflowNames = new Set(['verify-pr-worktree']);

function normalizeWorkflowName(workflow: string) {
  return workflow.replaceAll('_', '-');
}

function isAutopilotWorkflow(workflow: string) {
  return autopilotWorkflowNames.has(normalizeWorkflowName(workflow));
}

function isCheckWorkflow(workflow: string) {
  return checkWorkflowNames.has(normalizeWorkflowName(workflow));
}

export const autopilotStateLookupTool = defineTool({
  name: 'neondeck_autopilot_state_lookup',
  description:
    'Read the Neondeck autopilot operator surface: active PR watches, queue placeholders, worktrees, approvals, running checks, recent activity, and repo/watch policy.',
  input: v.object({}),
  output: autopilotStateSchema,
  async run() {
    return readAutopilotState();
  },
});

export async function readAutopilotState(
  paths: RuntimePaths = runtimePaths(),
): Promise<AutopilotState> {
  await ensureRuntimeHome(paths);
  const [
    reposFile,
    appConfig,
    watches,
    worktreeSnapshot,
    preparedDiffSnapshot,
    approvals,
    notifications,
  ] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
    listPrWatchRecords(paths),
    listWorktrees(paths),
    listPreparedDiffs({}, paths),
    listExecutionApprovals(paths, { includeResolved: false }),
    listNotifications(paths, { includeResolved: true }),
  ]);

  const repos = reposFile.repos;
  const repoPolicyMap = new Map(
    repos.map((repo) => {
      const policy = repoPolicy(repo, appConfig);
      return [repo.id, policy] as const;
    }),
  );
  const watchPolicies = watches.map((watch) =>
    watchPolicy(watch, repoPolicyMap.get(watch.repoId), repos),
  );
  const worktrees = worktreeSnapshot.worktrees;
  const workflowRuns = readActiveAutopilotRuns(paths);
  const runningChecks = workflowRuns
    .filter((run) => isCheckWorkflow(run.workflow))
    .map((run) => runningCheckFromWorkflow(run, worktrees));
  const preparedDiffs = (preparedDiffSnapshot.preparedDiffs ?? []).map(
    preparedDiffFromRecord,
  );
  const pendingApprovals = [
    ...approvals.approvals
      .filter(isAutopilotApproval)
      .map((approval) => approvalFromExecution(approval, worktrees)),
    ...(preparedDiffSnapshot.approvals ?? []).map((approval) =>
      approvalFromPreparedDiff(
        approval,
        preparedDiffSnapshot.preparedDiffs ?? [],
      ),
    ),
  ];
  const queue = [
    ...watches.map((watch) =>
      queueItemFromWatch(
        watch,
        watchPolicies.find((policy) => policy.watchId === watch.id),
        worktrees,
      ),
    ),
    ...worktrees
      .filter((worktree) =>
        ['busy', 'needs-sync', 'failed'].includes(worktree.lifecycleStatus),
      )
      .map((worktree) =>
        queueItemFromWorktree(worktree, repoPolicyMap.get(worktree.repoId)),
      ),
    ...(preparedDiffSnapshot.preparedDiffs ?? []).map((preparedDiff) =>
      queueItemFromPreparedDiff(
        preparedDiff,
        repoPolicyMap.get(preparedDiff.repoId),
      ),
    ),
    ...workflowRuns.map((run) => queueItemFromWorkflow(run, worktrees)),
    ...pendingApprovals.map(queueItemFromApproval),
  ]
    .sort(queueSort)
    .slice(0, 40);
  const recentActivity = [
    ...readRecentAutopilotWorkflowEvents(paths),
    ...readRecentWorktreeEvents(paths, worktrees),
    ...notifications
      .filter((notification) => notification.source === 'autopilot')
      .map((notification) => ({
        id: notification.id,
        type: 'notification' as const,
        level: notification.level,
        title: notification.title,
        message: notification.message,
        repoId: null,
        repoFullName: null,
        prNumber: null,
        createdAt: notification.createdAt,
      })),
  ]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 20);

  const state = {
    ok: true,
    action: 'autopilot_state_read',
    changed: false,
    modeLabels,
    summary: {
      activeWatches: watches.length,
      queuedItems: queue.length,
      preparedDiffs: preparedDiffs.length,
      pendingApprovals: pendingApprovals.length,
      runningChecks: runningChecks.length,
      recentActivity: recentActivity.length,
      placeholderAdapters: [
        'Queue entries are derived from watches, worktrees, approvals, and Flue observations until Phase 19 workflow admission tables land.',
        'Watch-level policy reads repo metadata overrides until durable watch-policy rows land.',
      ],
    },
    queue,
    policies: {
      global: globalPolicy(appConfig),
      repos: repos.map(
        (repo) => repoPolicyMap.get(repo.id) ?? repoPolicy(repo, appConfig),
      ),
      watches: watchPolicies,
    },
    preparedDiffs,
    pendingApprovals,
    runningChecks,
    recentActivity,
    fetchedAt: new Date().toISOString(),
  } satisfies AutopilotState;

  return v.parse(autopilotStateSchema, state) as AutopilotState;
}

function globalPolicy(appConfig: unknown): AutopilotPolicyConfig {
  return globalAutopilotPolicy(appConfig);
}

function repoPolicy(repo: RepoConfig, appConfig: unknown): RepoAutopilotPolicy {
  const global = globalPolicy(appConfig);
  const repoAutopilot = readRepoAutopilot(repo);
  const mode = repoAutopilot?.mode
    ? normalizeAutopilotMode(repoAutopilot.mode)
    : global.mode;
  const source = repoAutopilot?.mode ? 'repo-metadata' : 'global-default';

  return {
    repoId: repo.id,
    repoFullName: `${repo.github.owner}/${repo.github.name}`,
    mode,
    source,
    reason:
      repoAutopilot?.reason ??
      (source === 'repo-metadata'
        ? 'Repo metadata overrides the global autopilot mode.'
        : 'Repo inherits the global autopilot default.'),
    limits: mergeAutopilotLimits(global.limits, repoAutopilot?.limits),
    concurrency: mergeAutopilotConcurrency(
      global.concurrency,
      repoAutopilot?.concurrency,
    ),
  };
}

function watchPolicy(
  watch: PrWatch,
  repoPolicy: RepoAutopilotPolicy | undefined,
  repos: RepoConfig[],
): WatchAutopilotPolicy {
  const repo = repos.find((candidate) => candidate.id === watch.repoId);
  const override = readRepoAutopilot(repo)?.watchOverrides?.find(
    (candidate) =>
      candidate.watchId === watch.id || candidate.prNumber === watch.prNumber,
  );
  const inheritedMode = repoPolicy?.mode ?? 'notify-only';
  const mode = override?.mode
    ? normalizeAutopilotMode(override.mode)
    : inheritedMode;

  return {
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    source: override?.mode ? 'watch-override' : 'repo-policy',
    reason:
      override?.reason ??
      (override?.mode
        ? 'Watch override from repo metadata.'
        : 'Watch inherits repo autopilot policy.'),
  };
}

function readRepoAutopilot(repo: RepoConfig | undefined) {
  return readRepoAutopilotConfig(repo) as AutopilotRepoConfig | undefined;
}

function queueItemFromWatch(
  watch: PrWatch,
  policy: WatchAutopilotPolicy | undefined,
  worktrees: WorktreeRecord[],
): AutopilotQueueItem {
  const worktree = worktrees.find(
    (candidate) =>
      candidate.repoId === watch.repoId &&
      candidate.prNumber === watch.prNumber,
  );
  const status = watchStatusToQueueStatus(watch.status, worktree);
  const mode = policy?.mode ?? 'notify-only';

  return {
    id: `watch:${watch.id}`,
    source: 'watch',
    status,
    priority: watchPriority(watch.status, mode),
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    title: watch.title ?? `${watch.repoFullName}#${watch.prNumber}`,
    mode,
    reason: watchReason(watch, mode),
    nextStep: watchNextStep(watch, mode, worktree),
    worktreeId: worktree?.id ?? null,
    runId: null,
    updatedAt: watch.updatedAt,
  };
}

function queueItemFromWorktree(
  worktree: WorktreeRecord,
  policy: RepoAutopilotPolicy | undefined,
): AutopilotQueueItem {
  const status = worktreeStatusToQueueStatus(worktree.lifecycleStatus);
  return {
    id: `worktree:${worktree.id}`,
    source: 'worktree',
    status,
    priority:
      worktree.lifecycleStatus === 'failed' ||
      worktree.lifecycleStatus === 'needs-sync'
        ? 'high'
        : 'normal',
    repoId: worktree.repoId,
    repoFullName: worktree.repoFullName,
    prNumber: worktree.prNumber,
    title: `${worktree.repoFullName}${worktree.prNumber ? `#${worktree.prNumber}` : ''}`,
    mode: policy?.mode ?? 'notify-only',
    reason: `Worktree is ${worktree.lifecycleStatus}.`,
    nextStep: worktreeNextStep(worktree),
    worktreeId: worktree.id,
    runId: worktree.owningWorkflowRunId,
    updatedAt: worktree.updatedAt,
  };
}

function queueItemFromWorkflow(
  run: WorkflowRunRow,
  worktrees: WorktreeRecord[],
): AutopilotQueueItem {
  const related = worktrees.find(
    (worktree) => worktree.owningWorkflowRunId === run.run_id,
  );
  return {
    id: `workflow:${run.run_id}`,
    source: 'workflow',
    status: 'running',
    priority: run.workflow === 'push_pr_autofix' ? 'high' : 'normal',
    repoId: related?.repoId ?? 'unknown',
    repoFullName: related?.repoFullName ?? 'unknown',
    prNumber: related?.prNumber ?? null,
    title: run.workflow,
    mode: 'notify-only',
    reason: run.last_message,
    nextStep: 'Wait for the bounded Flue workflow to finish.',
    worktreeId: related?.id ?? null,
    runId: run.run_id,
    updatedAt: run.last_event_at,
  };
}

function queueItemFromApproval(
  approval: AutopilotApproval,
): AutopilotQueueItem {
  return {
    id: `approval:${approval.id}`,
    source: 'approval',
    status: 'waiting-approval',
    priority: 'high',
    repoId: approval.repoId ?? 'unknown',
    repoFullName: approval.repoFullName ?? 'unknown',
    prNumber: approval.prNumber,
    title: approval.command,
    mode: 'autofix-with-approval',
    reason: approval.reason,
    nextStep:
      'Resolve the pending approval before push-back or checks proceed.',
    worktreeId: null,
    runId: null,
    updatedAt: approval.updatedAt,
  };
}

function preparedDiffFromRecord(
  record: PreparedDiffRecord,
): AutopilotPreparedDiff {
  return {
    id: record.id,
    repoId: record.repoId,
    repoFullName: record.repoFullName,
    prNumber: record.prNumber,
    worktreeId: record.worktreeId,
    localPath: record.sourceWorktreePath,
    title: record.title,
    status: record.status,
    pushApprovalStatus: record.pushApprovalStatus,
    verificationStatus: record.verificationStatus,
    sourceOfTruth: 'worktree',
    summary: preparedDiffSummary(record),
    updatedAt: record.updatedAt,
  };
}

function queueItemFromPreparedDiff(
  record: PreparedDiffRecord,
  policy: RepoAutopilotPolicy | undefined,
): AutopilotQueueItem {
  const waitingApproval =
    record.pushApprovalStatus === 'pending' && record.status === 'prepared';
  return {
    id: `prepared-diff:${record.id}`,
    source: 'worktree',
    status: waitingApproval ? 'waiting-approval' : 'prepared',
    priority: waitingApproval ? 'high' : 'normal',
    repoId: record.repoId,
    repoFullName: record.repoFullName,
    prNumber: record.prNumber,
    title: record.title,
    mode: policy?.mode ?? 'notify-only',
    reason: preparedDiffSummary(record),
    nextStep:
      record.status === 'revision-requested'
        ? 'Revise the prepared worktree diff.'
        : 'Review, verify, approve push, request revision, or abandon.',
    worktreeId: record.worktreeId,
    runId: null,
    updatedAt: record.updatedAt,
  };
}

function approvalFromExecution(
  approval: Awaited<
    ReturnType<typeof listExecutionApprovals>
  >['approvals'][number],
  worktrees: WorktreeRecord[],
): AutopilotApproval {
  const worktree = worktrees.find(
    (candidate) => approval.cwd && candidate.localPath === approval.cwd,
  );
  return {
    id: approval.id,
    repoId: worktree?.repoId ?? null,
    repoFullName: worktree?.repoFullName ?? null,
    prNumber: worktree?.prNumber ?? null,
    command: approval.command,
    risk: approval.risk,
    status: approval.status,
    reason:
      approval.policyDecision === 'ask'
        ? 'Execution policy requires approval.'
        : 'Approval is pending for an autopilot-related command.',
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
  };
}

function approvalFromPreparedDiff(
  approval: PreparedDiffApprovalRecord,
  preparedDiffs: PreparedDiffRecord[],
): AutopilotApproval {
  const preparedDiff = preparedDiffs.find(
    (record) => record.id === approval.preparedDiffId,
  );
  return {
    id: approval.id,
    repoId: preparedDiff?.repoId ?? null,
    repoFullName: preparedDiff?.repoFullName ?? null,
    prNumber: preparedDiff?.prNumber ?? null,
    command: `prepared-diff:${approval.approvalType}`,
    risk:
      approval.approvalType === 'push'
        ? 'push-back'
        : `prepared-diff-${approval.approvalType}`,
    status: approval.status,
    reason:
      approval.reason ??
      `Pending ${approval.approvalType} decision for prepared diff.`,
    createdAt: approval.requestedAt,
    updatedAt: approval.updatedAt,
  };
}

function preparedDiffSummary(record: PreparedDiffRecord) {
  if (record.status === 'push-approved') {
    return 'Push-back approval is recorded; push workflow has not run yet.';
  }
  if (record.status === 'verification-requested') {
    return 'Verification is requested; verify_pr_worktree has not run yet.';
  }
  if (record.status === 'revision-requested') {
    return 'Operator requested a revision to the prepared worktree diff.';
  }
  if (record.status === 'abandoned') {
    return 'Prepared diff was abandoned; source worktree is retained for cleanup policy.';
  }
  return 'Prepared diff is recorded in app state; source worktree is the file-level source of truth.';
}

function runningCheckFromWorkflow(
  run: WorkflowRunRow,
  worktrees: WorktreeRecord[],
): AutopilotRunningCheck {
  const related = worktrees.find(
    (worktree) => worktree.owningWorkflowRunId === run.run_id,
  );
  return {
    id: `running-check:${run.run_id}`,
    runId: run.run_id,
    workflow: run.workflow,
    repoId: related?.repoId ?? null,
    repoFullName: related?.repoFullName ?? null,
    prNumber: related?.prNumber ?? null,
    status: 'running',
    startedAt: run.started_at,
    lastEventAt: run.last_event_at,
    lastMessage: run.last_message,
    runUrl: `/api/flue/runs/${run.run_id}`,
  };
}

function watchStatusToQueueStatus(
  status: string,
  worktree: WorktreeRecord | undefined,
): AutopilotQueueStatus {
  if (worktree?.lifecycleStatus === 'prepared-diff') return 'prepared';
  if (worktree?.lifecycleStatus === 'busy') return 'running';
  if (status === 'attention-needed') return 'queued';
  if (status === 'closed' || status === 'unknown') return 'blocked';
  return 'watching';
}

function worktreeStatusToQueueStatus(
  status: WorktreeLifecycleStatus,
): AutopilotQueueStatus {
  if (status === 'busy') return 'running';
  if (status === 'prepared-diff') return 'prepared';
  if (status === 'failed' || status === 'needs-sync') return 'blocked';
  return 'queued';
}

function watchPriority(status: string, mode: AutopilotMode): AutopilotPriority {
  if (status === 'attention-needed') return 'high';
  if (mode === 'autofix-push-when-safe') return 'normal';
  if (mode === 'notify-only') return 'low';
  return 'normal';
}

function watchReason(watch: PrWatch, mode: AutopilotMode) {
  if (watch.status === 'attention-needed') {
    return 'PR watch needs attention from checks or lifecycle state.';
  }
  if (watch.status === 'green')
    return 'PR watch reached a green terminal state.';
  return `Active PR watch in ${modeLabels[mode].toLowerCase()} mode.`;
}

function watchNextStep(
  watch: PrWatch,
  mode: AutopilotMode,
  worktree: WorktreeRecord | undefined,
) {
  if (worktree?.lifecycleStatus === 'prepared-diff') {
    return 'Review the prepared worktree diff and decide whether to push or revise.';
  }
  if (mode === 'notify-only') return 'Notify on meaningful state changes only.';
  if (watch.status === 'attention-needed') {
    return 'Queue admission will prepare an isolated worktree when Phase 19 workflows land.';
  }
  return 'Keep watching until a meaningful PR delta is detected.';
}

function worktreeNextStep(worktree: WorktreeRecord) {
  switch (worktree.lifecycleStatus) {
    case 'prepared-diff':
      return 'Review or approve the prepared diff.';
    case 'needs-sync':
      return 'Resync after dirty-state or branch drift is resolved.';
    case 'failed':
      return 'Inspect retained worktree and failure events.';
    case 'busy':
      return 'Wait for the current workflow lock to release.';
    default:
      return 'Queue admission can reuse this prepared worktree.';
  }
}

function isAutopilotApproval(
  approval: Awaited<
    ReturnType<typeof listExecutionApprovals>
  >['approvals'][number],
) {
  if (requestContextSource(approval.requestContext) === 'autopilot') {
    return true;
  }
  return false;
}

function requestContextSource(context: unknown) {
  if (!context || typeof context !== 'object' || !('source' in context)) {
    return undefined;
  }
  const source = (context as { source?: unknown }).source;
  return typeof source === 'string' ? source : undefined;
}

function queueSort(a: AutopilotQueueItem, b: AutopilotQueueItem) {
  const priorityRank: Record<AutopilotPriority, number> = {
    urgent: 3,
    high: 2,
    normal: 1,
    low: 0,
  };
  const priorityDelta = priorityRank[b.priority] - priorityRank[a.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

function readActiveAutopilotRuns(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT run_id, workflow, status, started_at, last_event_at, last_message
        FROM workflow_run_observations
        WHERE status = 'active'
        ORDER BY last_event_at DESC
        LIMIT 20;
      `,
      )
      .all()
      .map(readWorkflowRunRow)
      .filter((row) => isAutopilotWorkflow(row.workflow));
  } finally {
    database.close();
  }
}

function readRecentAutopilotWorkflowEvents(
  paths: RuntimePaths,
): AutopilotActivity[] {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT id, run_id, workflow, event_type, message, is_error, summary_json, created_at
        FROM workflow_events
        ORDER BY created_at DESC, id DESC
        LIMIT 120;
      `,
      )
      .all()
      .map(readWorkflowEventRow)
      .filter((row) => row.workflow && isAutopilotWorkflow(row.workflow))
      .slice(0, 20)
      .map((row) => ({
        id: `workflow-event:${row.id}`,
        type: 'workflow',
        level: row.is_error ? 'attention' : 'info',
        title: row.workflow ?? 'autopilot workflow',
        message: row.message,
        repoId: null,
        repoFullName: null,
        prNumber: null,
        createdAt: row.created_at,
      }));
  } finally {
    database.close();
  }
}

function readRecentWorktreeEvents(
  paths: RuntimePaths,
  worktrees: WorktreeRecord[],
): AutopilotActivity[] {
  const byId = new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT id, worktree_id, repo_id, event_type, status, message, created_at
        FROM worktree_events
        ORDER BY created_at DESC
        LIMIT 40;
      `,
      )
      .all()
      .map(readWorktreeEventRow)
      .filter((row) => Boolean(byId.get(row.worktree_id)?.prNumber))
      .slice(0, 20)
      .map((row) => {
        const worktree = byId.get(row.worktree_id);
        return {
          id: `worktree-event:${row.id}`,
          type: 'worktree',
          level: row.status === 'failed' ? 'attention' : 'info',
          title: row.event_type,
          message: row.message,
          repoId: row.repo_id,
          repoFullName: worktree?.repoFullName ?? null,
          prNumber: worktree?.prNumber ?? null,
          createdAt: row.created_at,
        };
      });
  } finally {
    database.close();
  }
}

function readWorkflowRunRow(row: unknown): WorkflowRunRow {
  return v.parse(
    v.object({
      run_id: v.string(),
      workflow: v.string(),
      status: v.string(),
      started_at: v.string(),
      last_event_at: v.string(),
      last_message: v.string(),
    }),
    row,
  );
}

function readWorkflowEventRow(row: unknown): WorkflowEventRow {
  return v.parse(
    v.object({
      id: v.number(),
      run_id: v.nullable(v.string()),
      workflow: v.nullable(v.string()),
      event_type: v.string(),
      message: v.string(),
      is_error: v.number(),
      summary_json: v.nullable(v.string()),
      created_at: v.string(),
    }),
    row,
  );
}

function readWorktreeEventRow(row: unknown): WorktreeEventRow {
  return v.parse(
    v.object({
      id: v.string(),
      worktree_id: v.string(),
      repo_id: v.string(),
      event_type: v.string(),
      status: v.string(),
      message: v.string(),
      created_at: v.string(),
    }),
    row,
  );
}
