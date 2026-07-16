// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardConfig, NotificationChangeEvent } from '../../api';
import { dashboardEventHub } from '../../api/event-hub';
import { queryKeys } from '../../lib/query';
import { dispatchPluginNavigation, NotificationController } from './controller';

describe('NotificationController integration', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    dashboardEventHub.close();
    container.remove();
    document
      .querySelectorAll('.notification-toast-viewport')
      .forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  it('projects one SSE event once and invalidates notification state without Runtime Overview', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NotificationController config={dashboardConfig()}>
            <div>Dashboard without runtime plugin</div>
          </NotificationController>
        </QueryClientProvider>,
      ),
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => FakeEventSource.instances[0]!.emit(notificationEvent()));

    expect(document.querySelectorAll('.notification-toast')).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.chatSessionActivityRoot,
    });
  });

  it('keeps cache invalidation subscribed when toast presentation is disabled', () => {
    const config = dashboardConfig();
    config.notifications!.toasts!.enabled = false;
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NotificationController config={config}>
            <div>Dashboard</div>
          </NotificationController>
        </QueryClientProvider>,
      ),
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => FakeEventSource.instances[0]!.emit(notificationEvent()));
    expect(document.querySelectorAll('.notification-toast')).toHaveLength(0);
  });

  it('updates one toast for a reconciled retry', () => {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NotificationController config={dashboardConfig()}>
            <div>Dashboard</div>
          </NotificationController>
        </QueryClientProvider>,
      ),
    );
    act(() => FakeEventSource.instances[0]!.emit(notificationEvent()));
    const reconciled = notificationEvent();
    reconciled.action = 'reconciled';
    reconciled.notification.title = 'Verification retry still failing';
    reconciled.notification.occurrenceCount = 2;
    act(() => FakeEventSource.instances[0]!.emit(reconciled));
    expect(document.querySelectorAll('.notification-toast')).toHaveLength(1);
    expect(document.querySelector('.notification-toast h2')?.textContent).toBe(
      'Verification retry still failing',
    );
  });

  it('reports whether a dashboard plugin handled navigation', () => {
    expect(dispatchPluginNavigation('missing')).toBe(false);
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<{ handled: boolean }>).detail;
      detail.handled = true;
    };
    window.addEventListener('neondeck:navigate', handle);
    expect(dispatchPluginNavigation('runtime-overview')).toBe(true);
    window.removeEventListener('neondeck:navigate', handle);
  });

  it('keeps persistent toasts and one SSE connection across equal config refetches', () => {
    const render = (config: DashboardConfig) =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <NotificationController config={config}>
            <div>Dashboard</div>
          </NotificationController>
        </QueryClientProvider>,
      );
    act(() => render(dashboardConfig()));
    act(() => FakeEventSource.instances[0]!.emit(notificationEvent()));
    act(() => render(dashboardConfig()));

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(document.querySelectorAll('.notification-toast')).toHaveLength(1);
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private listeners = new Map<string, EventListener>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener) {
    this.listeners.set(name, listener);
  }

  close() {}

  emit(event: NotificationChangeEvent) {
    this.listeners.get('notification-change')?.(
      new MessageEvent('notification-change', {
        data: JSON.stringify(event),
      }),
    );
  }
}

function notificationEvent(): NotificationChangeEvent {
  return {
    id: 'note-1',
    action: 'created',
    notification: {
      id: 'note-1',
      level: 'attention',
      title: 'Verification needs attention',
      message: 'Typechecking failed for neondeck #418.',
      source: 'autopilot',
      sourceId: 'prepared-diff:one:verify:failed',
      data: { preparedDiffId: 'diff-1' },
      readAt: null,
      resolvedAt: null,
      occurrenceCount: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    },
    changedAt: '2026-07-11T00:00:00.000Z',
  };
}

function dashboardConfig(): DashboardConfig {
  return {
    schemaVersion: 1,
    display: { width: 2560, height: 720 },
    theme: 'dark',
    appearance: { density: 'comfortable' },
    notifications: {
      toasts: {
        enabled: true,
        minimumLevel: 'ready',
        readyDurationMs: 3_600_000,
        maxVisible: 3,
      },
    },
    layout: { columns: 1, rows: 1, regions: [] },
  };
}
