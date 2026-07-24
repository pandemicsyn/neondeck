import { describe, expect, it, vi } from 'vitest';
import { dashboardEventStreamPath } from '../../../shared/dashboard-events';
import { createDashboardEventHub } from './event-hub';

describe('dashboard event hub', () => {
  it('uses a Flue observation-shaped URL for the shared dashboard stream', () => {
    expect(dashboardEventStreamPath).toMatch(/\/agents\/[^/]+\/[^/]+$/u);
  });

  it('uses one EventSource and demultiplexes named events', () => {
    const sources: FakeEventSource[] = [];
    const hub = createDashboardEventHub('/api/events', (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    });
    const reviews: unknown[] = [];
    const notifications: unknown[] = [];

    hub.subscribe('review-change', (event) => reviews.push(event));
    hub.subscribe('notification-change', (event) => notifications.push(event));

    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe('/api/events');
    sources[0]?.emit('review-change', { id: 'review-1' });
    expect(reviews).toEqual([{ id: 'review-1' }]);
    expect(notifications).toEqual([]);
    sources[0]?.emit('notification-change', { id: 'notification-1' });
    expect(notifications).toEqual([{ id: 'notification-1' }]);
  });

  it('keeps the singleton connection open and reuses it after unsubscribe', () => {
    const sources: FakeEventSource[] = [];
    const hub = createDashboardEventHub('/api/events', (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source as unknown as EventSource;
    });

    const unsubscribe = hub.subscribe('review-change', () => {});
    unsubscribe();
    hub.subscribe('review-change', () => {});

    expect(sources).toHaveLength(1);
    expect(sources[0]?.closed).toBe(false);
    hub.close();
    expect(sources[0]?.closed).toBe(true);
  });

  it('centralizes open, connection-error, and payload-error handling', async () => {
    const source = new FakeEventSource('/api/events');
    const onOpen = vi.fn<() => void>();
    const onError = vi.fn<(error?: Error | Event) => void>();
    const hub = createDashboardEventHub(
      '/api/events',
      () => source as unknown as EventSource,
    );

    hub.subscribe('review-change', () => {}, onError, onOpen);
    source.emitConnectionEvent('open');
    expect(onOpen).toHaveBeenCalledTimes(1);

    const lateOpen = vi.fn<() => void>();
    hub.subscribe('notification-change', () => {}, onError, lateOpen);
    await Promise.resolve();
    expect(lateOpen).toHaveBeenCalledTimes(1);

    source.emitRaw('review-change', '{not json');
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    source.emitConnectionEvent('error');
    expect(onError.mock.calls.at(-1)?.[0]).toBeInstanceOf(Event);
    hub.close();
  });

  it('recreates the connection after an error and announces the new open', () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources: FakeEventSource[] = [];
    const onOpen = vi.fn<() => void>();
    const hub = createDashboardEventHub(
      '/api/events',
      (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
      { reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 20 },
    );

    hub.subscribe('review-change', () => {}, undefined, onOpen);
    sources[0]?.emitConnectionEvent('open');
    sources[0]?.emitConnectionEvent('error');

    expect(sources[0]?.closed).toBe(true);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(10);
    expect(sources).toHaveLength(2);
    sources[1]?.emitConnectionEvent('open');
    expect(onOpen).toHaveBeenCalledTimes(2);

    hub.close();
    consoleWarn.mockRestore();
    vi.useRealTimers();
  });

  it('provides one centralized connection callback per open', () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources: FakeEventSource[] = [];
    const onConnectionOpen = vi.fn<() => void>();
    const topicOpen = vi.fn<() => void>();
    const hub = createDashboardEventHub(
      '/api/events',
      (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
      { reconnectBaseDelayMs: 10 },
    );

    hub.subscribeConnection(onConnectionOpen);
    hub.subscribe('review-change', () => {});
    hub.subscribe('notification-change', () => {}, undefined, topicOpen);
    sources[0]?.emitConnectionEvent('open');
    sources[0]?.emitConnectionEvent('error');
    vi.advanceTimersByTime(10);
    sources[1]?.emitConnectionEvent('open');

    expect(onConnectionOpen).toHaveBeenCalledTimes(2);
    expect(topicOpen).toHaveBeenCalledTimes(2);
    hub.close();
    consoleWarn.mockRestore();
    vi.useRealTimers();
  });

  it('publishes connection state for recovery-only polling', () => {
    const source = new FakeEventSource('/api/events');
    const states: string[] = [];
    const hub = createDashboardEventHub(
      '/api/events',
      () => source as unknown as EventSource,
    );
    const unsubscribe = hub.subscribeConnectionState(() => {
      states.push(hub.getConnectionState());
    });

    hub.subscribeConnection(() => {});
    source.emitConnectionEvent('open');
    source.emitConnectionEvent('error');

    expect(states).toEqual(['connecting', 'open', 'closed']);
    unsubscribe();
    hub.close();
  });

  it('reconnects when browser-visible heartbeats stop arriving', () => {
    vi.useFakeTimers();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sources: FakeEventSource[] = [];
    const hub = createDashboardEventHub(
      '/api/events',
      (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
      { heartbeatTimeoutMs: 100, reconnectBaseDelayMs: 10 },
    );

    hub.subscribe('review-change', () => {});
    sources[0]?.emitConnectionEvent('open');
    vi.advanceTimersByTime(75);
    sources[0]?.emitRaw(
      'dashboard-heartbeat',
      JSON.stringify({ at: '2026-07-22T00:00:00.000Z' }),
    );
    vi.advanceTimersByTime(75);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(25);
    expect(sources[0]?.closed).toBe(true);
    vi.advanceTimersByTime(10);
    expect(sources).toHaveLength(2);

    hub.close();
    consoleWarn.mockRestore();
    vi.useRealTimers();
  });

  it('isolates throwing subscribers across events and connection callbacks', () => {
    const source = new FakeEventSource('/api/events');
    const hub = createDashboardEventHub(
      '/api/events',
      () => source as unknown as EventSource,
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const failure = new Error('subscriber failed');
    const healthyEvent = vi.fn<(event: unknown) => void>();
    const healthyError = vi.fn<(error?: Error | Event) => void>();
    const healthyOpen = vi.fn<() => void>();

    hub.subscribe(
      'review-change',
      () => {
        throw failure;
      },
      () => {
        throw failure;
      },
      () => {
        throw failure;
      },
    );
    hub.subscribe('review-change', healthyEvent);
    hub.subscribe('notification-change', () => {}, healthyError, healthyOpen);

    source.emitConnectionEvent('open');
    source.emit('review-change', { id: 'review-1' });
    source.emitConnectionEvent('error');

    expect(healthyOpen).toHaveBeenCalledTimes(1);
    expect(healthyEvent).toHaveBeenCalledWith({ id: 'review-1' });
    expect(healthyError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(3);
    hub.close();
    consoleError.mockRestore();
  });
});

class FakeEventSource {
  closed = false;
  readonly readyState = 0;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(readonly url: string) {}

  addEventListener(name: string, listener: EventListener) {
    const listeners = this.listeners.get(name) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  close() {
    this.closed = true;
  }

  emit(name: string, data: unknown) {
    this.emitRaw(name, JSON.stringify(data));
  }

  emitRaw(name: string, data: string) {
    this.dispatch(name, new MessageEvent(name, { data }));
  }

  emitConnectionEvent(name: 'error' | 'open') {
    this.dispatch(name, new Event(name));
  }

  private dispatch(name: string, event: Event) {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}
