import { createHash } from 'node:crypto';
import type { JsonValue } from '@flue/runtime';
import { type JobRecord, type NotificationLevel } from '../app-state';
import { fetchCheckSummary, type GitHubCheckSummary } from '../github';
import { runDocsDriftJob } from '../docs-drift';
import { runIssueTriageJob } from '../issue-triage';
import { runHygieneJob } from '../hygiene';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  checkAutopilotConcurrency,
  repoAutopilotPolicyForWatch,
  type AutopilotMode,
} from '../autopilot-policy';
import {
  listPrWatchEventWatermarks,
  refreshPrWatchEventState,
  type PrWatchEventWatermarkCategory,
  type PrWatchEventWatermarkRecord,
} from '../pr-events';
import type { RuntimePaths } from '../../runtime-home';
import { parseAppConfig, readRuntimeJson } from '../../runtime-home';
import {
  listPrWatchRecords,
  listRefWatchRecords,
  type PrWatch,
  refreshPrWatch,
  refreshRefWatch,
} from '../watches';
import type {
  BlueprintKind,
  JobExecutionResult,
  SchedulerDependencies,
  ScheduledWorkflowName,
} from './schemas';
import { errorMessage, failResult } from './utils';

export async function executeJob(
  job: JobRecord,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
): Promise<JobExecutionResult> {
  if (job.type === 'watch-pr') {
    return refreshWatchJob(job, paths, dependencies);
  }

  if (job.type === 'watch-ref') {
    return refreshRefWatchJob(job, paths, dependencies.refreshRefWatch);
  }

  if (job.type === 'morning-briefing') {
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('briefing', {});

    return {
      outcome: 'recorded',
      message: `Admitted morning briefing workflow ${runId}.`,
      result: { runId },
      notifications: [
        {
          level: 'info',
          title: 'Morning briefing queued',
          message: 'A morning briefing workflow was queued for Neon.',
          source: 'scheduler',
          sourceId: job.id,
          data: { runId },
        },
      ],
    };
  }

  if (job.type === 'review-queue-digest') {
    const invokeWorkflow =
      dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
    const { runId } = await invokeWorkflow('command-run', {
      command: '/review-queue',
    });

    return {
      outcome: 'recorded',
      message: `Admitted review queue digest workflow ${runId}.`,
      result: { runId },
      notifications: [
        {
          level: 'info',
          title: 'Review queue digest due',
          message: 'A review queue digest workflow was queued.',
          source: 'scheduler',
          sourceId: job.id,
          data: { runId },
        },
      ],
    };
  }

  if (job.type === 'docs-drift') {
    return runDocsDriftJob(job, paths);
  }

  if (job.type === 'issue-triage') {
    return runIssueTriageJob(job, paths);
  }

  if (job.type === 'hygiene') {
    return runHygieneJob(job, paths);
  }

  if (job.type === 'release-watch') {
    return refreshReleaseWatchJob(job, paths, dependencies.fetchCheckSummary);
  }

  return {
    outcome: 'silent',
    message: `No executor is registered for job type "${job.type}".`,
  };
}

export async function invokeScheduledWorkflow(
  workflow: ScheduledWorkflowName,
  input: JsonValue,
) {
  const { invoke } = await import('@flue/runtime');

  if (workflow === 'briefing') {
    const module = await import('../../workflows/briefing');
    return invoke(module.default, { input: input as Record<string, never> });
  }

  if (workflow === 'triage-pr-event') {
    const module = await import('../../workflows/triage-pr-event');
    return invoke(module.default, {
      input: input as never,
    });
  }

  const module = await import('../../workflows/command-run');
  return invoke(module.default, {
    input: input as { command: string },
  });
}

