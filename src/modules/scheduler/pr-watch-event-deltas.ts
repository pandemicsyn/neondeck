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
  filters: {
    addressedReviewThreadFingerprints?: ReadonlyMap<string, string>;
    addressedReviewCommentFingerprints?: ReadonlyMap<string, string>;
  } = {},
) {
  return categories.flatMap((category) => {
    const payload = watermarkPayload(currentWatermarks, category);
    const previousPayload = watermarkPayload(previousWatermarks, category);
    if (category === 'review_threads') {
      return reviewCommentDeltas(payload, previousPayload, filters);
    }
    if (category === 'requested_changes_reviews') {
      return requestedChangesDeltas(payload, previousPayload);
    }
    if (category === 'conversation_comments') {
      return conversationCommentDeltas(payload, previousPayload);
    }
    if (category === 'check_suites' || category === 'check_runs') {
      return checkDeltas(category, payload, previousPayload);
    }
    return [deltaFromWatermark(category, payload, previousPayload)];
  });
}

export function initialActionableDeltas(
  currentWatermarks: PrWatchEventWatermarkRecord[],
  filters: {
    addressedReviewThreadFingerprints?: ReadonlyMap<string, string>;
    addressedReviewCommentFingerprints?: ReadonlyMap<string, string>;
  } = {},
) {
  return deltasFromChangedCategories(
    [
      'review_threads',
      'requested_changes_reviews',
      'conversation_comments',
      'check_suites',
      'check_runs',
    ],
    currentWatermarks,
    [],
    filters,
  ).filter(
    (delta) =>
      delta.actionable === true || delta.type === 'incomplete-feedback',
  );
}

function reviewCommentDeltas(
  payload: Record<string, unknown>,
  previousPayload: Record<string, unknown>,
  filters: {
    addressedReviewThreadFingerprints?: ReadonlyMap<string, string>;
    addressedReviewCommentFingerprints?: ReadonlyMap<string, string>;
  },
) {
  const previous = feedbackFingerprintMap(
    feedbackItemsFromThreads(previousPayload),
  );
  const deltas = feedbackItemsFromThreads(payload).flatMap((item) => {
    const threadId = stringField(item.threadId);
    const id = feedbackItemId(item);
    if (
      !id ||
      booleanField(item.isResolved) === true ||
      booleanField(item.actionable) === false
    ) {
      return [];
    }
    const fingerprint = stringField(item.fingerprint);
    const addressedCommentFingerprint =
      filters.addressedReviewCommentFingerprints?.get(id);
    const addressedThreadFingerprint = threadId
      ? filters.addressedReviewThreadFingerprints?.get(threadId)
      : undefined;
    if (
      fingerprint &&
      (addressedCommentFingerprint === fingerprint ||
        addressedThreadFingerprint === fingerprint)
    ) {
      return [];
    }
    const change = feedbackChange(item, previous.get(id));
    if (!change) return [];
    const incomplete =
      booleanField(item.bodyTruncated) === true ||
      booleanField(item.commentsTruncated) === true ||
      booleanField(payload.truncated) === true;
    return [
      jsonRecord({
        type: incomplete ? 'incomplete-feedback' : 'review-comment',
        feedbackType: 'review-comment',
        id: `review-comment:${id}:${stringField(item.fingerprint) ?? change}`,
        itemId: id,
        threadId,
        itemFingerprint: stringField(item.fingerprint),
        change,
        summary: `${change === 'new' ? 'New' : 'Changed'} review feedback from ${stringField(item.authorLogin) ?? 'unknown reviewer'}.`,
        actionable: !incomplete,
        requiresExplanation: incomplete,
        severity: 'medium',
        feedback: item,
        incomplete,
      }),
    ];
  });
  if (deltas.length > 0) return deltas;
  if (booleanField(payload.truncated) === true) {
    return [incompleteCollectionDelta('review_threads')];
  }
  return [
    jsonRecord({
      type: 'metadata',
      id: 'review_threads',
      summary: 'Review thread state changed without new actionable feedback.',
      severity: 'low',
    }),
  ];
}

