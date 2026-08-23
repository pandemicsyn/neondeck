// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../api';
import { UpdateBanner } from './update-banner';

describe('UpdateBanner', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let status: UpdateStatus;
  let failDismiss: boolean;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    status = updateStatus();
    failDismiss = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/dismiss') && init?.method === 'POST') {
          if (failDismiss) {
            return Response.json(
              { message: 'Could not dismiss this update.' },
              { status: 500 },
            );
          }
          status = { ...status, dismissed: true };
          return Response.json(status);
        }
        if (url.includes('/notifications/') && init?.method === 'POST') {
          return Response.json({ ok: true });
        }
        return Response.json(status);
      }),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('links an available release to upgrade instructions and release notes', async () => {
    await render();

    expect(container.querySelector('output')?.textContent).toContain(
      'Neondeck 1.0.0-beta.39 is available',
    );
    expect(link('Upgrade guide')?.href).toBe(
      'https://neondeck.dev/docs/upgrading/',
    );
    expect(link('Release notes')?.href).toBe(
      'https://github.com/pandemicsyn/neondeck/releases/tag/v1.0.0-beta.39',
    );
  });

  it('marks the API-provided notification id as read', async () => {
    status = { ...status, notificationId: 'server-provided-update-id' };
    await render();
    await act(async () => link('Upgrade guide')?.click());

    expect(fetch).toHaveBeenCalledWith(
      '/api/notifications/server-provided-update-id/read',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('dismisses only the currently advertised version', async () => {
    await render();
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss the 1.0.0-beta.39 update notice"]',
    )!;
    await act(async () => {
      dismiss.click();
      await vi.waitFor(() => {
        expect(container.querySelector('.update-banner')).toBeNull();
      });
    });

    expect(fetch).toHaveBeenCalledWith(
      '/api/update-status/1.0.0-beta.39/dismiss',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('asks for a reload when the dashboard and server versions differ', async () => {
    status = {
      ...status,
      currentVersion: '1.0.0-beta.40',
      latestVersion: '1.0.0-beta.40',
      updateAvailable: false,
    };
    await render();

    expect(container.textContent).toContain(
      'Reload this dashboard to use the matching interface.',
    );
    expect(container.querySelector('button')?.textContent).toBe('Reload');
  });

  it('keeps the notice visible and reports a dismissal failure', async () => {
    failDismiss = true;
    await render();
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[aria-label="Dismiss the 1.0.0-beta.39 update notice"]',
    )!;
    await act(async () => {
      dismiss.click();
      await vi.waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(
          'Could not dismiss this update.',
        );
      });
    });

    expect(container.querySelector('.update-banner')).not.toBeNull();
  });

  async function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UpdateBanner dashboardVersion="1.0.0-beta.38" />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('.update-banner')).not.toBeNull();
    });
  }

  function link(label: string) {
    return [...container.querySelectorAll('a')].find(
      (anchor) => anchor.textContent === label,
    );
  }
});

function updateStatus(): UpdateStatus {
  return {
    enabled: true,
    currentVersion: '1.0.0-beta.38',
    latestVersion: '1.0.0-beta.39',
    channel: 'next',
    updateAvailable: true,
    dismissed: false,
    notificationId: 'neondeck-update:1.0.0-beta.39',
    docsUrl: 'https://neondeck.dev/docs/upgrading/',
    releaseUrl:
      'https://github.com/pandemicsyn/neondeck/releases/tag/v1.0.0-beta.39',
    checkedAt: '2026-08-23T12:00:00.000Z',
  };
}
