// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRecord } from '../../api';
import { ToastRow } from './toast-row';

describe('ToastRow', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('uses polite and assertive live roles by severity', () => {
    render(note({ level: 'ready' }));
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    render(note({ level: 'urgent' }));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('pauses automatic dismissal while focus is inside', () => {
    const onDismiss = vi.fn<() => void>();
    render(note(), onDismiss);
    const openButton = container.querySelector('button:last-of-type')!;

    act(() =>
      openButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true })),
    );
    act(() => vi.advanceTimersByTime(2_000));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() =>
      openButton.dispatchEvent(
        new FocusEvent('focusout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      ),
    );
    act(() => vi.advanceTimersByTime(1_000));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('dismisses locally with Escape without invoking a durable action', () => {
    const onDismiss = vi.fn<() => void>();
    const onAcknowledge = vi.fn<() => void>();
    render(note({ level: 'attention' }), onDismiss, onAcknowledge);
    const article = container.querySelector('article')!;

    act(() =>
      article.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onAcknowledge).not.toHaveBeenCalled();
  });

  it('disables durable actions while one is pending', () => {
    act(() =>
      root.render(
        <ToastRow
          item={{ notification: note(), admittedAt: 1_000, expiresAt: 2_000 }}
          onAcknowledge={vi.fn<() => void>()}
          onDismiss={vi.fn<() => void>()}
          onOpen={vi.fn<() => void>()}
          pending
          target={{
            kind: 'plugin',
            pluginId: 'runtime-overview',
            label: 'Open notifications',
          }}
        />,
      ),
    );
    expect(
      [...container.querySelectorAll('.notification-toast-actions button')].map(
        (button) => (button as HTMLButtonElement).disabled,
      ),
    ).toEqual([true, true]);
    expect(container.querySelector('article')?.getAttribute('aria-busy')).toBe(
      'true',
    );
  });

  function render(
    notification: NotificationRecord,
    onDismiss = vi.fn<() => void>(),
    onAcknowledge = vi.fn<() => void>(),
  ) {
    act(() =>
      root.render(
        <ToastRow
          item={{
            notification,
            admittedAt: 1_000,
            expiresAt: notification.level === 'ready' ? 2_000 : null,
          }}
          onAcknowledge={onAcknowledge}
          onDismiss={onDismiss}
          onOpen={vi.fn<() => void>()}
          pending={false}
          target={{
            kind: 'plugin',
            pluginId: 'runtime-overview',
            label: 'Open notifications',
          }}
        />,
      ),
    );
  }
});

function note(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: 'note',
    level: 'ready',
    title: 'Work ready',
    message: 'A prepared change is ready.',
    source: 'autopilot',
    sourceId: 'one',
    data: { preparedDiffId: 'diff-1' },
    readAt: null,
    resolvedAt: null,
    occurrenceCount: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}