export async function refreshReleaseWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  fetchChecks: typeof fetchCheckSummary = fetchCheckSummary,
): Promise<JobExecutionResult> {
  const registry = await readRepoRegistrySnapshot(paths);
  const config = readObjectConfig(job.config);
  const repoRef = typeof config.repo === 'string' ? config.repo : undefined;
  const sourceWatchId =
    typeof config.sourceWatchId === 'string' ? config.sourceWatchId : undefined;
  let sourceWatch:
    Awaited<ReturnType<typeof listPrWatchRecords>>[number] | undefined;
  const repo = repoRef
    ? registry.repos.find(
        (item) =>
          item.id === repoRef ||
          item.github.name === repoRef ||
          repoFullName(item).toLowerCase() === repoRef.toLowerCase(),
      )
    : undefined;

  if (!repo) {
    return {
      outcome: 'failed',
      message: repoRef
        ? `Release watch repository "${repoRef}" is not configured.`
        : 'Release watch requires a configured repository.',
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: repoRef
            ? `Repository "${repoRef}" is not configured.`
            : 'Release watch requires a repository.',
          source: 'release-watch',
          sourceId: job.id,
          data: job.config,
        },
      ],
    };
  }

  if (sourceWatchId) {
    sourceWatch = (await listPrWatchRecords(paths)).find(
      (watch) => watch.id === sourceWatchId,
    );
    if (!sourceWatch) {
      return {
        outcome: 'failed',
        message: `Linked PR watch "${sourceWatchId}" does not exist.`,
        notifications: [
          {
            level: 'attention',
            title: 'Release watch failed',
            message: `Linked PR watch "${sourceWatchId}" does not exist.`,
            source: 'release-watch',
            sourceId: job.id,
            data: job.config,
          },
        ],
      };
    }
    if (!['merged', 'green'].includes(sourceWatch.status)) {
      return {
        outcome: 'silent',
        message: `Release watch is waiting for PR watch "${sourceWatchId}" to merge.`,
        result: {
          repo: repo.id,
          sourceWatchId,
          sourceWatchStatus: sourceWatch.status,
        },
      };
    }
    if (!sourceWatch.mergeCommitSha) {
      return {
        outcome: 'failed',
        message: `Linked PR watch "${sourceWatchId}" has no merge commit SHA.`,
        notifications: [
          {
            level: 'attention',
            title: 'Release watch failed',
            message: `Linked PR watch "${sourceWatchId}" has no merge commit SHA.`,
            source: 'release-watch',
            sourceId: job.id,
            data: job.config,
          },
        ],
      };
    }
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return {
      outcome: 'failed',
      message: 'GITHUB_TOKEN is not configured.',
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: 'GITHUB_TOKEN is not configured.',
          source: 'release-watch',
          sourceId: job.id,
          data: { repo: repo.id, requires: ['GITHUB_TOKEN'] },
        },
      ],
    };
  }

  try {
    const ref = sourceWatch?.mergeCommitSha ?? repo.defaultBranch;
    const checks = await fetchChecks({
      token,
      owner: repo.github.owner,
      repo: repo.github.name,
      ref,
    });
    const snapshot = {
      repo: repo.id,
      repoFullName: repoFullName(repo),
      defaultBranch: repo.defaultBranch,
      ref,
      sourceWatchId: sourceWatch?.id ?? null,
      sourceMergeCommitSha: sourceWatch?.mergeCommitSha ?? null,
      productionTarget: repo.productionTarget ?? null,
      checks,
      checkedAt: new Date().toISOString(),
    };
    const previous = readReleaseWatchResult(job.lastResult);
    const statusChanged = previous?.checks.status !== checks.status;
    const shouldNotify =
      statusChanged &&
      (checks.status === 'success' || checks.status === 'failure');

    return {
      outcome: statusChanged ? 'updated' : 'silent',
      message: statusChanged
        ? `Release watch ${repo.id} ${ref} is ${checks.status}.`
        : `Release watch ${repo.id} ${ref} is unchanged.`,
      result: snapshot,
      notifications: shouldNotify
        ? [releaseWatchNotification(job, snapshot)]
        : undefined,
    };
  } catch (error) {
    return {
      outcome: 'failed',
      message: `Could not fetch release watch checks: ${errorMessage(error)}.`,
      notifications: [
        {
          level: 'attention',
          title: 'Release watch failed',
          message: `Could not fetch checks for ${repoFullName(repo)}@${sourceWatch?.mergeCommitSha ?? repo.defaultBranch}.`,
          source: 'release-watch',
          sourceId: job.id,
          data: { error: errorMessage(error), repo: repo.id },
        },
      ],
    };
  }
}

export function releaseWatchNotification(
  job: JobRecord,
  snapshot: {
    repo: string;
    repoFullName: string;
    defaultBranch: string;
    ref: string;
    sourceWatchId: string | null;
    sourceMergeCommitSha: string | null;
    productionTarget: string | null;
    checks: GitHubCheckSummary;
    checkedAt: string;
  },
) {
  const failed = snapshot.checks.status === 'failure';
  const titleTarget = snapshot.sourceMergeCommitSha
    ? 'merge commit'
    : snapshot.defaultBranch;
  return {
    level: failed ? ('urgent' as const) : ('ready' as const),
    title: failed
      ? 'Release watch needs attention'
      : `Release watch ${titleTarget} green`,
    message: failed
      ? `${snapshot.repoFullName}@${snapshot.ref} checks failed.`
      : `${snapshot.repoFullName}@${snapshot.ref} checks are green.`,
    source: 'release-watch',
    sourceId: job.id,
    data: snapshot,
  };
}

export function readReleaseWatchResult(value: JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const checks = (value as { checks?: unknown }).checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) {
    return undefined;
  }
  const status = (checks as { status?: unknown }).status;
  return typeof status === 'string'
    ? { checks: { status } as GitHubCheckSummary }
    : undefined;
}

