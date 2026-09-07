// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryLinearSetup } from './FactoryLinearSetup';
const api = vi.hoisted(() => ({
  getFactoryLinear: vi.fn(),
  saveFactoryLinear: vi.fn(),
}));
vi.mock('../../api/factory-linear', () => api);
const data = {
  configFingerprint: 'base-one',
  connections: [
    {
      id: 'test',
      enabled: false,
      repoId: 'repo',
      organizationId: 'workspace',
      teamId: 'team',
      projectId: null,
      webhookSecretEnv: 'WEBHOOK_SECRET',
      tokenEnv: 'LINEAR_API_KEY',
      admission: { mode: 'all' },
      writeback: { enabled: false, states: {} },
      readiness: ['Connection is disabled.'],
    },
  ],
  deliveries: [],
  sync: [],
  writebacks: [],
};
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.getFactoryLinear.mockResolvedValue(data);
  api.saveFactoryLinear.mockResolvedValue({});
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <FactoryLinearSetup repos={[{ id: 'repo', name: 'example/fixture' }]} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    container.querySelector('details')!.open = true;
    container.querySelector('details')!.dispatchEvent(new Event('toggle'));
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}
async function edit() {
  await render();
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Edit Linear test')!
      .click();
  });
}
it('blocks a stale connection draft without replacing operator input', async () => {
  await edit();
  await act(async () =>
    client.setQueryData(['factory-linear'], {
      ...data,
      configFingerprint: 'base-two',
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(container.textContent).toContain('Your draft is retained');
  expect(
    Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Save Linear connection',
    )!.disabled,
  ).toBe(true);
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(api.saveFactoryLinear).not.toHaveBeenCalled();
  expect(container.querySelector('input')!.value).toBe('test');
});
it('retains setup inputs after a failed save and disables them while pending', async () => {
  await edit();
  let reject!: (error: Error) => void;
  api.saveFactoryLinear.mockImplementation(
    () =>
      new Promise((_, failure) => {
        reject = failure;
      }),
  );
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector('fieldset')!.disabled).toBe(true);
  await act(async () => reject(new Error('Configuration changed.')));
  expect(container.querySelector('fieldset')!.disabled).toBe(false);
  expect(container.querySelector('input')!.value).toBe('test');
  expect(container.textContent).toContain('Configuration changed.');
});
it('does not fetch hidden setup, avoiding unrelated errors during task editing', async () => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <FactoryLinearSetup repos={[]} />
      </QueryClientProvider>,
    );
  });
  expect(api.getFactoryLinear).not.toHaveBeenCalled();
});

it('starts new mappings with admission and writeback disabled', async () => {
  await render();
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Add Linear connection')!
      .click(),
  );
  expect(
    Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).map((input) => input.checked),
  ).toEqual([false, false]);
  expect(container.textContent).toContain('Linear project ID (optional)');
});
it('saves the captured configuration without response-only readiness fields', async () => {
  await edit();
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(api.saveFactoryLinear).toHaveBeenCalledWith(
    [
      expect.objectContaining({
        teamId: 'team',
        projectId: null,
        repoId: 'repo',
      }),
    ],
    'base-one',
  );
  expect(api.saveFactoryLinear.mock.calls[0][0][0]).not.toHaveProperty(
    'readiness',
  );
});
