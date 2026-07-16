import type {
  ConfigChangeEvent,
  ChatSessionChangeEvent,
  NotificationChangeEvent,
  PrReviewChangeEvent,
} from './types';
import { dashboardEventHub } from './event-hub';

export function openConfigEventStream(
  onEvent: (event: ConfigChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  return dashboardEventHub.subscribe('config-change', onEvent, onError);
}

export function openNotificationEventStream(
  onEvent: (event: NotificationChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  return dashboardEventHub.subscribe('notification-change', onEvent, onError);
}

export function openChatSessionEventStream(
  onEvent: (event: ChatSessionChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  return dashboardEventHub.subscribe('chat-session-change', onEvent, onError);
}

export function openPrReviewEventStream(
  onEvent: (event: PrReviewChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe('review-change', onEvent, onError, onOpen);
}
