import { describe, expect, it, vi } from 'vitest';
import { createDashboardEventHub } from './event-hub';

describe('dashboard event hub', () => {
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
