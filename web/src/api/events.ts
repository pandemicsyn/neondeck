import type {
  ConfigChangeEvent,
  ChatSessionCommandChangeEvent,
  ChatSessionChangeEvent,
  NotificationChangeEvent,
  PrReviewChangeEvent,
} from './types';
import { dashboardEventHub } from './event-hub';

export function openConfigEventStream(
  onEvent: (event: ConfigChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe('config-change', onEvent, onError, onOpen);
}

export function openNotificationEventStream(
  onEvent: (event: NotificationChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'notification-change',
    onEvent,
    onError,
    onOpen,
  );
}

export function openChatSessionEventStream(
  onEvent: (event: ChatSessionChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'chat-session-change',
    onEvent,
    onError,
    onOpen,
  );
}

export function openChatSessionCommandEventStream(
  onEvent: (event: ChatSessionCommandChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe(
    'chat-session-command-change',
    onEvent,
    onError,
    onOpen,
  );
}

export function openPrReviewEventStream(
  onEvent: (event: PrReviewChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return dashboardEventHub.subscribe('review-change', onEvent, onError, onOpen);
}
