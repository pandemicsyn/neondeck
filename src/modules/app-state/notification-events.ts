import type { NotificationRecord } from './types';

export type NotificationEventAction =
  'created' | 'read' | 'reconciled' | 'resolved';

export type NotificationEvent = {
  id: string;
  action: NotificationEventAction;
  notification: NotificationRecord;
  changedAt: string;
};

type NotificationEventListener = (event: NotificationEvent) => void;

const listeners = new Set<NotificationEventListener>();

export function publishNotificationEvent(event: NotificationEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      listeners.delete(listener);
      console.error('[neondeck] notification event listener failed', error);
    }
  }
}

export function subscribeNotificationEvents(
  listener: NotificationEventListener,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatNotificationServerSentEvent(event: NotificationEvent) {
  return [
    'event: notification-change',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
