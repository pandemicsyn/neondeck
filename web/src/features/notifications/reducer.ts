import { notificationExpiresAt, notificationQualifies } from './policy';
import { MAX_QUEUED_TOASTS, type ToastAction, type ToastState } from './types';

export const initialToastState: ToastState = { items: [] };

export function toastReducer(
  state: ToastState,
  action: ToastAction,
): ToastState {
  if (action.type === 'clear') return initialToastState;
  if (action.type === 'reconfigure') {
    return {
      items: action.config.enabled
        ? state.items
            .filter((item) =>
              notificationQualifies(item.notification, action.config),
            )
            .map((item) => ({
              ...item,
              expiresAt: notificationExpiresAt(
                item.notification,
                action.config,
                action.now,
              ),
            }))
        : [],
    };
  }
  if (action.type === 'remove') {
    return {
      items: state.items.filter((item) => item.notification.id !== action.id),
    };
  }

  const { event, config, now } = action;
  if (event.action === 'read' || event.action === 'resolved') {
    return {
      items: state.items.filter(
        (item) => item.notification.id !== event.notification.id,
      ),
    };
  }

  const existingIndex = state.items.findIndex(
    (item) => item.notification.id === event.notification.id,
  );
  if (
    existingIndex >= 0 &&
    !notificationQualifies(event.notification, config)
  ) {
    return {
      items: state.items.filter(
        (item) => item.notification.id !== event.notification.id,
      ),
    };
  }
  if (existingIndex < 0 && !notificationQualifies(event.notification, config)) {
    return state;
  }

  const nextItem = {
    notification: event.notification,
    admittedAt:
      existingIndex >= 0 ? state.items[existingIndex]!.admittedAt : now,
    expiresAt: notificationExpiresAt(event.notification, config, now),
  };
  if (existingIndex >= 0) {
    const items = [...state.items];
    items[existingIndex] = nextItem;
    return { items };
  }

  const items = [...state.items, nextItem];
  while (items.length > MAX_QUEUED_TOASTS) {
    const timedIndex = items.findIndex((item) => item.expiresAt !== null);
    if (timedIndex < 0) {
      items.pop();
      break;
    }
    items.splice(timedIndex, 1);
  }
  return { items };
}