function requestedChangesDeltas(
  payload: Record<string, unknown>,
  previousPayload: Record<string, unknown>,
) {
  const previous = feedbackFingerprintMap(recordArray(previousPayload.reviews));
  const deltas = recordArray(payload.reviews).flatMap((item) => {
    const id = feedbackItemId(item);
    if (!id || item.actionable === false) return [];
    const change = feedbackChange(item, previous.get(id));
    if (!change) return [];
    const incomplete =
      item.bodyTruncated === true || payload.truncated === true;
    return [
      jsonRecord({
        type: incomplete ? 'incomplete-feedback' : 'requested-changes',
        feedbackType: 'requested-changes',
        id: `requested-changes:${id}:${stringField(item.fingerprint) ?? change}`,
        itemId: id,
        itemFingerprint: stringField(item.fingerprint),
        change,
        summary: `${change === 'new' ? 'New' : 'Changed'} requested-changes review from ${stringField(item.authorLogin) ?? 'unknown reviewer'}.`,
        actionable: !incomplete,
        requiresExplanation: incomplete,
        severity: 'high',
        review: item,
        incomplete,
      }),
    ];
  });
  if (deltas.length > 0) return deltas;
  if (booleanField(payload.truncated) === true) {
    return [incompleteCollectionDelta('requested_changes_reviews')];
  }
  const previousTotal = numberField(previousPayload.total) ?? 0;
  return [
    jsonRecord({
      type: 'metadata',
      id: 'requested_changes_reviews',
      summary:
        (numberField(payload.total) ?? 0) === 0 && previousTotal > 0
          ? 'Requested changes were cleared.'
          : 'Requested-change review state changed without new actionable feedback.',
      severity: 'medium',
    }),
  ];
}

function conversationCommentDeltas(
  payload: Record<string, unknown>,
  previousPayload: Record<string, unknown>,
) {
  const previous = feedbackFingerprintMap(
    recordArray(previousPayload.comments),
  );
  const deltas = recordArray(payload.comments).flatMap((item) => {
    const id = feedbackItemId(item);
    if (!id || item.actionable === false) return [];
    const change = feedbackChange(item, previous.get(id));
    if (!change) return [];
    const incomplete =
      item.bodyTruncated === true || payload.truncated === true;
    return [
      jsonRecord({
        type: incomplete ? 'incomplete-feedback' : 'conversation-comment',
        feedbackType: 'conversation-comment',
        id: `conversation-comment:${id}:${stringField(item.fingerprint) ?? change}`,
        itemId: id,
        itemFingerprint: stringField(item.fingerprint),
        change,
        summary: `${change === 'new' ? 'New' : 'Changed'} PR conversation comment from ${stringField(item.authorLogin) ?? 'unknown author'}.`,
        actionable: !incomplete,
        requiresExplanation: incomplete,
        severity: 'medium',
        comment: item,
        incomplete,
      }),
    ];
  });
  if (deltas.length > 0) return deltas;
  if (booleanField(payload.truncated) === true) {
    return [incompleteCollectionDelta('conversation_comments')];
  }
  return [
    jsonRecord({
      type: 'metadata',
      id: 'conversation_comments',
      summary: 'PR conversation changed without new actionable human feedback.',
      severity: 'low',
    }),
  ];
}

