import type { JsonValue } from '@flue/runtime';
import type { AutomationExecutionResult } from '../app-state';
import { readRepoRegistrySnapshot } from '../repos';
import {
  repoAutopilotPolicyForWatch,
  type AutopilotMode,
} from '../autopilot-policy';
import {
  listPrWatchEventWatermarks,
  readAddressedPrFeedback,
  readNeondeckPrDeliveries,
  refreshPrWatchEventState,
  type PrWatchEventWatermarkCategory,
  type PrWatchEventWatermarkRecord,
} from '../pr-events';
import {
  parseAppConfig,
  readRuntimeJson,
  type RuntimePaths,
} from '../../runtime-home';
import {
  listPrWatchRecords,
  persistWatchEventRefresh,
  type PrWatch,
} from '../watches';
import type { SchedulerDependencies } from './schemas';
import {
  deltasFromChangedCategories,
  initialActionableDeltas,
  prEventNotification,
} from './pr-watch-event-deltas';
import { readJsonArray, readObjectConfig, stringField } from './utils';

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
  notifications?: AutomationExecutionResult['notifications'];
  persistedNotification?: JsonValue;
};

/**
 * Refreshes deterministic PR event facts and emits notifications for meaningful
 * changes. Autopilot owner dispatch intentionally remains disconnected until the
 * simplified loop is implemented separately.
 */
export async function refreshWatchJobEvents(
  results: Awaited<
    ReturnType<NonNullable<SchedulerDependencies['refreshPrWatch']>>
  >[],
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
  _previousJobResult: JsonValue | null,
): Promise<WatchJobEventResult[]> {
  if (!dependencies.refreshPrWatchEventState && !process.env.GITHUB_TOKEN) {
    return [];
  }

  const watches = await listPrWatchRecords(paths);
  const watchById = new Map(watches.map((watch) => [watch.id, watch]));
  const targets = results
    .map((result) => watchIdFromResult(result))
    .filter((id): id is string => Boolean(id))
    .map((id) => watchById.get(id))
    .filter((watch): watch is PrWatch => Boolean(watch));

  const eventResults: WatchJobEventResult[] = [];
  for (const watch of targets) {
    eventResults.push(await refreshOneWatchEvent(watch, paths, dependencies));
  }
  return eventResults;
}

async function refreshOneWatchEvent(
  watch: PrWatch,
  paths: RuntimePaths,
  dependencies: SchedulerDependencies,
): Promise<WatchJobEventResult> {
  const listWatermarks =
    dependencies.listPrWatchEventWatermarks ?? listPrWatchEventWatermarks;
  const refreshEvents =
    dependencies.refreshPrWatchEventState ?? refreshPrWatchEventState;
  const previousResult = await listWatermarks({ watchId: watch.id }, paths);
  const previousWatermarks = watermarksFromActionResult(previousResult);
  const refresh = await refreshEvents({ watchId: watch.id }, paths, {
    persistWatermarks: false,
  });
  if (!refresh.ok) {
    return {
      ok: false,
      changed: false,
      watchId: watch.id,
      repoId: watch.repoId,
      repoFullName: watch.repoFullName,
      prNumber: watch.prNumber,
      message: refresh.message,
      refresh: refresh as unknown as JsonValue,
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
  const currentWatermarks = watermarksFromActionResult(refresh);
  if (changedCategories.length === 0) {
    persistWatchEventRefresh(
      paths,
      watch.id,
      watermarksForPersistence(currentWatermarks),
      { markInitialProcessed: !watch.initialEventProcessedAt },
    );
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

  const addressed = readAddressedPrFeedback(
    watch.repoFullName,
    watch.prNumber,
    paths,
  );
  const deliveries = readNeondeckPrDeliveries(
    watch.repoFullName,
    watch.prNumber,
    paths,
  );
  const filters = {
    addressedReviewThreadFingerprints: addressed.reviewThreadFingerprints,
    addressedReviewCommentFingerprints: addressed.reviewCommentFingerprints,
    neondeckReviewCommentFingerprints: deliveries.reviewCommentFingerprints,
    neondeckRequestedChangesReviewFingerprints: deliveries.reviewFingerprints,
    neondeckConversationCommentFingerprints:
      deliveries.conversationCommentFingerprints,
  };
  const firstPoll = !watch.initialEventProcessedAt;
  const deltas = firstPoll
    ? initialActionableDeltas(currentWatermarks, filters)
    : deltasFromChangedCategories(
        changedCategories,
        currentWatermarks,
        previousWatermarks,
        filters,
      );
  const mode = await readEffectiveWatchAutopilotMode(watch, paths);
  const notification =
    deltas.length > 0
      ? prEventNotification(
          watch,
          changedCategories,
          currentWatermarks,
          deltas,
          mode,
        )
      : undefined;
  const persisted = persistWatchEventRefresh(
    paths,
    watch.id,
    watermarksForPersistence(currentWatermarks),
    {
      notification,
      markInitialProcessed: firstPoll,
    },
  );

  return {
    ok: true,
    changed: Boolean(notification),
    watchId: watch.id,
    repoId: watch.repoId,
    repoFullName: watch.repoFullName,
    prNumber: watch.prNumber,
    mode,
    changedCategories,
    deltas,
    message: refresh.message,
    refresh: refresh as unknown as JsonValue,
    persistedNotification:
      (persisted.notification as unknown as JsonValue | null) ?? undefined,
  };
}

function watermarksForPersistence(watermarks: PrWatchEventWatermarkRecord[]) {
  return watermarks.map((watermark) => ({
    category: watermark.category,
    value: watermark.watermark,
    sourceUpdatedAt: watermark.sourceUpdatedAt,
  }));
}

async function readEffectiveWatchAutopilotMode(
  watch: PrWatch,
  paths: RuntimePaths,
): Promise<AutopilotMode> {
  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === watch.repoId,
  );
  return repo
    ? repoAutopilotPolicyForWatch(repo, appConfig, watch).mode
    : 'notify-only';
}

function watchIdFromResult(value: unknown) {
  const result = readObjectConfig(value);
  const watch = readObjectConfig(result.watch);
  return stringField(watch.id) ?? stringField(result.id);
}

function changedCategoriesFromActionResult(value: unknown) {
  const result = readObjectConfig(value);
  const data = readObjectConfig(result.data);
  const categories = readJsonArray(
    result.changedCategories ?? data.changedCategories,
  )
    .map(String)
    .filter((category): category is PrWatchEventWatermarkCategory =>
      [
        'commits',
        'review_threads',
        'requested_changes_reviews',
        'conversation_comments',
        'check_suites',
        'check_runs',
        'mergeability',
        'out_of_date_branch',
      ].includes(category),
    );
  return [...new Set(categories)];
}

function watermarksFromActionResult(value: unknown) {
  const result = readObjectConfig(value);
  const data = readObjectConfig(result.data);
  return readJsonArray(result.watermarks ?? data.watermarks)
    .map((item) => {
      const record = readObjectConfig(item);
      const category = stringField(record.category);
      const watchId = stringField(record.watchId);
      if (!category || !watchId) return null;
      return record as unknown as PrWatchEventWatermarkRecord;
    })
    .filter((record): record is PrWatchEventWatermarkRecord => Boolean(record));
}
