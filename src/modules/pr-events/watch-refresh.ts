import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  prEventWatermarkTruncationCategories,
  pullRequestEventStateTruncation,
} from '../github';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import { persistWatchEventRefresh } from '../watches';
import {
  prEventTargetInputSchema,
  prWatchEventWatermarkListInputSchema,
  type PrEventActionResult,
  type PrEventStateDependencies,
  type PrWatchEventWatermarkRecord,
} from './schemas';
import { fetchEventState, resolvePullRequestTarget } from './target';
import { readWatermarks, watermarksFromEventState } from './watermarks';
import { eventTargetJson, failResult, okResult, stableJson } from './utils';

export async function refreshPrWatchEventState(
  input: v.InferInput<typeof prEventTargetInputSchema>,
  paths: RuntimePaths = runtimePaths(),
  dependencies: PrEventStateDependencies = {},
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prEventTargetInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'pr_watch_event_state_refresh',
      'Invalid PR event refresh target.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }
  if (
    !parsed.output.watchId &&
    !parsed.output.ref &&
    !(parsed.output.repo && parsed.output.prNumber)
  ) {
    return failResult(
      'pr_watch_event_state_refresh',
      'Refreshing event watermarks requires a watch id, PR reference, or repository and PR number.',
      { requires: ['watchId', 'ref', 'repo', 'prNumber'] },
    );
  }
  const localTarget = await resolvePullRequestTarget(
    parsed.output,
    paths,
    'pr_watch_event_state_refresh',
  );
  if (!localTarget.ok) return localTarget.result;
  if (!localTarget.target.watch) {
    return failResult(
      'pr_watch_event_state_refresh',
      'Refreshing event watermarks requires a configured PR watch.',
      { requires: ['watchId'] },
    );
  }
  const resolved = await fetchEventState(
    'pr_watch_event_state_refresh',
    input,
    paths,
    dependencies,
  );
  if (!resolved.ok) return resolved.result;
  if (!resolved.target.watch) {
    return failResult(
      'pr_watch_event_state_refresh',
      'Refreshing event watermarks requires a configured PR watch.',
      { requires: ['watchId'] },
    );
  }
  const truncation = pullRequestEventStateTruncation(resolved.state);
  if (truncation.any) {
    return failResult(
      'pr_watch_event_state_refresh',
      'PR event facts are incomplete; preserving the last acknowledged watermark baseline and retrying later.',
      {
        requires: ['completePrEventFacts'],
        errors: [
          `Incomplete PR event fact categories: ${truncation.categories.join(', ')}.`,
        ],
      },
    );
  }

  const watch = resolved.target.watch;
  const previous = readWatermarks(paths, watch.id);
  const next = watermarksFromEventState(watch.id, resolved.state);
  const incompleteWatermarks = prEventWatermarkTruncationCategories(next);
  if (incompleteWatermarks.length > 0) {
    return failResult(
      'pr_watch_event_state_refresh',
      'PR event facts are incomplete; preserving the last acknowledged watermark baseline and retrying later.',
      {
        requires: ['completePrEventFacts'],
        errors: [
          `Incomplete PR event watermark categories: ${incompleteWatermarks.join(', ')}.`,
        ],
      },
    );
  }

  const changedCategories = next
    .filter((item) => {
      const existing = previous.find(
        (record) => record.category === item.category,
      );
      return (
        stableJson(comparableWatermark(item.category, existing?.watermark)) !==
        stableJson(comparableWatermark(item.category, item.value))
      );
    })
    .map((item) => item.category);

  if (dependencies.persistWatermarks !== false) {
    const persisted = persistWatchEventRefresh(paths, watch.id, next, {
      expectedWatchState: watch,
    });
    if (!persisted.persisted) {
      return staleWatchEventRefreshResult(watch.id);
    }
  }
  const currentWatermarks =
    dependencies.persistWatermarks === false
      ? candidateWatermarkRecords(watch.id, next, previous)
      : readWatermarks(paths, watch.id);

  return okResult(
    'pr_watch_event_state_refresh',
    changedCategories.length > 0,
    changedCategories.length > 0
      ? `Updated ${changedCategories.length} PR event watermark change(s) for ${watch.id}.`
      : `No PR event watermark changes for ${watch.id}.`,
    {
      watchId: watch.id,
      target: eventTargetJson(resolved.target),
      changedCategories,
      previousWatermarks: previous as unknown as JsonValue,
      watermarks: currentWatermarks as unknown as JsonValue,
    },
  );
}

function staleWatchEventRefreshResult(watchId: string) {
  return failResult(
    'pr_watch_event_state_refresh',
    `Watch "${watchId}" changed while PR event facts were being fetched; the current event baseline was preserved. Retry against the current watch state.`,
    { requires: ['currentWatchState'] },
  );
}

function candidateWatermarkRecords(
  watchId: string,
  watermarks: ReturnType<typeof watermarksFromEventState>,
  previous: PrWatchEventWatermarkRecord[],
): PrWatchEventWatermarkRecord[] {
  const now = new Date().toISOString();
  return watermarks.map((watermark) => ({
    watchId,
    category: watermark.category,
    watermark: watermark.value,
    sourceUpdatedAt: watermark.sourceUpdatedAt,
    checkedAt: now,
    createdAt:
      previous.find((record) => record.category === watermark.category)
        ?.createdAt ?? now,
    updatedAt: now,
  }));
}

function comparableWatermark(category: string, value: unknown) {
  if (category !== 'mergeability') return value ?? null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value ?? null;
  }
  const record = value as Record<string, unknown>;
  return {
    state: record.state,
    draft: typeof record.draft === 'boolean' ? record.draft : false,
    merged: record.merged,
    mergeable: record.mergeable,
    mergeableState: record.mergeableState,
    mergeCommitSha: record.mergeCommitSha,
    headSha: record.headSha,
    baseSha: record.baseSha,
  };
}

export async function listPrWatchEventWatermarks(
  input: v.InferInput<typeof prWatchEventWatermarkListInputSchema> = {},
  paths: RuntimePaths = runtimePaths(),
): Promise<PrEventActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(prWatchEventWatermarkListInputSchema, input);
  if (!parsed.success) {
    return failResult(
      'pr_watch_event_watermarks_list',
      'Invalid PR watch event watermark input.',
      { errors: [v.summarize(parsed.issues)] },
    );
  }

  const watermarks = readWatermarks(paths, parsed.output.watchId);
  return okResult(
    'pr_watch_event_watermarks_list',
    false,
    `Listed ${watermarks.length} PR watch event watermark(s).`,
    { watermarks: watermarks as unknown as JsonValue },
  );
}