export async function refreshWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies = {},
): Promise<JobExecutionResult> {
  const refreshWatch = dependencies.refreshPrWatch ?? refreshPrWatch;
  const config = readObjectConfig(job.config);
  const target =
    typeof config.id === 'string'
      ? { id: config.id }
      : typeof config.ref === 'string'
        ? { ref: config.ref }
        : undefined;

  const results = [];
  if (target) {
    results.push(await refreshWatch(target, paths));
  } else {
    const watches = await listPrWatchRecords(paths);
    for (const watch of watches) {
      results.push(await refreshWatch({ id: watch.id }, paths));
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    const pendingEventResults = pendingEventResultsFromJobResult(
      job.lastResult,
    );
    return {
      outcome: 'failed',
      message: `Failed to refresh ${failures.length} PR watch${failures.length === 1 ? '' : 'es'}.`,
      result: {
        results,
        ...(pendingEventResults.length > 0
          ? { eventResults: pendingEventResults }
          : {}),
      },
      notifications: failures.map((result) => ({
        level: 'attention',
        title: 'PR watch refresh failed',
        message: result.message,
        source: 'watch-pr',
        sourceId: failedWatchSourceId(result, target),
        data: result,
      })),
    };
  }

  const eventResults = await refreshWatchJobEvents(
    results,
    paths,
    dependencies,
    job.lastResult,
  );
  const eventFailures = eventResults.filter((result) => !result.ok);
  const changed = results.filter((result) => result.changed);
  const notifications: NonNullable<JobExecutionResult['notifications']> =
    changed.map((result) => {
      const watch = result.watch as
        { id?: string; status?: string } | undefined;
      const level: NotificationLevel =
        watch?.status === 'closed' || watch?.status === 'attention-needed'
          ? 'attention'
          : watch?.status === 'merged' || watch?.status === 'green'
            ? 'ready'
            : 'info';
      const title =
        watch?.status === 'green'
          ? 'PR watch green'
          : watch?.status === 'attention-needed'
            ? 'PR watch needs attention'
            : watch?.status === 'merged'
              ? 'PR watch merged'
              : watch?.status === 'closed'
                ? 'PR watch closed'
                : 'PR watch changed';

      return {
        level,
        title,
        message: result.message,
        source: 'watch-pr',
        sourceId: watch?.id,
        data: result.watch,
      };
    });
  notifications.push(
    ...eventResults.flatMap((result) => result.notifications ?? []),
  );

  const eventChanges = eventResults.filter(
    (result) => result.ok && result.changed,
  );
  return {
    outcome:
      eventFailures.length > 0
        ? 'failed'
        : changed.length > 0 || eventChanges.length > 0
          ? 'updated'
          : 'silent',
    message: watchRefreshMessage(
      changed.length,
      eventChanges.length,
      eventFailures.length,
    ),
    result: {
      results,
      ...(eventResults.length > 0 ? { eventResults } : {}),
    },
    notifications,
  };
}

function watchRefreshMessage(
  watchChanges: number,
  eventChanges: number,
  eventFailures: number,
) {
  if (eventFailures > 0) {
    return `Failed to refresh ${eventFailures} PR event watch${eventFailures === 1 ? '' : 'es'}.`;
  }
  if (watchChanges > 0 && eventChanges > 0) {
    return `Updated ${watchChanges} PR watch${watchChanges === 1 ? '' : 'es'} and ${eventChanges} PR event watch${eventChanges === 1 ? '' : 'es'}.`;
  }
  if (watchChanges > 0) {
    return `Updated ${watchChanges} PR watch${watchChanges === 1 ? '' : 'es'}.`;
  }
  if (eventChanges > 0) {
    return `Updated ${eventChanges} PR event watch${eventChanges === 1 ? '' : 'es'}.`;
  }
  return 'PR watch refresh had no changes.';
}

type WatchJobEventResult = {
  ok: boolean;
  changed: boolean;
  watchId: string;
  repoId: string;
  repoFullName: string;
  prNumber: number;
  mode?: AutopilotMode;
  changedCategories?: PrWatchEventWatermarkCategory[];
  deltas?: JsonValue[];
  message: string;
  refresh?: JsonValue;
  triage?: JsonValue;
  notifications?: JobExecutionResult['notifications'];
};
type PendingWatchTriageEvent = {
  eventId: string;
  input: Record<string, JsonValue>;
  reason: string;
};
type TriageAdmissionResult = {
  ok: boolean;
  changed: boolean;
  triage?: JsonValue;
  notifications: NonNullable<JobExecutionResult['notifications']>;
  message?: string;
};

async function refreshWatchJobEvents(
  results: Awaited<
    ReturnType<NonNullable<SchedulerDependencies['refreshPrWatch']>>
  >[],
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  previousJobResult: JsonValue | null,
): Promise<WatchJobEventResult[]> {
  if (!dependencies.refreshPrWatchEventState && !process.env.GITHUB_TOKEN) {
    return [];
  }

  const pendingByWatch = pendingTriageEventsFromJobResult(previousJobResult);
  const watches = await listPrWatchRecords(paths);
  const watchById = new Map(watches.map((watch) => [watch.id, watch]));
  const targetWatches = results
    .map((result) => watchIdFromResult(result))
    .filter((id): id is string => Boolean(id))
    .map((id) => watchById.get(id))
    .filter((watch): watch is PrWatch => Boolean(watch));

  const eventResults: WatchJobEventResult[] = [];
  for (const watch of targetWatches) {
    eventResults.push(
      await refreshOneWatchEvent(
        watch,
        paths,
        dependencies,
        pendingByWatch.get(watch.id) ?? [],
      ),
    );
  }

  return eventResults;
}

async function refreshOneWatchEvent(
  watch: PrWatch,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  pendingTriageEvents: PendingWatchTriageEvent[],
): Promise<WatchJobEventResult> {
  const listWatermarks =
    dependencies.listPrWatchEventWatermarks ?? listPrWatchEventWatermarks;
  const refreshEvents =
    dependencies.refreshPrWatchEventState ?? refreshPrWatchEventState;
  const previousResult = await listWatermarks({ watchId: watch.id }, paths);
  const previousWatermarks = watermarksFromActionResult(previousResult);
  const refresh = await refreshEvents({ watchId: watch.id }, paths);
  if (!refresh.ok) {
    const triage = triageValue(pendingTriageSnapshots(pendingTriageEvents));
    return {
      ok: false,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      message: refresh.message,
      refresh: refresh as unknown as JsonValue,
      triage,
      notifications: [
        {
          level: 'attention',
          title: 'PR event refresh failed',
          message: refresh.message,
          source: 'watch-pr-events',
          sourceId: watch.id,
          data: refresh,
        },
      ],
    };
  }

  const changedCategories = changedCategoriesFromActionResult(refresh);
  const policy = await readEffectiveWatchAutopilotPolicy(watch, paths);
  const mode = policy.mode;
  if (changedCategories.length === 0) {
    if (pendingTriageEvents.length > 0) {
      if (mode === 'notify-only') {
        return preservedPendingWatchTriage(
          watch,
          pendingTriageEvents,
          refresh as unknown as JsonValue,
          mode,
        );
      }

      return retryPendingWatchTriage(
        watch,
        pendingTriageEvents,
        paths,
        dependencies,
        refresh as unknown as JsonValue,
        mode,
      );
    }

    return {
      ok: true,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      message: refresh.message,
      refresh: refresh as unknown as JsonValue,
    };
  }

  const currentWatermarks = watermarksFromActionResult(refresh);
  if (previousWatermarks.length === 0) {
    return {
      ok: true,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories,
      message: `Seeded PR event watermark baseline for ${watch.id}.`,
      refresh: refresh as unknown as JsonValue,
    };
  }

  const deltas = deltasFromChangedCategories(
    changedCategories,
    currentWatermarks,
    previousWatermarks,
  );
  const current = snapshotFromWatermarks(currentWatermarks);
  const previous = snapshotFromWatermarks(previousWatermarks);
  const notifications: JobExecutionResult['notifications'] = [
    prEventNotification(
      watch,
      changedCategories,
      currentWatermarks,
      deltas,
      mode,
    ),
  ];
  let triage: JsonValue | undefined;

  const triageAttempts: JsonValue[] = [];
  if (pendingTriageEvents.length > 0) {
    if (!shouldRetainPendingTriage(currentWatermarks, deltas)) {
      triageAttempts.push(
        ...supersededPendingTriageSnapshots(pendingTriageEvents, deltas),
      );
    } else if (mode === 'notify-only') {
      triageAttempts.push(...pendingTriageSnapshots(pendingTriageEvents));
    } else {
      const retry = await admitWatchTriageEvents(
        watch,
        paths,
        dependencies,
        pendingTriageEvents.map((event) => event.input),
      );
      notifications.push(...retry.notifications);
      triageAttempts.push(...retry.triage);
      if (!retry.ok) {
        return {
          ok: false,
          changed: true,
          watchId: watch.id,
          repoId: watch.repoId,
          repoFullName: watch.repoFullName,
          prNumber: watch.prNumber,
          mode,
          changedCategories,
          deltas,
          message: retry.message ?? 'Autopilot triage admission failed.',
          refresh: refresh as unknown as JsonValue,
          triage: triageValue(triageAttempts),
          notifications,
        };
      }
    }
  }

  if (
    mode !== 'notify-only' &&
    deltas.length > 0 &&
    shouldAdmitTriageForDeltas(deltas)
  ) {
    const input = jsonRecord({
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      watchId: watch.id,
      eventId: prEventSourceId(watch, changedCategories, currentWatermarks),
      source: 'watch',
      autopilotMode: triageModeForPolicy(mode),
      previous,
      current,
      deltas,
    });
    const admission = await admitWatchTriageEvent(
      watch,
      paths,
      dependencies,
      input,
    );
    notifications.push(...admission.notifications);
    if (admission.triage) triageAttempts.push(admission.triage);
    if (!admission.ok) {
      return {
        ok: false,
        changed: true,
        watchId: watch.id,
        repoId: watch.repoId,
        repoFullName: watch.repoFullName,
        prNumber: watch.prNumber,
        mode,
        changedCategories,
        deltas,
        message: admission.message ?? 'Autopilot triage admission failed.',
        refresh: refresh as unknown as JsonValue,
        triage: triageValue(triageAttempts),
        notifications,
      };
    }
  }
  triage = triageValue(triageAttempts);

  return {
    ok: true,
    changed: true,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    changedCategories,
    deltas,
    message: refresh.message,
    refresh: refresh as unknown as JsonValue,
    triage,
    notifications,
  };
}

function preservedPendingWatchTriage(
  watch: PrWatch,
  pendingEvents: PendingWatchTriageEvent[],
  refresh: JsonValue,
  mode: AutopilotMode,
): WatchJobEventResult {
  return {
    ok: true,
    changed: false,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    message: `Preserved ${pendingEvents.length} pending autopilot triage event${pendingEvents.length === 1 ? '' : 's'} for ${watch.id}.`,
    refresh,
    triage: pendingTriageSnapshots(pendingEvents),
  };
}

async function retryPendingWatchTriage(
  watch: PrWatch,
  pendingEvents: PendingWatchTriageEvent[],
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  refresh: JsonValue,
  mode: AutopilotMode,
): Promise<WatchJobEventResult> {
  const retry = await admitWatchTriageEvents(
    watch,
    paths,
    dependencies,
    pendingEvents.map((event) => event.input),
  );
  if (!retry.ok) {
    return {
      ok: false,
      changed: true,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      message: retry.message ?? 'Autopilot triage admission failed.',
      refresh,
      triage: triageValue(retry.triage),
      notifications: retry.notifications,
    };
  }

  return {
    ok: true,
    changed: retry.triage.length > 0,
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    message:
      retry.triage.length > 0
        ? `Retried ${retry.triage.length} pending autopilot triage event${retry.triage.length === 1 ? '' : 's'} for ${watch.id}.`
        : `No PR event watermark changes for ${watch.id}.`,
    refresh,
    triage: triageValue(retry.triage),
    notifications: retry.notifications,
  };
}

async function admitWatchTriageEvents(
  watch: PrWatch,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  inputs: Array<Record<string, JsonValue>>,
) {
  const notifications: NonNullable<JobExecutionResult['notifications']> = [];
  const triage: JsonValue[] = [];
  let ok = true;
  let message: string | undefined;

  for (const input of inputs) {
    const admission = await admitWatchTriageEvent(
      watch,
      paths,
      dependencies,
      input,
    );
    notifications.push(...admission.notifications);
    if (admission.triage) triage.push(admission.triage);
    if (!admission.ok) {
      ok = false;
      message = admission.message ?? message;
    }
  }

  return { ok, triage, notifications, message };
}

async function admitWatchTriageEvent(
  watch: PrWatch,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  input: Record<string, JsonValue>,
): Promise<TriageAdmissionResult> {
  const eventId = stringField(input.eventId) ?? 'unknown';
  const concurrencyCheck =
    dependencies.checkAutopilotConcurrency ?? checkAutopilotConcurrency;
  const concurrency = await concurrencyCheck(
    {
      repoId: watch.repoId,
      prNumber: watch.prNumber,
      workflow: 'triage-pr-event',
      mutation: false,
    },
    paths,
  );

  if (!concurrency.allowed) {
    return {
      ok: true,
      changed: true,
      triage: {
        status: 'blocked',
        eventId,
        reason: concurrency.message,
        input,
        concurrency,
      } as unknown as JsonValue,
      notifications: [
        {
          level: 'attention',
          title: 'Autopilot triage blocked',
          message: concurrency.message,
          source: 'autopilot',
          sourceId: `triage:${watch.id}:${eventId}:blocked`,
          data: {
            watchId: watch.id,
            repoId: watch.repoId,
            repoFullName: watch.repoFullName,
            prNumber: watch.prNumber,
            eventId,
            input,
            concurrency,
          },
        },
      ],
    };
  }

  const invokeWorkflow = dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
  try {
    const { runId } = await invokeWorkflow('triage-pr-event', input);
    return {
      ok: true,
      changed: true,
      triage: {
        status: 'admitted',
        eventId,
        runId,
        workflow: 'triage-pr-event',
        input,
      } as unknown as JsonValue,
      notifications: [],
    };
  } catch (error) {
    const message = `Autopilot triage admission failed: ${errorMessage(error)}.`;
    return {
      ok: false,
      changed: true,
      message,
      triage: {
        status: 'failed',
        eventId,
        input,
        error: errorMessage(error),
      } as unknown as JsonValue,
      notifications: [
        {
          level: 'attention',
          title: 'Autopilot triage failed',
          message,
          source: 'autopilot',
          sourceId: `triage:${watch.id}:${eventId}:failed`,
          data: {
            watchId: watch.id,
            repoId: watch.repoId,
            repoFullName: watch.repoFullName,
            prNumber: watch.prNumber,
            eventId,
            input,
            error: errorMessage(error),
          },
        },
      ],
    };
  }
}

function pendingEventResultsFromJobResult(value: JsonValue | null) {
  return readJsonArray(readObjectConfig(value).eventResults).filter(
    (eventResult) => pendingTriageEventsFromEventResult(eventResult).length > 0,
  );
}

function pendingTriageEventsFromJobResult(value: JsonValue | null) {
  const pendingByWatch = new Map<string, PendingWatchTriageEvent[]>();
  const eventResults = readJsonArray(readObjectConfig(value).eventResults);
  for (const eventResult of eventResults) {
    for (const triageEvent of pendingTriageEventsFromEventResult(eventResult)) {
      const pending = pendingByWatch.get(triageEvent.watchId) ?? [];
      if (!pending.some((item) => item.eventId === triageEvent.eventId)) {
        pending.push({
          eventId: triageEvent.eventId,
          input: triageEvent.input,
          reason: triageEvent.reason,
        });
      }
      pendingByWatch.set(triageEvent.watchId, pending);
    }
  }

  return pendingByWatch;
}

function pendingTriageEventsFromEventResult(value: unknown) {
  const result = readObjectConfig(value);
  const watchId = stringField(result.watchId);
  if (!watchId) return [];

  return triageRecords(result.triage)
    .map((triage) => pendingTriageEventFromRecord(watchId, triage))
    .filter((event): event is PendingWatchTriageEvent & { watchId: string } =>
      Boolean(event),
    );
}

function pendingTriageEventFromRecord(
  watchId: string,
  triage: Record<string, unknown>,
) {
  const status = stringField(triage.status);
  if (status !== 'blocked' && status !== 'failed') return null;

  const input = readJsonRecord(triage.input);
  if (!input) return null;

  return {
    watchId,
    eventId: stringField(input.eventId) ?? `${watchId}:pending`,
    input,
    reason: status,
  };
}

function triageRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => triageRecords(item));
  }

  const record = readObjectConfig(value);
  const nested = readObjectConfig(record.triage);
  return Object.keys(nested).length > 0 ? [nested] : [record];
}

