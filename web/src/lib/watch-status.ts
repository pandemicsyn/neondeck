import type { NotificationRecord, PrWatch } from '../api';
import type { WebExternalValue } from '../api/schemas';
import * as v from 'valibot';

const watchStatusFactsSchema = v.object({
  id: v.string(),
  status: v.string(),
  prState: v.optional(v.nullable(v.string()), null),
  lastSnapshot: v.optional(
    v.nullable(
      v.object({
        merged: v.optional(v.boolean()),
        checks: v.optional(
          v.nullable(
            v.object({
              failed: v.optional(v.number()),
              total: v.optional(v.number()),
            }),
          ),
          null,
        ),
      }),
    ),
    null,
  ),
});
type WatchStatusFacts = v.InferOutput<typeof watchStatusFactsSchema>;

export function isCompletedPrWatch(watch: Pick<PrWatch, 'autopilotStatus'>) {
  return watch.autopilotStatus === 'complete';
}

export function prWatchAttentionReason(watch: WatchStatusFacts) {
  if (watch.status !== 'attention-needed') return null;
  const checks = watch.lastSnapshot?.checks;
  const failed = checks?.failed;
  const total = checks?.total;
  const failedLabel =
    failed !== undefined && failed > 0
      ? total !== undefined && total > 0
        ? `${failed} of ${total} ${total === 1 ? 'check' : 'checks'} failed`
        : `${failed} ${failed === 1 ? 'check' : 'checks'} failed`
      : 'checks are failing';

  if (watch.lastSnapshot?.merged) return `Merged, but ${failedLabel}.`;
  if (watch.prState === 'closed') return `Closed, but ${failedLabel}.`;
  return `${failedLabel[0]?.toUpperCase()}${failedLabel.slice(1)}.`;
}

export function notificationDisplayMessage(notification: NotificationRecord) {
  if (
    notification.source !== 'watch-pr' ||
    !notification.message.startsWith('Updated watch ')
  ) {
    return notification.message;
  }
  const watch = watchFacts(notification.data);
  if (!watch) return notification.message;
  const reason = prWatchAttentionReason(watch);
  return reason ? `${watch.id}: ${reason}` : notification.message;
}

function watchFacts(value: WebExternalValue): WatchStatusFacts | null {
  const parsed = v.safeParse(watchStatusFactsSchema, value);
  return parsed.success ? parsed.output : null;
}
