import {
  dashboardEventStreamPath,
  dashboardHeartbeatEventName,
} from '../../../shared/dashboard-events';
import {
  externalErrorMessage,
  webExternalValueSchema,
  type WebExternalValue,
} from './schemas';
import * as v from 'valibot';

type EventSubscriber<T> = {
  onError?: (error?: Error | Event) => void;
  onEvent: (event: T) => void;
  onOpen?: () => void;
};

type ConnectionSubscriber = {
  onError?: (error?: Error | Event) => void;
  onOpen: () => void;
};

type EventSourceFactory = (url: string) => EventSource;

type DashboardEventHubOptions = {
  heartbeatTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
};

export type DashboardEventConnectionState =
  'idle' | 'connecting' | 'open' | 'closed';

const defaultHeartbeatTimeoutMs = 65_000;
const defaultReconnectBaseDelayMs = 1_000;
const defaultReconnectMaxDelayMs = 15_000;

const createNativeEventSource: EventSourceFactory = (sourceUrl) =>
  new EventSource(sourceUrl);

export type DashboardEventHub = ReturnType<typeof createDashboardEventHub>;

export function createDashboardEventHub(
  url = '/api/events',
  createSource: EventSourceFactory = createNativeEventSource,
  options: DashboardEventHubOptions = {},
) {
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? defaultHeartbeatTimeoutMs;
  const reconnectBaseDelayMs =
    options.reconnectBaseDelayMs ?? defaultReconnectBaseDelayMs;
  const reconnectMaxDelayMs =
    options.reconnectMaxDelayMs ?? defaultReconnectMaxDelayMs;
  const subscribers = new Map<string, Set<EventSubscriber<WebExternalValue>>>();
  const connectionSubscribers = new Set<ConnectionSubscriber>();
  const connectionStateSubscribers = new Set<() => void>();
  const boundEventNames = new Set<string>();
  let source: EventSource | null = null;
  let isOpen = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionState: DashboardEventConnectionState = 'idle';

  const setConnectionState = (next: DashboardEventConnectionState) => {
    if (connectionState === next) return;
    connectionState = next;
    for (const listener of connectionStateSubscribers) {
      invokeSubscriber(listener);
    }
  };

  const clearHeartbeatTimer = () => {
    if (!heartbeatTimer) return;
    clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const scheduleHeartbeatTimeout = () => {
    clearHeartbeatTimer();
    if (!isOpen || heartbeatTimeoutMs <= 0) return;
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      reconnect('heartbeat timed out');
    }, heartbeatTimeoutMs);
  };

  const recordActivity = () => {
    if (isOpen) scheduleHeartbeatTimeout();
  };

  const notifyConnectionError = (candidate: EventSource, event: Event) => {
    if (candidate !== source) return;
    isOpen = false;
    setConnectionState('closed');
    const callbacks = new Set<(error?: Error | Event) => void>();
    for (const topicSubscribers of subscribers.values()) {
      for (const subscriber of topicSubscribers) {
        if (subscriber.onError) callbacks.add(subscriber.onError);
      }
    }
    for (const subscriber of connectionSubscribers) {
      if (subscriber.onError) callbacks.add(subscriber.onError);
    }
    for (const callback of callbacks) invokeSubscriber(callback, event);
    reconnect('connection closed');
  };

  const notifyOpen = (candidate: EventSource) => {
    if (candidate !== source) return;
    isOpen = true;
    setConnectionState('open');
    reconnectAttempt = 0;
    recordActivity();
    const callbacks = new Set<() => void>();
    for (const topicSubscribers of subscribers.values()) {
      for (const subscriber of topicSubscribers) {
        if (subscriber.onOpen) callbacks.add(subscriber.onOpen);
      }
    }
    for (const subscriber of connectionSubscribers) {
      callbacks.add(subscriber.onOpen);
    }
    for (const callback of callbacks) invokeSubscriber(callback);
  };

  const bindEventName = (eventName: string) => {
    if (!source || boundEventNames.has(eventName)) return;
    const candidate = source;
    boundEventNames.add(eventName);
    candidate.addEventListener(eventName, (event) => {
      if (candidate !== source) return;
      recordActivity();
      const topicSubscribers = subscribers.get(eventName);
      if (!topicSubscribers?.size) return;
      // SAFETY: EventSource dispatches named server events as MessageEvent
      // instances whose data field contains the serialized event payload.
      const parsed = parseEventData(eventName, event as MessageEvent<string>);
      if (parsed instanceof Error) {
        let handled = false;
        for (const subscriber of topicSubscribers) {
          if (!subscriber.onError) continue;
          handled = true;
          invokeSubscriber(subscriber.onError, parsed);
        }
        if (!handled) console.warn(parsed.message);
        return;
      }
      for (const subscriber of topicSubscribers) {
        invokeSubscriber(subscriber.onEvent, parsed);
      }
    });
  };

  function reconnect(reason: string) {
    const activeSource = source;
    if (!activeSource || reconnectTimer) return;
    source = null;
    isOpen = false;
    setConnectionState('closed');
    boundEventNames.clear();
    clearHeartbeatTimer();
    activeSource.close();
    if (subscribers.size === 0 && connectionSubscribers.size === 0) return;

    const delay = Math.min(
      reconnectMaxDelayMs,
      reconnectBaseDelayMs * 2 ** reconnectAttempt,
    );
    reconnectAttempt += 1;
    console.warn(
      `[neondeck] dashboard event stream ${reason}; reconnecting in ${delay}ms`,
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (
      source ||
      reconnectTimer ||
      (createSource === createNativeEventSource &&
        !('EventSource' in globalThis))
    ) {
      return;
    }
    const candidate = createSource(url);
    source = candidate;
    setConnectionState('connecting');
    candidate.addEventListener('error', (event) =>
      notifyConnectionError(candidate, event),
    );
    candidate.addEventListener('open', () => notifyOpen(candidate));
    candidate.addEventListener(dashboardHeartbeatEventName, () => {
      if (candidate === source) recordActivity();
    });
    for (const eventName of subscribers.keys()) bindEventName(eventName);
  }

  return {
    getConnectionState() {
      return connectionState;
    },
    subscribeConnectionState(listener: () => void) {
      connectionStateSubscribers.add(listener);
      return () => connectionStateSubscribers.delete(listener);
    },
    subscribeConnection(
      onOpen: () => void,
      onError?: (error?: Error | Event) => void,
    ) {
      if (
        createSource === createNativeEventSource &&
        !('EventSource' in globalThis)
      ) {
        return () => {};
      }
      const subscriber: ConnectionSubscriber = { onOpen, onError };
      connectionSubscribers.add(subscriber);
      connect();
      if (isOpen) {
        queueMicrotask(() => {
          if (connectionSubscribers.has(subscriber)) {
            invokeSubscriber(onOpen);
          }
        });
      }
      return () => connectionSubscribers.delete(subscriber);
    },
    subscribe<T>(
      eventName: string,
      onEvent: (event: T) => void,
      onError?: (error?: Error | Event) => void,
      onOpen?: () => void,
    ) {
      if (
        createSource === createNativeEventSource &&
        !('EventSource' in globalThis)
      ) {
        return () => {};
      }
      const subscriber: EventSubscriber<WebExternalValue> = {
        // SAFETY: subscribe<T> binds T to this event name at the call site; the
        // hub preserves that pairing and never sends one topic to another.
        onEvent: (event) => onEvent(event as T),
        onError,
        onOpen,
      };
      const topicSubscribers =
        subscribers.get(eventName) ??
        new Set<EventSubscriber<WebExternalValue>>();
      topicSubscribers.add(subscriber);
      subscribers.set(eventName, topicSubscribers);
      connect();
      bindEventName(eventName);

      if (isOpen && onOpen) {
        queueMicrotask(() => {
          if (topicSubscribers.has(subscriber)) {
            invokeSubscriber(onOpen);
          }
        });
      }

      return () => {
        topicSubscribers.delete(subscriber);
        if (topicSubscribers.size === 0) subscribers.delete(eventName);
      };
    },
    close() {
      clearReconnectTimer();
      clearHeartbeatTimer();
      source?.close();
      source = null;
      isOpen = false;
      setConnectionState('idle');
      reconnectAttempt = 0;
      boundEventNames.clear();
      connectionSubscribers.clear();
      connectionStateSubscribers.clear();
    },
  };
}

function parseEventData(eventName: string, event: MessageEvent<string>) {
  try {
    return v.parse(webExternalValueSchema, JSON.parse(event.data));
  } catch (cause) {
    return new Error(
      `Invalid ${eventName} event payload: ${externalErrorMessage(cause)}`,
    );
  }
}

function invokeSubscriber<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  ...args: TArgs
) {
  try {
    callback(...args);
  } catch (error) {
    console.error('[neondeck] dashboard event subscriber failed', error);
  }
}

export const dashboardEventHub = createDashboardEventHub(
  dashboardEventStreamPath,
);

if (import.meta.hot) {
  import.meta.hot.dispose(() => dashboardEventHub.close());
}
