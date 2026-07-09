import { createHash } from 'node:crypto';
import type { AutopilotMode } from '../autopilot-policy';
import type {
  PrWatchEventWatermarkCategory,
  PrWatchEventWatermarkRecord,
} from '../pr-events';
import type { PrWatch } from '../watches';
import {
  arrayField,
  booleanField,
  compactObject,
  jsonRecord,
  numberField,
  readObjectConfig,
  stableJson,
  stringField,
} from './utils';

export function deltasFromChangedCategories(
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

export function shouldAdmitTriageForDeltas(
  deltas: Array<Record<string, unknown>>,
) {
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

export function shouldRetainPendingTriage(
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

export function snapshotFromWatermarks(
  watermarks: PrWatchEventWatermarkRecord[],
) {
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

export function prEventNotification(
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

export function prEventSourceId(
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
