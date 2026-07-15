import type {
  ConfigChangeEvent,
  ChatSessionChangeEvent,
  NotificationChangeEvent,
  PrReviewChangeEvent,
} from './types';

export function openConfigEventStream(
  onEvent: (event: ConfigChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/config');
  source.addEventListener('config-change', (event) => {
    parseEventData('config-change', event, onEvent, onError);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export function openNotificationEventStream(
  onEvent: (event: NotificationChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/notifications');
  source.addEventListener('notification-change', (event) => {
    parseEventData('notification-change', event, onEvent, onError);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export function openChatSessionEventStream(
  onEvent: (event: ChatSessionChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/sessions');
  source.addEventListener('chat-session-change', (event) => {
    parseEventData('chat-session-change', event, onEvent, onError);
  });
  if (onError) source.addEventListener('error', onError);

  return () => source.close();
}

export function openPrReviewEventStream(
  onEvent: (event: PrReviewChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/events/reviews');
  source.addEventListener('review-change', (event) => {
    parseEventData('review-change', event, onEvent, onError);
  });
  if (onError) source.addEventListener('error', onError);
  if (onOpen) source.addEventListener('open', onOpen);

  return () => source.close();
}

function parseEventData<T>(
  eventName: string,
  event: MessageEvent,
  onEvent: (event: T) => void,
  onError?: (error?: Error | Event) => void,
) {
  try {
    onEvent(JSON.parse(event.data) as T);
  } catch (cause) {
    const error = new Error(
      `Invalid ${eventName} event payload: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    if (onError) onError(error);
    else console.warn(error.message);
  }
}
