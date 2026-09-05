// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { FactoryWriteback } from './FactoryWriteback';
import {
  emptyFactorySpec,
  type FactoryDetail,
} from '../../../../shared/factory';
const api = vi.hoisted(() => ({
  getFactoryWriteback: vi.fn(),
  setFactoryWriteback: vi.fn(),
  approveFactoryWriteback: vi.fn(),
  recoverFactoryWriteback: vi.fn(),
  previewFactoryWritebackRepair: vi.fn(),
  approveFactoryWritebackRepair: vi.fn(),
}));
vi.mock('../../api/factory', () => api);
vi.mock('../../components/MarkdownMessage', () => ({
  MarkdownMessage: ({ children }: { children: string }) => (
    <div>{children}</div>
  ),
}));
let root: Root, container: HTMLDivElement, client: QueryClient;
const detail = {
  work: { id: 'work', version: 1, specVersion: 1 },
  source: {
    version: 1,
    remote: {
      connectionId: 'connection',
      issueId: '42',
      number: 1,
      url: 'https://github.com/example/fixture/issues/1',
    },
  },
  revisions: [{ version: 1, hash: 'hash', spec: emptyFactorySpec() }],
} as FactoryDetail;
const data = {
  policy: { enabled: true, epoch: 'one' },
  connectionFingerprint: 'fingerprint',
  template: 'Shaping',
  effects: [],
  approvals: [],
  status: null,
};
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  api.getFactoryWriteback.mockResolvedValue(data);
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
async function render(d = detail) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <FactoryWriteback detail={d} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 10));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
async function click(text: string) {
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === text)!
      .click();
  });
}
async function type(text: string) {
  await act(async () => {
    const el = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
it('requires an exact preview and preserves input after a failed send or refetch', async () => {
  await render();
  await click('Ask on GitHub');
  await type('Exact question');
  expect(container.textContent).not.toContain('Send this question to GitHub');
  await click('Preview exact publication');
  api.approveFactoryWriteback.mockRejectedValue(new Error('Synthetic failure'));
  await click('Send this question to GitHub');
  expect(container.querySelector('textarea')!.value).toBe('Exact question');
  expect(container.textContent).toContain('Synthetic failure');
  await act(async () => {
    client.setQueryData(['factory-writeback', 'work'], {
      ...data,
      template: 'New template',
    });
  });
  expect(container.querySelector('textarea')!.value).toBe('Exact question');
  expect(api.approveFactoryWriteback.mock.calls[0][1]).toMatchObject({
    body: 'Exact question',
    specVersion: 1,
    specHash: 'hash',
    issueId: '42',
    kind: 'question',
  });
});
it('disables edits during pending send and retains a stable approval key for retry', async () => {
  await render();
  await click('Ask on GitHub');
  await type('Question');
  await click('Preview exact publication');
  let reject!: (reason: Error) => void;
  api.approveFactoryWriteback.mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  await click('Send this question to GitHub');
  expect(container.querySelector('fieldset')!.disabled).toBe(true);
  const key = api.approveFactoryWriteback.mock.calls[0][1].requestKey;
  await act(async () => reject(new Error('Retry')));
  api.approveFactoryWriteback.mockRejectedValue(new Error('Again'));
  await click('Send this question to GitHub');
  expect(api.approveFactoryWriteback.mock.calls[1][1].requestKey).toBe(key);
});
it('stale task refresh retains text but cannot silently approve against the newer version', async () => {
  await render();
  await click('Review public summary');
  await type('Public summary');
  await click('Preview exact publication');
  await render({ ...detail, work: { ...detail.work, version: 2 } });
  expect(container.querySelector('textarea')!.value).toBe('Public summary');
  expect(
    Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Approve public summary for v1',
    )!.disabled,
  ).toBe(true);
  expect(api.approveFactoryWriteback).not.toHaveBeenCalled();
});
it('opt-in uses the reviewed policy fingerprint, not a silently refreshed mapping', async () => {
  api.getFactoryWriteback.mockResolvedValue({
    ...data,
    policy: { enabled: false, epoch: 'one' },
  });
  await render();
  await click('Review writeback policy');
  await act(async () => {
    client.setQueryData(['factory-writeback', 'work'], {
      ...data,
      connectionFingerprint: 'new',
      policy: { enabled: false, epoch: 'two' },
    });
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await click('Enable these status updates');
  expect(api.setFactoryWriteback).toHaveBeenCalledWith('connection', {
    enabled: true,
    expectedEpoch: 'one',
    expectedFingerprint: 'fingerprint',
  });
});
