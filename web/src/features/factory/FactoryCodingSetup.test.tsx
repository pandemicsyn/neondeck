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