function pendingTriageSnapshots(events: PendingWatchTriageEvent[]) {
  return events.map((event) =>
    jsonRecord({
      status: event.reason === 'failed' ? 'failed' : 'blocked',
      eventId: event.eventId,
      reason: event.reason,
      input: event.input,
    }),
  );
}

function supersededPendingTriageSnapshots(
  events: PendingWatchTriageEvent[],
  deltas: Array<Record<string, unknown>>,
) {
  return events.map((event) =>
    jsonRecord({
      status: 'superseded',
      eventId: event.eventId,
      reason: 'current-pr-state-non-actionable',
      input: event.input,
      supersededBy: deltas as unknown as JsonValue,
    }),
  );
}

function triageValue(attempts: JsonValue[]) {
  if (attempts.length === 0) return undefined;
  return attempts.length === 1 ? attempts[0] : (attempts as JsonValue);
}

async function readEffectiveWatchAutopilotPolicy(
  watch: PrWatch,
  paths: RuntimePaths,
) {
  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === watch.repoId,
  );
  if (!repo) {
    return { mode: 'notify-only' as AutopilotMode };
  }

  return repoAutopilotPolicyForWatch(repo, appConfig, {
    id: watch.id,
    prNumber: watch.prNumber,
  });
}

function watchIdFromResult(result: unknown) {
  const watch = readObjectConfig(
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as { watch?: unknown }).watch
      : undefined,
  );
  const id = watch.id;
  return typeof id === 'string' ? id : undefined;
}

