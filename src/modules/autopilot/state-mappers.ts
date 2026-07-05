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
  normalizeAutopilotMode,
  readRepoAutopilotConfig,
  type AutopilotConcurrencyPolicy,
  type AutopilotMode,
  type AutopilotModeAlias,
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
import { tryKiloTask } from '../kilo';
import {
  listWorktrees,
  type WorktreeLifecycleStatus,
  type WorktreeRecord,
} from '../worktrees';
import {
  type AutopilotActivity,
  type AutopilotApproval,
  type AutopilotPolicyConfig,
  type AutopilotPreparedDiff,
  type AutopilotPriority,
  type AutopilotQueueItem,
  type AutopilotQueueStatus,
  type AutopilotRepoConfig,
  type AutopilotRunningCheck,
  type RepoAutopilotPolicy,
  type WatchAutopilotPolicy,
  type WorkflowRunRow,
  modeLabels,
} from './state-schemas';

export function globalPolicy(appConfig: unknown): AutopilotPolicyConfig {
  return globalAutopilotPolicy(appConfig);
}

export function repoPolicy(
  repo: RepoConfig,
  appConfig: unknown,
): RepoAutopilotPolicy {
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

export function watchPolicy(
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

export function readRepoAutopilot(repo: RepoConfig | undefined) {
  return readRepoAutopilotConfig(repo) as AutopilotRepoConfig | undefined;
}

export function queueItemFromWatch(
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

export function queueItemFromWorktree(
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

export function queueItemFromWorkflow(
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

export function queueItemFromApproval(
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

export function preparedDiffFromRecord(
  record: PreparedDiffRecord,
  paths: RuntimePaths,
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
    revisionRun: revisionRunFromPreparedDiff(record, paths),
    updatedAt: record.updatedAt,
  };
}

export function queueItemFromPreparedDiff(
  record: PreparedDiffRecord,
  policy: RepoAutopilotPolicy | undefined,
): AutopilotQueueItem {
  const waitingApproval =
    record.pushApprovalStatus === 'pending' && record.status === 'prepared';
  const runningRevision = record.status === 'revision-in-progress';
  return {
    id: `prepared-diff:${record.id}`,
    source: 'worktree',
    status: runningRevision
      ? 'running'
      : waitingApproval
        ? 'waiting-approval'
        : 'prepared',
    priority: waitingApproval || runningRevision ? 'high' : 'normal',
    repoId: record.repoId,
    repoFullName: record.repoFullName,
    prNumber: record.prNumber,
    title: record.title,
    mode: policy?.mode ?? 'notify-only',
    reason: preparedDiffSummary(record),
    nextStep:
      record.status === 'revision-requested'
        ? 'Revise the prepared worktree diff.'
        : record.status === 'revision-in-progress'
          ? 'Wait for the revision Kilo task to finish.'
        : 'Review, verify, approve push, request revision, or abandon.',
    worktreeId: record.worktreeId,
    runId: null,
    updatedAt: record.updatedAt,
  };
}

export function approvalFromExecution(
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
    source: 'execution',
    preparedDiffId: null,
    approvalType: null,
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

export function approvalFromPreparedDiff(
  approval: PreparedDiffApprovalRecord,
  preparedDiffs: PreparedDiffRecord[],
): AutopilotApproval {
  const preparedDiff = preparedDiffs.find(
    (record) => record.id === approval.preparedDiffId,
  );
  return {
    id: approval.id,
    source: 'prepared-diff',
    preparedDiffId: approval.preparedDiffId,
    approvalType: approval.approvalType,
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

export function preparedDiffSummary(record: PreparedDiffRecord) {
  if (record.status === 'push-approved') {
    return 'Push-back approval is recorded; push workflow has not run yet.';
  }
  if (record.status === 'verification-requested') {
    return 'Verification is requested; verify_pr_worktree has not run yet.';
  }
  if (record.status === 'revision-requested') {
    return 'Operator requested a revision to the prepared worktree diff.';
  }
  if (record.status === 'revision-in-progress') {
    return 'Revision run is active; a Kilo task is editing the retained worktree.';
  }
  if (record.status === 'abandoned') {
    return 'Prepared diff was abandoned; source worktree is retained for cleanup policy.';
  }
  return 'Prepared diff is recorded in app state; source worktree is the file-level source of truth.';
}

function revisionRunFromPreparedDiff(
  record: PreparedDiffRecord,
  paths: RuntimePaths,
) {
  const summary = objectField(record.summary);
  const revisionRun = objectField(summary.revisionRun);
  const kiloTaskId = stringField(revisionRun.kiloTaskId);
  const task = kiloTaskId ? tryKiloTask(kiloTaskId, paths) : undefined;
  if (!kiloTaskId && Object.keys(revisionRun).length === 0) return null;
  return {
    kiloTaskId: kiloTaskId ?? null,
    reason: stringField(revisionRun.reason) ?? stringField(summary.revisionReason) ?? null,
    startedAt: stringField(revisionRun.startedAt) ?? null,
    completedAt: stringField(revisionRun.completedAt) ?? null,
    outcome: stringField(revisionRun.outcome) ?? null,
    status: task?.status ?? stringField(revisionRun.status) ?? null,
    title: task?.title ?? stringField(revisionRun.title) ?? null,
    cwd: task?.cwd ?? stringField(revisionRun.cwd) ?? null,
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function runningCheckFromWorkflow(
  run: WorkflowRunRow,
  worktrees: WorktreeRecord[],
  localApiToken?: string,
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
    runUrl: flueRunInspectionUrl(run.run_id, localApiToken),
  };
}

export function watchStatusToQueueStatus(
  status: string,
  worktree: WorktreeRecord | undefined,
): AutopilotQueueStatus {
  if (worktree?.lifecycleStatus === 'prepared-diff') return 'prepared';
  if (worktree?.lifecycleStatus === 'busy') return 'running';
  if (status === 'attention-needed') return 'queued';
  if (status === 'closed' || status === 'unknown') return 'blocked';
  return 'watching';
}

export function worktreeStatusToQueueStatus(
  status: WorktreeLifecycleStatus,
): AutopilotQueueStatus {
  if (status === 'busy') return 'running';
  if (status === 'prepared-diff') return 'prepared';
  if (status === 'failed' || status === 'needs-sync') return 'blocked';
  return 'queued';
}

export function watchPriority(
  status: string,
  mode: AutopilotMode,
): AutopilotPriority {
  if (status === 'attention-needed') return 'high';
  if (mode === 'autofix-push-when-safe') return 'normal';
  if (mode === 'notify-only') return 'low';
  return 'normal';
}

export function watchReason(watch: PrWatch, mode: AutopilotMode) {
  if (watch.status === 'attention-needed') {
    return 'PR watch needs attention from checks or lifecycle state.';
  }
  if (watch.status === 'green')
    return 'PR watch reached a green terminal state.';
  return `Active PR watch in ${modeLabels[mode].toLowerCase()} mode.`;
}

export function watchNextStep(
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

export function worktreeNextStep(worktree: WorktreeRecord) {
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

export function isAutopilotApproval(
  approval: Awaited<
    ReturnType<typeof listExecutionApprovals>
  >['approvals'][number],
) {
  if (requestContextSource(approval.requestContext) === 'autopilot') {
    return true;
  }
  return false;
}

export function requestContextSource(context: unknown) {
  if (!context || typeof context !== 'object' || !('source' in context)) {
    return undefined;
  }
  const source = (context as { source?: unknown }).source;
  return typeof source === 'string' ? source : undefined;
}

export function queueSort(a: AutopilotQueueItem, b: AutopilotQueueItem) {
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
