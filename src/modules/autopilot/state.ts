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
import { listAutopilotAdmissions } from './admissions';
import { repoFullName } from '../repos';
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
import {
  autopilotStateSchema,
  modeLabels,
  isCheckWorkflow,
  type AutopilotState,
} from './state-schemas';
import {
  approvalFromExecution,
  approvalFromPreparedDiff,
  globalPolicy,
  isAutopilotApproval,
  preparedDiffFromRecord,
  queueItemFromApproval,
  queueItemFromPreparedDiff,
  queueItemFromWatch,
  queueItemFromWorkflow,
  queueItemFromWorktree,
  queueSort,
  repoPolicy,
  runningCheckFromWorkflow,
  watchPolicy,
} from './state-mappers';
import {
  readActiveAutopilotRuns,
  readRecentAutopilotWorkflowEvents,
  readRecentWorktreeEvents,
} from './state-store';

export { autopilotStateSchema } from './state-schemas';

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
    admissions,
  ] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
    listPrWatchRecords(paths),
    listWorktrees(paths),
    listPreparedDiffs({}, paths),
    listExecutionApprovals(paths, { includeResolved: false }),
    listNotifications(paths, { includeResolved: true }),
    listAutopilotAdmissions(paths),
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
    .map((run) =>
      runningCheckFromWorkflow(run, worktrees, appConfig.localApi?.token),
    );
  const preparedDiffs = (preparedDiffSnapshot.preparedDiffs ?? []).map(
    (record) => preparedDiffFromRecord(record, paths),
  );
  const failedChecks = preparedDiffs.filter(
    (diff) => diff.verificationStatus === 'failed',
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
  const unreadNotifications = notifications.filter(
    (notification) =>
      notification.source === 'autopilot' &&
      !notification.resolvedAt &&
      !notification.readAt,
  );
  const queue = [
    ...admissions.map((admission) => ({
      id: admission.id,
      source: 'admission' as const,
      watchId: admission.watchId,
      status:
        admission.state === 'prepared'
          ? ('prepared' as const)
          : admission.state === 'blocked' ||
              admission.state === 'failed' ||
              admission.state === 'manual-review'
            ? ('blocked' as const)
            : admission.state.endsWith('admitted')
              ? ('running' as const)
              : ('queued' as const),
      priority: 'normal' as const,
      repoId: admission.repoId,
      repoFullName:
        (repos.find((repo) => repo.id === admission.repoId)
          ? repoFullName(repos.find((repo) => repo.id === admission.repoId)!)
          : undefined) ?? admission.repoId,
      prNumber: admission.prNumber,
      title: `${admission.currentWorkflow ?? admission.state} for PR #${admission.prNumber}`,
      mode: admission.mode,
      reason: admission.lastError ?? `Durable admission is ${admission.state}.`,
      nextStep:
        admission.currentWorkflow ?? 'Await the next autopilot admission.',
      worktreeId: admission.worktreeId,
      runId: admission.currentRunId,
      updatedAt: admission.updatedAt,
    })),
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
      unreadNotifications: unreadNotifications.length,
      failedChecks: failedChecks.length,
      recentActivity: recentActivity.length,
      placeholderAdapters: [
        'Durable admission rows are included with watches, worktrees, approvals, and Flue observations.',
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
