import type { NotificationRecord, PrWatch } from '../api';
import { externalRecord, type WebExternalValue } from '../api/schemas';
import * as v from 'valibot';

const watchStatusIdentitySchema = v.object({
  id: v.string(),
  status: v.string(),
});
const watchStatusChecksSchema = v.object({
  failed: v.optional(v.number()),
  total: v.optional(v.number()),
});
type WatchStatusFacts = v.InferOutput<typeof watchStatusIdentitySchema> & {
  prState: string | null;
  lastSnapshot: {
    merged?: boolean;
    checks: v.InferOutput<typeof watchStatusChecksSchema> | null;
  } | null;
};

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
  const record = externalRecord(value);
  if (!record) return null;
  const identity = v.safeParse(watchStatusIdentitySchema, record);
  if (!identity.success) return null;
  const prState = v.safeParse(v.nullable(v.string()), record.prState);
  return {
    ...identity.output,
    prState: prState.success ? prState.output : null,
    lastSnapshot: watchSnapshot(record.lastSnapshot),
  };
}

function watchSnapshot(value: WebExternalValue) {
  const snapshot = externalRecord(value);
  if (!snapshot) return null;
  const merged = v.safeParse(v.boolean(), snapshot.merged);
  const checks = v.safeParse(watchStatusChecksSchema, snapshot.checks);
  const result: NonNullable<WatchStatusFacts['lastSnapshot']> = {
    checks: checks.success ? checks.output : null,
  };
  if (merged.success) result.merged = merged.output;
  return result;
}
