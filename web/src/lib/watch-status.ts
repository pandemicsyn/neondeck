import type { NotificationRecord, PrWatch } from '../api';

type WatchStatusFacts = Pick<
  PrWatch,
  'id' | 'status' | 'prState' | 'lastSnapshot'
>;

export function isCompletedPrWatch(watch: Pick<PrWatch, 'autopilotStatus'>) {
  return watch.autopilotStatus === 'complete';
}

export function prWatchAttentionReason(watch: WatchStatusFacts) {
  if (watch.status !== 'attention-needed') return null;
  const checks = watch.lastSnapshot?.checks;
  const failed = checks?.failed;
  const total = checks?.total;
  const failedLabel =
    typeof failed === 'number' && failed > 0
      ? typeof total === 'number' && total > 0
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

function watchFacts(value: unknown): WatchStatusFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.status !== 'string') {
    return null;
  }
  return {
    id: record.id,
    status: record.status,
    prState: typeof record.prState === 'string' ? record.prState : null,
    lastSnapshot:
      record.lastSnapshot && typeof record.lastSnapshot === 'object'
        ? (record.lastSnapshot as PrWatch['lastSnapshot'])
        : null,
  };
}
