// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { FactoryCodingSetup } from './FactoryCodingSetup';
import { codingState } from './FactoryCoding.fixtures';

vi.mock('../../api/factory-coding', () => ({
  getFactoryCodingState: vi.fn<() => Promise<ReturnType<typeof codingState>>>(
    async () => codingState(),
  ),
  saveFactoryCodingConfig: vi.fn<() => Promise<void>>(),
}));

it('retains unsaved coding settings when setup is closed and reopened', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const click = async (label: string) =>
    act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === label)!
        .click();
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FactoryCodingSetup />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await click('Configure coding');
    const model = container.querySelector<HTMLInputElement>(
      'input[name="model"]',
    )!;
    model.value = 'unsaved-model';
    await click('Close setup');
    expect(model.closest('[hidden]')).not.toBeNull();
    await click('Configure coding');
    expect(container.querySelector('input[name="model"]')).toBe(model);
    expect(model.value).toBe('unsaved-model');
    expect(model.closest('[hidden]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

it('keeps no-data readiness failure mounted through repeated failed polls and clears on success', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const { getFactoryCodingState } = await import('../../api/factory-coding');
  let resolve!: (value: ReturnType<typeof codingState>) => void;
  let reject!: (error: Error) => void;
  vi.mocked(getFactoryCodingState).mockImplementation(
    () =>
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <FactoryCodingSetup />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      reject(new Error('Readiness unavailable'));
      await vi.advanceTimersByTimeAsync(1);
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Coding readiness unavailable');
    const failedMarkup = container.innerHTML;
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(client.getQueryState(['factory-coding-state'])?.status).toBe(
        'pending',
      );
      expect(container.querySelector('[role="alert"]')).toBe(alert);
      expect(container.innerHTML).toBe(failedMarkup);
      expect(alert?.querySelector('button')?.disabled).toBe(false);
      expect(container.textContent).not.toContain('Loading coding readiness');
      expect(container.querySelector('button')?.disabled).toBe(true);
      await act(async () => {
        reject(new Error('Readiness unavailable'));
        await vi.advanceTimersByTimeAsync(1);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    await act(async () => {
      resolve(codingState());
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button')?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.useRealTimers();
    vi.mocked(getFactoryCodingState).mockResolvedValue(codingState());
  }
});
