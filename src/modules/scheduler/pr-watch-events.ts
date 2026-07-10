import type { JsonValue } from '@flue/runtime';
import type { AutomationExecutionResult } from '../app-state';
import { readRepoRegistrySnapshot } from '../repos';
import {
  repoAutopilotPolicyForWatch,
  type AutopilotMode,
} from '../autopilot-policy';
import {
  claimAutopilotTriageAdmission,
  failAutopilotAdmission,
  recordAutopilotAdmissionRun,
} from '../autopilot';
import {
  listPrWatchEventWatermarks,
  refreshPrWatchEventState,
  type PrWatchEventWatermarkCategory,
  type PrWatchEventWatermarkRecord,
} from '../pr-events';
import {
  parseAppConfig,
  readRuntimeJson,
  type RuntimePaths,
} from '../../runtime-home';
import { listPrWatchRecords, type PrWatch } from '../watches';
import type { SchedulerDependencies } from './schemas';
import {
  deltasFromChangedCategories,
  prEventNotification,
  prEventSourceId,
  shouldAdmitTriageForDeltas,
  shouldRetainPendingTriage,
  snapshotFromWatermarks,
} from './pr-watch-event-deltas';
import { invokeScheduledWorkflow } from './workflow-invocation';
import {
  errorMessage,
  jsonRecord,
  readJsonArray,
  readJsonRecord,
  readObjectConfig,
  stringField,
} from './utils';

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
  notifications?: AutomationExecutionResult['notifications'];
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
  notifications: NonNullable<AutomationExecutionResult['notifications']>;
  message?: string;
};

export async function refreshWatchJobEvents(
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
  const notifications: AutomationExecutionResult['notifications'] = [
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
  const notifications: NonNullable<AutomationExecutionResult['notifications']> =
    [];
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
  const policy = await readEffectiveWatchAutopilotPolicy(watch, paths);
  if (!('concurrency' in policy)) {
    return {
      ok: true,
      changed: true,
      triage: {
        status: 'blocked',
        eventId,
        reason: 'Autopilot policy is unavailable for this repository.',
        input,
      } as unknown as JsonValue,
      notifications: [
        {
          level: 'attention',
          title: 'Autopilot triage blocked',
          message: 'Autopilot policy is unavailable for this repository.',
          source: 'autopilot',
          sourceId: `triage:${watch.id}:${eventId}:blocked`,
          data: {
            watchId: watch.id,
            repoId: watch.repoId,
            repoFullName: watch.repoFullName,
            prNumber: watch.prNumber,
            eventId,
            input,
          },
        },
      ],
    };
  }
  const admission = await claimAutopilotTriageAdmission(
    {
      watchId: watch.id,
      eventFingerprint: eventId,
      repoId: watch.repoId,
      prNumber: watch.prNumber,
      mode: policy.mode,
      limits: policy.concurrency,
    },
    paths,
  );
  if (!admission.claimed) {
    return {
      ok: true,
      changed: admission.reason !== 'duplicate',
      triage: {
        status: admission.admission.state,
        eventId,
        admission: admission.admission,
      } as unknown as JsonValue,
      notifications: [],
    };
  }

  const invokeWorkflow = dependencies.invokeWorkflow ?? invokeScheduledWorkflow;
  try {
    const { runId } = await invokeWorkflow('triage-pr-event', {
      ...input,
      admissionId: admission.admission.id,
    });
    await recordAutopilotAdmissionRun(
      { id: admission.admission.id, runId },
      paths,
    );
    return {
      ok: true,
      changed: true,
      triage: {
        status: 'admitted',
        eventId,
        runId,
        workflow: 'triage-pr-event',
        input: { ...input, admissionId: admission.admission.id },
      } as unknown as JsonValue,
      notifications: [],
    };
  } catch (error) {
    const message = `Autopilot triage admission failed: ${errorMessage(error)}.`;
    await failAutopilotAdmission(
      { id: admission.admission.id, error: errorMessage(error) },
      paths,
    );
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

export function pendingEventResultsFromJobResult(value: JsonValue | null) {
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

function triageModeForPolicy(mode: AutopilotMode) {
  return mode;
}
