/* eslint-disable no-unused-vars */
import { defineTool } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { listExecutionApprovals } from '../execution';
import { flueRunInspectionUrl } from '../runtime';
import {
  globalAutopilotPolicy,
  mergeAutopilotConcurrency,
  mergeAutopilotLimits,
  readRepoAutopilotConfig,
  type AutopilotConcurrencyPolicy,
  type AutopilotMode,
  type AutopilotPolicyLimits,
} from '../autopilot-policy';
import {
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
  type RepoConfig,
  type RuntimePaths,
} from '../../runtime-home';
import { listNotifications, type NotificationLevel } from '../app-state';
import {
  listPreparedDiffs,
  type PreparedDiffApprovalRecord,
  type PreparedDiffRecord,
  type PreparedDiffStatus,
} from '../prepared-diffs';
import { listPrWatchRecords, type PrWatch } from '../watches';
import {
  listWorktrees,
  type WorktreeLifecycleStatus,
  type WorktreeRecord,
} from '../worktrees';

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
  source: 'admission' | 'watch' | 'worktree' | 'workflow' | 'approval';
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
  revisionRun: AutopilotPreparedDiffRevisionRun | null;
  updatedAt: string;
};

export type AutopilotPreparedDiffRevisionRun = {
  kiloTaskId: string | null;
  reason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  outcome: string | null;
  status: string | null;
  title: string | null;
  cwd: string | null;
};

export type AutopilotApproval = {
  id: string;
  source: 'execution' | 'prepared-diff';
  preparedDiffId: string | null;
  approvalType: 'push' | 'revision' | 'abandon' | 'verification' | null;
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
    unreadNotifications: number;
    failedChecks: number;
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

export type AutopilotRepoConfig = Partial<{
  mode: AutopilotMode;
  reason: string;
  limits: Partial<AutopilotPolicyLimits>;
  concurrency: Partial<AutopilotConcurrencyPolicy>;
  watchOverrides: Array<{
    watchId?: string;
    prNumber?: number;
    mode?: AutopilotMode;
    reason?: string;
  }>;
}>;

export type WorkflowRunRow = {
  run_id: string;
  workflow: string;
  status: string;
  started_at: string;
  last_event_at: string;
  last_message: string;
};

export type WorkflowEventRow = {
  id: number;
  run_id: string | null;
  workflow: string | null;
  event_type: string;
  message: string;
  is_error: number;
  summary_json: string | null;
  created_at: string;
};

export type WorktreeEventRow = {
  id: string;
  worktree_id: string;
  repo_id: string;
  event_type: string;
  status: string;
  message: string;
  created_at: string;
};

export const modeLabels: Record<AutopilotMode, string> = {
  'notify-only': 'Notify only',
  'prepare-only': 'Prepare only',
  'autofix-with-approval': 'Autofix with approval',
  'autofix-push-when-safe': 'Autofix push when safe',
};

export const autopilotModeOutputSchema = v.picklist([
  'notify-only',
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
]);
export const policyLimitsOutputSchema = v.object({
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
export const concurrencyOutputSchema = v.object({
  maxAutonomousJobs: v.number(),
  maxActiveWorkflowRuns: v.number(),
  maxPerRepoAutonomousJobs: v.number(),
  singleMutationPerPr: v.boolean(),
  localExecutionLimit: v.number(),
});
export const queueItemSchema = v.object({
  id: v.string(),
  source: v.picklist([
    'admission',
    'watch',
    'worktree',
    'workflow',
    'approval',
  ]),
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
export const repoPolicySchema = v.object({
  repoId: v.string(),
  repoFullName: v.string(),
  mode: autopilotModeOutputSchema,
  source: v.picklist(['global-default', 'repo-metadata']),
  reason: v.string(),
  limits: policyLimitsOutputSchema,
  concurrency: concurrencyOutputSchema,
});
export const watchPolicySchema = v.object({
  watchId: v.string(),
  repoId: v.string(),
  repoFullName: v.string(),
  prNumber: v.number(),
  mode: autopilotModeOutputSchema,
  source: v.picklist(['repo-policy', 'watch-override']),
  reason: v.string(),
});
export const preparedDiffSchema = v.object({
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
    'revision-in-progress',
    'push-approved',
    'push-blocked',
    'pushed',
    'abandoned',
  ]),
  pushApprovalStatus: v.string(),
  verificationStatus: v.string(),
  sourceOfTruth: v.literal('worktree'),
  summary: v.string(),
  revisionRun: v.nullable(
    v.object({
      kiloTaskId: v.nullable(v.string()),
      reason: v.nullable(v.string()),
      startedAt: v.nullable(v.string()),
      completedAt: v.nullable(v.string()),
      outcome: v.nullable(v.string()),
      status: v.nullable(v.string()),
      title: v.nullable(v.string()),
      cwd: v.nullable(v.string()),
    }),
  ),
  updatedAt: v.string(),
});
export const approvalSchema = v.object({
  id: v.string(),
  source: v.picklist(['execution', 'prepared-diff']),
  preparedDiffId: v.nullable(v.string()),
  approvalType: v.nullable(
    v.picklist(['push', 'revision', 'abandon', 'verification']),
  ),
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
export const runningCheckSchema = v.object({
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
export const activitySchema = v.object({
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
    unreadNotifications: v.number(),
    failedChecks: v.number(),
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

export const autopilotWorkflowNames = new Set([
  'triage-pr-event',
  'prepare-pr-worktree',
  'fix-pr-review-feedback',
  'fix-pr-ci',
  'ci-fix-run',
  'fix-pr-ci-failure',
  'verify-pr-worktree',
  'push-pr-autofix',
  'verify-then-push-pr-autofix',
  'comment-pr-autofix-result',
  'cleanup-autopilot-worktree',
]);
export const checkWorkflowNames = new Set([
  'verify-pr-worktree',
  'verify-then-push-pr-autofix',
]);

export function normalizeWorkflowName(workflow: string) {
  return workflow.replaceAll('_', '-');
}

export function isAutopilotWorkflow(workflow: string) {
  return autopilotWorkflowNames.has(normalizeWorkflowName(workflow));
}

export function isCheckWorkflow(workflow: string) {
  return checkWorkflowNames.has(normalizeWorkflowName(workflow));
}