function changedCategoriesFromActionResult(result: unknown) {
  const data = dataFromActionResult(result);
  const categories = Array.isArray(data.changedCategories)
    ? data.changedCategories
    : [];
  return categories.filter(isWatermarkCategory);
}

function watermarksFromActionResult(result: unknown) {
  const data = dataFromActionResult(result);
  const watermarks = Array.isArray(data.watermarks) ? data.watermarks : [];
  return watermarks
    .map(readWatermarkLike)
    .filter((item): item is PrWatchEventWatermarkRecord => Boolean(item));
}

function dataFromActionResult(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
  return readObjectConfig((result as { data?: unknown }).data);
}

function readWatermarkLike(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const category = record.category;
  if (!isWatermarkCategory(category)) return null;
  return {
    watchId: typeof record.watchId === 'string' ? record.watchId : '',
    category,
    watermark: (record.watermark ?? null) as JsonValue,
    sourceUpdatedAt:
      typeof record.sourceUpdatedAt === 'string'
        ? record.sourceUpdatedAt
        : null,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  };
}

function isWatermarkCategory(
  value: unknown,
): value is PrWatchEventWatermarkCategory {
  return (
    value === 'commits' ||
    value === 'review_threads' ||
    value === 'requested_changes_reviews' ||
    value === 'check_suites' ||
    value === 'check_runs' ||
    value === 'mergeability' ||
    value === 'out_of_date_branch'
  );
}

