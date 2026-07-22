// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StopPrWatchButton } from './StopPrWatchButton';

describe('StopPrWatchButton', () => {
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

  it('requires confirmation before stopping a durable watch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          action: 'autopilot_watch_stop',
          changed: true,
          message: 'Stopped watch.',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <StopPrWatchButton watchId="pandemicsyn/neondeck#124" />
        </QueryClientProvider>,
      ),
    );

    act(() =>
      button('Stop watching pandemicsyn/neondeck#124').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () =>
      button('Confirm stop watching pandemicsyn/neondeck#124').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/watches/pandemicsyn%2Fneondeck%23124/autopilot/control',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operation: 'stop' }),
      }),
    );

    function button(label: string) {
      return container.querySelector(
        `button[aria-label="${label}"]`,
      ) as HTMLButtonElement;
    }
  });
});
