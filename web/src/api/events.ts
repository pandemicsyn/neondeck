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
  return configEvents.subscribe(onEvent, onError);
}

export function openNotificationEventStream(
  onEvent: (event: NotificationChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  return notificationEvents.subscribe(onEvent, onError);
}

export function openChatSessionEventStream(
  onEvent: (event: ChatSessionChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
) {
  return chatSessionEvents.subscribe(onEvent, onError);
}

export function openPrReviewEventStream(
  onEvent: (event: PrReviewChangeEvent) => void,
  onError?: (error?: Error | Event) => void,
  onOpen?: () => void,
) {
  return prReviewEvents.subscribe(onEvent, onError, onOpen);
}

type EventSubscriber<T> = {
  onError?: (error?: Error | Event) => void;
  onEvent: (event: T) => void;
  onOpen?: () => void;
};

function createSharedEventStream<T>(url: string, eventName: string) {
  const subscribers = new Set<EventSubscriber<T>>();
  let source: EventSource | null = null;

  const connect = () => {
    if (source || typeof EventSource === 'undefined') return;
    source = new EventSource(url);
    source.addEventListener(eventName, (event) => {
      const parsed = parseEventData<T>(eventName, event);
      if (parsed instanceof Error) {
        let handled = false;
        for (const subscriber of subscribers) {
          if (!subscriber.onError) continue;
          handled = true;
          subscriber.onError(parsed);
        }
        if (!handled) console.warn(parsed.message);
        return;
      }
      for (const subscriber of subscribers) subscriber.onEvent(parsed);
    });
    source.addEventListener('error', (event) => {
      for (const subscriber of subscribers) subscriber.onError?.(event);
    });
    source.addEventListener('open', () => {
      for (const subscriber of subscribers) subscriber.onOpen?.();
    });
  };

  return {
    subscribe(
      onEvent: (event: T) => void,
      onError?: (error?: Error | Event) => void,
      onOpen?: () => void,
    ) {
      if (typeof EventSource === 'undefined') return () => {};
      const subscriber = { onEvent, onError, onOpen };
      subscribers.add(subscriber);
      connect();
      return () => {
        subscribers.delete(subscriber);
        if (subscribers.size > 0) return;
        source?.close();
        source = null;
      };
    },
  };
}

function parseEventData<T>(eventName: string, event: MessageEvent) {
  try {
    return JSON.parse(event.data) as T;
  } catch (cause) {
    return new Error(
      `Invalid ${eventName} event payload: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

const configEvents = createSharedEventStream<ConfigChangeEvent>(
  '/api/events/config',
  'config-change',
);
const notificationEvents = createSharedEventStream<NotificationChangeEvent>(
  '/api/events/notifications',
  'notification-change',
);
const chatSessionEvents = createSharedEventStream<ChatSessionChangeEvent>(
  '/api/events/sessions',
  'chat-session-change',
);
const prReviewEvents = createSharedEventStream<PrReviewChangeEvent>(
  '/api/events/reviews',
  'review-change',
);