function deltasFromChangedCategories(
  categories: PrWatchEventWatermarkCategory[],
  currentWatermarks: PrWatchEventWatermarkRecord[],
  previousWatermarks: PrWatchEventWatermarkRecord[],
) {
  return categories.map((category) =>
    deltaFromWatermark(
      category,
      watermarkPayload(currentWatermarks, category),
      watermarkPayload(previousWatermarks, category),
    ),
  );
}

function deltaFromWatermark(
  category: PrWatchEventWatermarkCategory,
  payload: Record<string, unknown>,
  previousPayload: Record<string, unknown>,
) {
  if (category === 'commits') {
    return jsonRecord({
      type: 'new-commit',
      id: stringField(payload.headSha) ?? category,
      summary: `PR commits changed (${numberField(payload.total) ?? 0} total).`,
      requiresExplanation: true,
      severity: 'low',
    });
  }

  if (category === 'review_threads') {
    const unresolved = arrayField(payload.unresolvedThreadIds);
    if (unresolved.length > 0) {
      return jsonRecord({
        type: 'review-comment',
        id: `${category}:${unresolved.join(',')}`,
        summary: `${unresolved.length} unresolved review thread${unresolved.length === 1 ? '' : 's'}.`,
        actionable: true,
        severity: 'medium',
      });
    }
    if (arrayField(previousPayload.unresolvedThreadIds).length === 0) {
      return jsonRecord({
        type: 'metadata',
        id: category,
        summary: 'Review thread state changed.',
        severity: 'low',
      });
    }
    return jsonRecord({
      type: 'review-thread-resolved',
      id: category,
      summary: 'Review threads were resolved.',
      severity: 'low',
    });
  }

  if (category === 'requested_changes_reviews') {
    const reviewIds = arrayField(payload.reviewIds);
    const total = numberField(payload.total) ?? reviewIds.length;
    if (total === 0) {
      const previousReviewIds = arrayField(previousPayload.reviewIds);
      const previousTotal =
        numberField(previousPayload.total) ?? previousReviewIds.length;
      if (previousTotal === 0) {
        return jsonRecord({
          type: 'metadata',
          id: category,
          summary: 'Requested-change review state changed.',
          severity: 'low',
        });
      }

      return jsonRecord({
        type: 'metadata',
        id: category,
        summary: 'Requested changes were cleared.',
        severity: 'medium',
      });
    }

    return jsonRecord({
      type: 'requested-changes',
      id: `${category}:${reviewIds.join(',') || 'latest'}`,
      summary: `${total} requested-changes review${total === 1 ? '' : 's'}.`,
      actionable: true,
      severity: 'high',
    });
  }

  if (category === 'check_suites' || category === 'check_runs') {
    const failingIds = arrayField(
      category === 'check_suites'
        ? payload.failingSuiteIds
        : payload.failingRunIds,
    );
    const pendingIds = arrayField(
      category === 'check_suites'
        ? payload.pendingSuiteIds
        : payload.pendingRunIds,
    );
    if (failingIds.length > 0) {
      return jsonRecord({
        type: 'check-failure',
        id: `${category}:${failingIds.join(',')}`,
        summary: `${failingIds.length} failing ${category === 'check_suites' ? 'check suite' : 'check run'}${failingIds.length === 1 ? '' : 's'}.`,
        actionable: true,
        severity: 'high',
      });
    }
    const previousFailingIds = arrayField(
      category === 'check_suites'
        ? previousPayload.failingSuiteIds
        : previousPayload.failingRunIds,
    );
    if (pendingIds.length === 0 && previousFailingIds.length === 0) {
      return jsonRecord({
        type: 'metadata',
        id: category,
        summary: `${category === 'check_suites' ? 'Check suite' : 'Check run'} state changed.`,
        severity: 'low',
      });
    }

    return jsonRecord({
      type: pendingIds.length > 0 ? 'metadata' : 'check-recovery',
      id: category,
      summary:
        pendingIds.length > 0
          ? `${pendingIds.length} pending check ${pendingIds.length === 1 ? 'item' : 'items'}.`
          : 'Check state recovered.',
      severity: pendingIds.length > 0 ? 'low' : 'medium',
    });
  }

  if (category === 'mergeability') {
    if (payload.mergeable === false) {
      return jsonRecord({
        type: 'merge-conflict',
        id: category,
        summary: 'PR is not currently mergeable.',
        requiresExplanation: true,
        severity: 'medium',
      });
    }
    return jsonRecord({
      type: 'metadata',
      id: category,
      summary: 'Mergeability changed.',
      severity: 'low',
    });
  }

  if (payload.isOutOfDate === true) {
    return jsonRecord({
      type: 'branch-out-of-date',
      id: category,
      summary: 'PR branch is out of date with the base branch.',
      requiresExplanation: true,
      severity: 'medium',
    });
  }

  return jsonRecord({
    type: 'metadata',
    id: category,
    summary: 'PR branch freshness changed.',
    severity: 'low',
  });
}

