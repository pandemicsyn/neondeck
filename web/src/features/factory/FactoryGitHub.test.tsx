// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryGitHubSetup, FactoryGitHubSource } from './FactoryGitHub';
const api = vi.hoisted(() => ({
  getFactoryGitHub: vi.fn(),
  getFactoryGitHubComments: vi.fn(),
  saveFactoryGitHub: vi.fn(),
  syncFactorySource: vi.fn(),
}));
vi.mock('../../api/factory', () => api);
const data = {
  configFingerprint: 'base-one',
  connections: [
    {
      id: 'test',
      enabled: false,
      repoId: 'repo',
      repositoryId: '42',
      owner: 'example',
      name: 'fixture',
      webhookSecretEnv: 'WEBHOOK_SECRET',
      tokenEnv: 'GITHUB_TOKEN',
      admission: { mode: 'label', label: 'factory' },
      readiness: ['Connection is disabled.'],
    },
  ],
  deliveries: [],
  sync: [],
  comments: [],
};
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.getFactoryGitHub.mockResolvedValue(data);
  api.saveFactoryGitHub.mockResolvedValue({});
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
        <FactoryGitHubSetup repos={[{ id: 'repo', name: 'example/fixture' }]} />
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
      .find((button) => button.textContent === 'Edit test')!
      .click();
  });
}
it('keeps the captured save fingerprint through background connection changes', async () => {
  await edit();
  await act(async () =>
    client.setQueryData(['factory-github'], {
      ...data,
      configFingerprint: 'base-two',
    }),
  );
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(api.saveFactoryGitHub.mock.calls[0][1]).toBe('base-one');
  expect(api.saveFactoryGitHub.mock.calls[0][0][0]).not.toHaveProperty(
    'readiness',
  );
});
it('retains setup inputs after a failed save and disables them while pending', async () => {
  await edit();
  let reject!: (error: Error) => void;
  api.saveFactoryGitHub.mockImplementation(
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
        <FactoryGitHubSetup repos={[]} />
      </QueryClientProvider>,
    );
  });
  expect(api.getFactoryGitHub).not.toHaveBeenCalled();
});

it('loads only selected-task comment pages and resets paging on a different task', async () => {
  const comment = (body: string) => ({
    id: body,
    workId: 'work-one',
    remoteId: '1',
    body,
    author: 'external',
    remoteUpdatedAt: '2026-09-01',
    version: 1,
    deleted: false,
    intentId: null,
  });
  api.getFactoryGitHubComments.mockImplementation(async (_id, cursor) => ({
    comments: [comment(cursor ? 'Older page body' : 'Newest page body')],
    nextCursor: cursor ? null : '10',
  }));
  const detail = (id: string) =>
    ({
      work: { id },
      source: {
        version: 1,
        status: 'open',
        actor: 'external',
        body: 'Issue',
        remote: {
          connectionId: 'test',
          number: 1,
          url: 'https://github.com/example/fixture/issues/1',
        },
      },
    }) as Parameters<typeof FactoryGitHubSource>[0]['detail'];
  const draw = async (id: string) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FactoryGitHubSource detail={detail(id)} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
  };
  await draw('work-one');
  expect(container.textContent).toContain('Newest page body');
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Older comments')!
      .click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  expect(container.textContent).toContain('Older page body');
  expect(container.textContent).not.toContain('Newest page body');
  expect(api.getFactoryGitHubComments).toHaveBeenCalledWith('work-one', '10');
  await draw('work-two');
  expect(api.getFactoryGitHubComments).toHaveBeenLastCalledWith(
    'work-two',
    undefined,
  );
  expect(container.textContent).toContain('Newest page body');
});
