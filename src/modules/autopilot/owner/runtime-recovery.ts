import type { RuntimePaths } from '../../../runtime-home';
import {
  listNotifications,
  resolveNotification,
  type NotificationRecord,
} from '../../app-state';
import { readWatch, transitionWatchAutopilot } from '../../watches';
import * as v from 'valibot';

const autopilotOwnerNotificationSource = 'autopilot-owner';
const dispatchBlockedSuffix = ':dispatch-blocked';

export function autopilotDispatchBlockedSourceId(watchId: string) {
  return `${watchId}${dispatchBlockedSuffix}`;
}

export async function reconcileTransientAutopilotRuntimeBlocks(
  paths: RuntimePaths,
  options: { watchId?: string; rearm?: boolean } = {},
) {
  const notifications = await listNotifications(paths);
  const transient = notifications.filter(
    (notification) =>
      isTransientRuntimeBlockNotification(notification) &&
      (!options.watchId ||
        notificationWatchId(notification) === options.watchId),
  );
  let rearmed = 0;

  for (const notification of transient) {
    const watchId = notificationWatchId(notification);
    if (
      options.rearm &&
      watchId &&
      readWatch(paths, watchId)?.autopilotStatus === 'blocked' &&
      !hasOtherUnresolvedOwnerBlock(notifications, watchId, notification.id)
    ) {
      const watch = transitionWatchAutopilot(paths, watchId, {
        from: 'blocked',
        to: 'watching',
      });
      if (watch) rearmed += 1;
    }
    await resolveNotification(notification.id, paths);
  }

  return { resolved: transient.length, rearmed };
}

function isTransientRuntimeBlockNotification(notification: NotificationRecord) {
  return (
    notification.source === autopilotOwnerNotificationSource &&
    notification.sourceId?.endsWith(dispatchBlockedSuffix) === true &&
    notification.message
      .toLowerCase()
      .includes('runtime is temporarily unavailable')
  );
}

function hasOtherUnresolvedOwnerBlock(
  notifications: NotificationRecord[],
  watchId: string,
  transientNotificationId: string,
) {
  return notifications.some(
    (notification) =>
      notification.id !== transientNotificationId &&
      notification.source === autopilotOwnerNotificationSource &&
      notification.level === 'attention' &&
      notificationWatchId(notification) === watchId,
  );
}

function notificationWatchId(notification: NotificationRecord) {
  const data = v.safeParse(
    v.object({ watchId: v.optional(v.string()) }),
    notification.data,
  );
  if (data.success && data.output.watchId) return data.output.watchId;
  return notification.sourceId?.endsWith(dispatchBlockedSuffix)
    ? notification.sourceId.slice(0, -dispatchBlockedSuffix.length)
    : null;
}