function shouldAdmitTriageForDeltas(deltas: Array<Record<string, unknown>>) {
  return deltas.some((delta) => {
    if (delta.actionable === true || delta.requiresExplanation === true) {
      return true;
    }
    return (
      delta.type === 'requested-changes' ||
      delta.type === 'review-comment' ||
      delta.type === 'check-failure' ||
      delta.type === 'merge-conflict' ||
      delta.type === 'branch-out-of-date' ||
      delta.type === 'new-commit'
    );
  });
}

function shouldRetainPendingTriage(
  currentWatermarks: PrWatchEventWatermarkRecord[],
  deltas: Array<Record<string, unknown>>,
) {
  return (
    shouldAdmitTriageForDeltas(deltas) ||
    hasActionablePrEventState(currentWatermarks)
  );
}

function hasActionablePrEventState(watermarks: PrWatchEventWatermarkRecord[]) {
  const reviewThreads = watermarkPayload(watermarks, 'review_threads');
  if (arrayField(reviewThreads.unresolvedThreadIds).length > 0) return true;

  const requestedChanges = watermarkPayload(
    watermarks,
    'requested_changes_reviews',
  );
  const requestedTotal =
    numberField(requestedChanges.total) ??
    arrayField(requestedChanges.reviewIds).length;
  if (requestedTotal > 0) return true;

  const runs = watermarkPayload(watermarks, 'check_runs');
  if (arrayField(runs.failingRunIds).length > 0) return true;

  const suites = watermarkPayload(watermarks, 'check_suites');
  if (arrayField(suites.failingSuiteIds).length > 0) return true;

  const mergeability = watermarkPayload(watermarks, 'mergeability');
  if (mergeability.mergeable === false) return true;

  const outOfDate = watermarkPayload(watermarks, 'out_of_date_branch');
  return outOfDate.isOutOfDate === true;
}

function snapshotFromWatermarks(watermarks: PrWatchEventWatermarkRecord[]) {
  const mergeability = watermarkPayload(watermarks, 'mergeability');
  const outOfDate = watermarkPayload(watermarks, 'out_of_date_branch');
  return compactObject({
    state: stringField(mergeability.state),
    draft: booleanField(mergeability.draft),
    merged: booleanField(mergeability.merged),
    mergeable: booleanField(mergeability.mergeable),
    outOfDate: booleanField(outOfDate.isOutOfDate),
    headSha:
      stringField(mergeability.headSha) ?? stringField(outOfDate.headSha),
    baseRef: stringField(outOfDate.baseRef),
    checkStatus: checkStatusFromWatermarks(watermarks),
  });
}

function checkStatusFromWatermarks(watermarks: PrWatchEventWatermarkRecord[]) {
  const runs = watermarkPayload(watermarks, 'check_runs');
  const suites = watermarkPayload(watermarks, 'check_suites');
  const failing =
    arrayField(runs.failingRunIds).length +
    arrayField(suites.failingSuiteIds).length;
  if (failing > 0) return 'failure';

  const pending =
    arrayField(runs.pendingRunIds).length +
    arrayField(suites.pendingSuiteIds).length;
  if (pending > 0) return 'pending';

  const total =
    (numberField(runs.total) ?? 0) + (numberField(suites.total) ?? 0);
  return total > 0 ? 'success' : undefined;
}

function watermarkPayload(
  watermarks: PrWatchEventWatermarkRecord[],
  category: PrWatchEventWatermarkCategory,
) {
  return readObjectConfig(
    watermarks.find((watermark) => watermark.category === category)?.watermark,
  );
}

function prEventNotification(
  watch: PrWatch,
  categories: PrWatchEventWatermarkCategory[],
  watermarks: PrWatchEventWatermarkRecord[],
  deltas: Array<Record<string, unknown>>,
  mode: AutopilotMode,
) {
  const actionable = deltas.some((delta) => delta.actionable === true);
  const requestedChanges = deltas.some(
    (delta) => delta.type === 'requested-changes',
  );
  const reviewFeedback = deltas.some(
    (delta) => delta.type === 'review-comment',
  );
  const checkFailure = deltas.some((delta) => delta.type === 'check-failure');
  const title = requestedChanges
    ? 'PR watch requested changes'
    : reviewFeedback
      ? 'PR watch review feedback'
      : checkFailure
        ? 'PR watch checks failed'
        : 'PR watch event changed';
  const message = `${watch.repoFullName}#${watch.prNumber}: ${deltas
    .map((delta) => stringField(delta.summary))
    .filter(Boolean)
    .join(' ')}`;

  return {
    level: actionable ? ('attention' as const) : ('info' as const),
    title,
    message,
    source: 'watch-pr-events',
    sourceId: prEventSourceId(watch, categories, watermarks),
    data: {
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      mode,
      changedCategories: categories,
      deltas,
    },
  };
}

function prEventSourceId(
  watch: PrWatch,
  categories: PrWatchEventWatermarkCategory[],
  watermarks: PrWatchEventWatermarkRecord[],
) {
  const latest = latestWatermarkTimestamp(watermarks, categories);
  const hash = eventWatermarkHash(watermarks, categories);
  return `${watch.id}:${[...categories].sort().join('+')}:${latest ?? 'unknown'}:${hash}`;
}

