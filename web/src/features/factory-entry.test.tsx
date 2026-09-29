// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryNav, FactoryPage } from './factory-entry';

vi.mock('./factory/FactoryPage', () => ({
  FactoryPage: () => <div>Factory workspace</div>,
}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});
async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <FactoryNav />
        <FactoryPage />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
it.each([false, true])(
  'gates the navigation and direct page on the feature flag (%s)',
  async (factory) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ factory }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await render();
    expect(Boolean(container.querySelector('a[href="/factory"]'))).toBe(
      factory,
    );
    expect(container.textContent?.includes('Factory workspace')).toBe(factory);
    expect(container.textContent?.includes('Factory is unavailable.')).toBe(
      !factory,
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/api/features');
  },
);
it('keeps factory hidden while feature discovery is pending or fails', async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  await render();
  expect(container.querySelector('a[href="/factory"]')).toBeNull();
  expect(container.textContent).toBe('Loading…');
  await act(async () => reject(new Error('offline')));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(container.querySelector('a[href="/factory"]')).toBeNull();
  expect(container.textContent).toContain('Could not load enabled features.');
  expect(container.textContent).not.toContain('Factory workspace');
});