function checkDeltas(
  category: 'check_suites' | 'check_runs',
  payload: Record<string, unknown>,
  previousPayload: Record<string, unknown>,
) {
  const key = category === 'check_suites' ? 'suites' : 'runs';
  const previous = feedbackFingerprintMap(recordArray(previousPayload[key]));
  const failingIds = new Set(
    arrayField(
      category === 'check_suites'
        ? payload.failingSuiteIds
        : payload.failingRunIds,
    ).map(String),
  );
  const deltas = recordArray(payload[key]).flatMap((item) => {
    const id = feedbackItemId(item);
    if (!id || !failingIds.has(id)) return [];
    const change = feedbackChange(item, previous.get(id));
    if (!change) return [];
    const incomplete = payload.truncated === true;
    return [
      jsonRecord({
        type: incomplete ? 'incomplete-feedback' : 'check-failure',
        feedbackType: 'check-failure',
        id: `${category}:${id}:${stringField(item.fingerprint) ?? change}`,
        itemId: id,
        itemFingerprint: stringField(item.fingerprint),
        change,
        summary: `${change === 'new' ? 'New' : 'Changed'} failing ${category === 'check_suites' ? 'check suite' : 'check run'} ${stringField(item.name) ?? id}.`,
        actionable: !incomplete,
        requiresExplanation: incomplete,
        severity: 'high',
        check: item,
        incomplete,
      }),
    ];
  });
  if (deltas.length > 0) return deltas;
  if (booleanField(payload.truncated) === true) {
    return [incompleteCollectionDelta(category)];
  }
  return [deltaFromWatermark(category, payload, previousPayload)];
}

function incompleteCollectionDelta(category: PrWatchEventWatermarkCategory) {
  return jsonRecord({
    type: 'incomplete-feedback',
    feedbackType: category,
    id: `incomplete:${category}`,
    summary: `${category.replaceAll('_', ' ')} were truncated; autonomous handling is blocked until complete facts are available.`,
    actionable: false,
    requiresExplanation: true,
    severity: 'high',
    incomplete: true,
  });
}

function feedbackItemsFromThreads(payload: Record<string, unknown>) {
  return recordArray(payload.threads).flatMap((thread) =>
    recordArray(thread.comments).map(
      (comment) =>
        ({
          ...comment,
          threadId: stringField(thread.id),
          isResolved: thread.isResolved === true,
          isOutdated: thread.isOutdated === true,
          commentsTruncated: thread.commentsTruncated === true,
        }) as Record<string, unknown>,
    ),
  );
}

function feedbackFingerprintMap(items: Array<Record<string, unknown>>) {
  return new Map(
    items.flatMap((item) => {
      const id = feedbackItemId(item);
      return id ? [[id, stringField(item.fingerprint)]] : [];
    }),
  );
}

function feedbackItemId(item: Record<string, unknown>) {
  return typeof item.id === 'string' || typeof item.id === 'number'
    ? String(item.id)
    : undefined;
}

function feedbackChange(
  item: Record<string, unknown>,
  previousFingerprint: string | undefined,
) {
  const fingerprint = stringField(item.fingerprint);
  if (!previousFingerprint) return 'new';
  return fingerprint && fingerprint !== previousFingerprint ? 'changed' : null;
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(readObjectConfig).filter((item) => Object.keys(item).length > 0)
    : [];
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

  if (category === 'conversation_comments') {
    return jsonRecord({
      type: 'metadata',
      id: category,
      summary: 'PR conversation comments changed.',
      severity: 'low',
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

  const conversation = watermarkPayload(watermarks, 'conversation_comments');
  if (
    recordArray(conversation.comments).some(
      (comment) => comment.actionable !== false,
    )
  ) {
    return true;
  }

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
  const incomplete = deltas.some(
    (delta) => delta.type === 'incomplete-feedback',
  );
  const actionable =
    incomplete || deltas.some((delta) => delta.actionable === true);
  const requestedChanges = deltas.some(
    (delta) => delta.type === 'requested-changes',
  );
  const conversationFeedback = deltas.some(
    (delta) => delta.type === 'conversation-comment',
  );
  const reviewFeedback = deltas.some(
    (delta) => delta.type === 'review-comment',
  );
  const checkFailure = deltas.some((delta) => delta.type === 'check-failure');
  const title = requestedChanges
    ? 'PR watch requested changes'
    : reviewFeedback
      ? 'PR watch review feedback'
      : conversationFeedback
        ? 'PR watch conversation feedback'
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