function eventWatermarkHash(
  watermarks: PrWatchEventWatermarkRecord[],
  categories: PrWatchEventWatermarkCategory[],
) {
  const payload = [...categories].sort().map((category) => ({
    category,
    watermark: watermarkPayload(watermarks, category),
  }));
  return createHash('sha256')
    .update(stableJson(payload))
    .digest('hex')
    .slice(0, 12);
}

function latestWatermarkTimestamp(
  watermarks: PrWatchEventWatermarkRecord[],
  categories: PrWatchEventWatermarkCategory[],
) {
  return watermarks
    .filter((watermark) => categories.includes(watermark.category))
    .map((watermark) => watermark.sourceUpdatedAt ?? watermark.updatedAt)
    .filter(Boolean)
    .sort()
    .at(-1);
}

function triageModeForPolicy(mode: AutopilotMode) {
  if (mode === 'prepare-only') return 'draft-fix';
  if (mode === 'autofix-with-approval') return 'auto-fix-no-push';
  if (mode === 'autofix-push-when-safe') {
    return 'auto-fix-push-after-checks';
  }
  return mode;
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function jsonRecord(value: Record<string, unknown>) {
  return compactObject(value) as Record<string, JsonValue>;
}

function readJsonRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, JsonValue>;
}

function readJsonArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function arrayField(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function refreshRefWatchJob(
  job: JobRecord,
  paths: RuntimePaths,
  refreshWatch: SchedulerDependencies['refreshRefWatch'] = refreshRefWatch,
): Promise<JobExecutionResult> {
  const config = readObjectConfig(job.config);
  const target =
    typeof config.id === 'string'
      ? { id: config.id }
      : typeof config.repo === 'string' && typeof config.ref === 'string'
        ? { repo: config.repo, ref: config.ref }
        : typeof config.target === 'string'
          ? { target: config.target }
          : undefined;

  const results = [];
  if (target) {
    results.push(await refreshWatch(target, paths));
  } else {
    const watches = await listRefWatchRecords(paths);
    for (const watch of watches) {
      results.push(await refreshWatch({ id: watch.id }, paths));
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    return {
      outcome: 'failed',
      message: `Failed to refresh ${failures.length} ref watch${failures.length === 1 ? '' : 'es'}.`,
      result: { results },
      notifications: failures.map((result) => ({
        level: 'attention',
        title: 'Ref watch refresh failed',
        message: result.message,
        source: 'watch-ref',
        sourceId: failedWatchSourceId(result, target),
        data: result,
      })),
    };
  }

  const changed = results.filter((result) => result.changed);
  const notifications = changed.map((result) => {
    const watch = result.watch as { id?: string; status?: string } | undefined;
    const level: NotificationLevel =
      watch?.status === 'attention-needed'
        ? 'attention'
        : watch?.status === 'green'
          ? 'ready'
          : 'info';
    const title =
      watch?.status === 'green'
        ? 'Ref watch green'
        : watch?.status === 'attention-needed'
          ? 'Ref watch needs attention'
          : 'Ref watch changed';

    return {
      level,
      title,
      message: result.message,
      source: 'watch-ref',
      sourceId: watch?.id,
      data: result.watch,
    };
  });

  return {
    outcome: changed.length > 0 ? 'updated' : 'silent',
    message:
      changed.length > 0
        ? `Updated ${changed.length} ref watch${changed.length === 1 ? '' : 'es'}.`
        : 'Ref watch refresh had no changes.',
    result: { results },
    notifications,
  };
}

export function failedWatchSourceId(
  result: unknown,
  target: { id?: string; ref?: string } | undefined,
) {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const watch = (result as { watch?: unknown }).watch;
    if (watch && typeof watch === 'object' && !Array.isArray(watch)) {
      const id = (watch as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
  }

  return target?.id ?? target?.ref ?? 'all-watches';
}

export function readIntervalSeconds(
  config: unknown,
  type: BlueprintKind | string,
) {
  const record = readObjectConfig(config);
  const value = record.intervalSeconds;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 60) {
    return value;
  }

  return defaultIntervalSeconds(type);
}

export function defaultIntervalSeconds(type: BlueprintKind | string) {
  if (type === 'watch-pr') return 300;
  if (type === 'release-watch') return 900;
  if (type === 'review-queue-digest') return 3_600;
  if (type === 'docs-drift') return 604_800;
  if (type === 'issue-triage') return 86_400;
  if (type === 'hygiene') return 604_800;
  return 86_400;
}

export function defaultBlueprintId(blueprint: BlueprintKind, target?: string) {
  const suffix = target
    ? target
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    : 'default';
  return `${blueprint}-${suffix}`;
}

export async function resolveReleaseWatchRepo(
  repoRef: string,
  paths: RuntimePaths,
) {
  const registry = await readRepoRegistrySnapshot(paths);
  const matches = registry.repos.filter(
    (repo) =>
      repo.id === repoRef ||
      repo.github.name === repoRef ||
      repoFullName(repo).toLowerCase() === repoRef.toLowerCase(),
  );

  if (matches.length === 1) {
    return { ok: true as const, repo: matches[0] };
  }

  if (matches.length > 1) {
    return {
      ok: false as const,
      result: failResult(
        'schedule_blueprint_create',
        `Repository "${repoRef}" is ambiguous.`,
        { requires: ['repo'] },
      ),
    };
  }

  return {
    ok: false as const,
    result: failResult(
      'schedule_blueprint_create',
      `Repository "${repoRef}" is not configured.`,
      { requires: ['repo'] },
    ),
  };
}

export function readObjectConfig(config: unknown) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}
