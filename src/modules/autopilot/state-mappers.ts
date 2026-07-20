/* eslint-disable no-unused-vars */
import { defineTool } from '@flue/runtime';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { listExecutionApprovals } from '../execution';
import { flueRunInspectionUrl } from '../runtime';
import {
  globalAutopilotPolicy,
  globalRepoGuardrails,
  mergeAutopilotConcurrency,
  readRepoAutopilotConfig,
  repoGuardrails,
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
  type AppConfig,
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
  type AutopilotRepoConfig,
  type AutopilotRunningCheck,
  type RepoAutopilotPolicy,
  type WatchAutopilotPolicy,
  type WorkflowRunRow,
  modeLabels,
} from './state-schemas';

export function globalPolicy(appConfig: unknown): AutopilotPolicyConfig {
  return {
    ...globalAutopilotPolicy(appConfig),
    limits: globalRepoGuardrails(appConfig),
  };
}

export function repoPolicy(
  repo: RepoConfig,
  appConfig: AppConfig,
): RepoAutopilotPolicy {
  const global = globalPolicy(appConfig);
  const repoAutopilot = readRepoAutopilot(repo);
  const mode = repoAutopilot?.mode ?? global.mode;
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
    limits: repoGuardrails(repo, appConfig),
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
  const mode = override?.mode ?? inheritedMode;

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
  const reason =
    stringField(revisionRun.reason) ?? stringField(summary.revisionReason);
  const task = kiloTaskId ? tryKiloTask(kiloTaskId, paths) : undefined;
  if (!kiloTaskId && !reason && Object.keys(revisionRun).length === 0) {
    return null;
  }
  return {
    kiloTaskId: kiloTaskId ?? null,
    reason: reason ?? null,
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
