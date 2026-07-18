// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreparedRevisionComposer } from './PreparedRevisionComposer';

describe('PreparedRevisionComposer', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
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
    vi.restoreAllMocks();
  });

  it('resets draft text when the keyed finding identity changes', async () => {
    const onConfirm =
      vi.fn<(input: { reason: string; runRevisionNow: boolean }) => void>();
    const renderFinding = (findingId: string, reason: string) => (
      <PreparedRevisionComposer
        actionLabel="Request revision"
        defaultReason={reason}
        isPending={false}
        key={findingId}
        onCancel={vi.fn<() => void>()}
        onConfirm={onConfirm}
        requireReason
        showRunNow={false}
      />
    );

    await act(async () => root.render(renderFinding('finding-a', 'Reason A')));
    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('Reason A');
    await act(async () => {
      if (!textarea) return;
      textarea.value = 'Edited reason A';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => root.render(renderFinding('finding-b', 'Reason B')));
    expect(container.querySelector('textarea')?.value).toBe('Reason B');
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith({
      reason: 'Reason B',
      runRevisionNow: true,
    });
  });
});
