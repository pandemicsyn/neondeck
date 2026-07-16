type EventSubscriber<T> = {
  onError?: (error?: Error | Event) => void;
  onEvent: (event: T) => void;
  onOpen?: () => void;
};

type EventSourceFactory = (url: string) => EventSource;

const createNativeEventSource: EventSourceFactory = (sourceUrl) =>
  new EventSource(sourceUrl);

export type DashboardEventHub = ReturnType<typeof createDashboardEventHub>;

export function createDashboardEventHub(
  url = '/api/events',
  createSource: EventSourceFactory = createNativeEventSource,
) {
  const subscribers = new Map<string, Set<EventSubscriber<unknown>>>();
  const boundEventNames = new Set<string>();
  let source: EventSource | null = null;
  let isOpen = false;

  const notifyConnectionError = (event: Event) => {
    isOpen = false;
    const callbacks = new Set<(error?: Error | Event) => void>();
    for (const topicSubscribers of subscribers.values()) {
      for (const subscriber of topicSubscribers) {
        if (subscriber.onError) callbacks.add(subscriber.onError);
      }
    }
    for (const callback of callbacks) invokeSubscriber(callback, event);
  };

  const notifyOpen = () => {
    isOpen = true;
    const callbacks = new Set<() => void>();
    for (const topicSubscribers of subscribers.values()) {
      for (const subscriber of topicSubscribers) {
        if (subscriber.onOpen) callbacks.add(subscriber.onOpen);
      }
    }
    for (const callback of callbacks) invokeSubscriber(callback);
  };

  const bindEventName = (eventName: string) => {
    if (!source || boundEventNames.has(eventName)) return;
    boundEventNames.add(eventName);
    source.addEventListener(eventName, (event) => {
      const topicSubscribers = subscribers.get(eventName);
      if (!topicSubscribers?.size) return;
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

  const connect = () => {
    if (
      source ||
      (createSource === createNativeEventSource &&
        typeof EventSource === 'undefined')
    ) {
      return;
    }
    source = createSource(url);
    source.addEventListener('error', notifyConnectionError);
    source.addEventListener('open', notifyOpen);
    for (const eventName of subscribers.keys()) bindEventName(eventName);
  };

  return {
    subscribe<T>(
      eventName: string,
      onEvent: (event: T) => void,
      onError?: (error?: Error | Event) => void,
      onOpen?: () => void,
    ) {
      if (
        createSource === createNativeEventSource &&
        typeof EventSource === 'undefined'
      ) {
        return () => {};
      }
      const subscriber: EventSubscriber<T> = { onEvent, onError, onOpen };
      const topicSubscribers =
        subscribers.get(eventName) ?? new Set<EventSubscriber<unknown>>();
      topicSubscribers.add(subscriber as EventSubscriber<unknown>);
      subscribers.set(eventName, topicSubscribers);
      connect();
      bindEventName(eventName);

      if (isOpen && onOpen) {
        queueMicrotask(() => {
          if (topicSubscribers.has(subscriber as EventSubscriber<unknown>)) {
            invokeSubscriber(onOpen);
          }
        });
      }

      return () => {
        topicSubscribers.delete(subscriber as EventSubscriber<unknown>);
        if (topicSubscribers.size === 0) subscribers.delete(eventName);
      };
    },
    close() {
      source?.close();
      source = null;
      isOpen = false;
      boundEventNames.clear();
    },
  };
}

function parseEventData(eventName: string, event: MessageEvent<string>) {
  try {
    return JSON.parse(event.data) as unknown;
  } catch (cause) {
    return new Error(
      `Invalid ${eventName} event payload: ${cause instanceof Error ? cause.message : String(cause)}`,
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

export const dashboardEventHub = createDashboardEventHub();
