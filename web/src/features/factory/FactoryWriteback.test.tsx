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
  expect(api.setFactoryWriteback).not.toHaveBeenCalled();
  await click('Cancel');
  await click('Review writeback policy');
  await click('Enable these status updates');
  expect(api.setFactoryWriteback).toHaveBeenCalledWith('connection', {
    enabled: true,
    expectedEpoch: 'two',
    expectedFingerprint: 'new',
  });
});

it.each(
  (
    [
      'pending',
      'sending',
      'uncertain',
      'failed',
      'repair',
      'cancelled',
      'sent',
    ] as const
  ).flatMap((state) =>
    [0, Date.UTC(2020, 0, 1), Date.UTC(2099, 0, 1)].map((retryAt) => ({
      state,
      retryAt,
    })),
  ),
)(
  'shows retry timing only for automatic recovery: $state / $retryAt',
  async ({ state, retryAt }) => {
    api.getFactoryWriteback.mockResolvedValue({
      ...data,
      effects: [
        {
          id: 'effect',
          kind: 'status',
          state,
          retryAt,
          body: 'Synthetic approved status',
          specVersion: 1,
          createdAt: '2026-09-06T00:00:00Z',
          remoteId: null,
          error: 'Synthetic retained error',
        },
      ],
    });
    await render();
    const automatic = ['pending', 'sending', 'uncertain'].includes(state);
    expect(container.textContent?.includes('Next eligible check:')).toBe(
      automatic && retryAt > 0,
    );
    expect(container.textContent).toContain('Synthetic retained error');
    if (state === 'failed')
      expect(container.textContent).toContain('Retry authorized send');
    if (state === 'repair')
      expect(container.textContent).toContain('Review remote comment repair');
    if (state === 'uncertain')
      expect(container.textContent).toContain('Recheck receipt (read only)');
  },
);

it.each([
  { state: 'failed', enabled: false, disabled: true },
  { state: 'failed', enabled: true, disabled: false },
  { state: 'uncertain', enabled: false, disabled: false },
])(
  'gates $state retry with consent enabled=$enabled',
  async ({ state, enabled, disabled }) => {
    api.getFactoryWriteback.mockResolvedValue({
      ...data,
      policy: { ...data.policy, enabled },
      effects: [
        {
          id: 'effect',
          kind: 'status',
          state,
          retryAt: 0,
          body: 'Synthetic approved status',
          specVersion: 1,
          createdAt: '2026-09-06T00:00:00Z',
          remoteId: null,
          error: null,
        },
      ],
    });
    api.recoverFactoryWriteback.mockResolvedValue(undefined);
    await render();
    const label =
      state === 'failed'
        ? 'Retry authorized send'
        : 'Recheck receipt (read only)';
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === label,
    )!;
    expect(button.disabled).toBe(disabled);
    await click(label);
    if (disabled) expect(api.recoverFactoryWriteback).not.toHaveBeenCalled();
    else
      expect(api.recoverFactoryWriteback).toHaveBeenCalledWith(
        'work',
        'effect',
        'retry',
      );
  },
);

it('offers retry after an initial load failure without claiming it is still loading', async () => {
  api.getFactoryWriteback.mockRejectedValue(new Error('Unavailable'));
  await render();
  expect(container.textContent).not.toContain('Loading publishing policy');
  api.getFactoryWriteback.mockResolvedValue(data);
  await click('Refresh publishing');
  await render();
  expect(container.textContent).toContain('Writeback enabled');
});

it('makes older publishing receipts accessible beyond the initial twelve', async () => {
  api.getFactoryWriteback.mockResolvedValue({
    ...data,
    effects: Array.from({ length: 14 }, (_, i) => ({
      id: `effect-${i}`,
      kind: 'status',
      state: 'sent',
      retryAt: 0,
      body: `Receipt body ${i}`,
      specVersion: 1,
      createdAt: '2026-09-06T00:00:00Z',
      remoteId: null,
      error: null,
    })),
  });
  await render();
  expect(container.querySelectorAll('.factory-writeback-effect')).toHaveLength(
    12,
  );
  await click('Show older publishing receipts (2 remaining)');
  expect(container.querySelectorAll('.factory-writeback-effect')).toHaveLength(
    14,
  );
  expect(container.textContent).toContain('Receipt body 0');
});
it('retains editable drafts through background fetch and errors while publication fails closed', async () => {
  await render();
  await click('Ask on GitHub');
  await type('Held question');
  await click('Preview exact publication');
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === label,
    )!;
  const textarea = container.querySelector('textarea')!;
  let resolve!: (value: typeof data) => void;
  let reject!: (error: Error) => void;
  api.getFactoryWriteback.mockImplementation(
    () =>
      new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  await act(async () => {
    void client.invalidateQueries({ queryKey: ['factory-writeback'] });
  });
  expect(button('Refresh publishing').disabled).toBe(false);
  expect(button('Send this question to GitHub').disabled).toBe(false);
  expect(container.querySelector('textarea')).toBe(textarea);
  await act(async () => {
    resolve(structuredClone(data));
  });
  await render();
  expect(textarea.value).toBe('Held question');
  await act(async () => {
    void client.invalidateQueries({ queryKey: ['factory-writeback'] });
  });
  await act(async () => reject(new Error('offline')));
  await render();
  expect(button('Send this question to GitHub').disabled).toBe(true);
  expect(container.querySelector('fieldset')!.disabled).toBe(false);
  await type('Still editable');
  expect(textarea.value).toBe('Still editable');
  await click('Preview exact publication');
  await act(async () => {
    void client.invalidateQueries({ queryKey: ['factory-writeback'] });
  });
  expect(button('Send this question to GitHub').disabled).toBe(true);
  await click('Cancel draft');
  expect(container.querySelector('textarea')).toBeNull();
  expect(api.approveFactoryWriteback).not.toHaveBeenCalled();
});
it('requires a fresh policy review when the background fingerprint changes', async () => {
  api.getFactoryWriteback.mockResolvedValue({
    ...data,
    policy: { ...data.policy, enabled: false },
  });
  await render();
  await click('Review writeback policy');
  api.getFactoryWriteback.mockResolvedValue({
    ...data,
    policy: { enabled: false, epoch: 'two' },
    connectionFingerprint: 'changed',
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['factory-writeback'] });
  });
  await render();
  const action = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Enable these status updates',
  )!;
  expect(action.disabled).toBe(true);
  await click('Cancel');
  expect(container.textContent).not.toContain('Enable these status updates');
  expect(api.setFactoryWriteback).not.toHaveBeenCalled();
});

it.each([
  { kind: 'status', nextState: 'sent' },
  { kind: 'question', nextState: 'sent' },
  { kind: 'status', nextState: 'uncertain' },
  { kind: 'question', nextState: 'uncertain' },
])(
  'gates only relinquish while $kind recovery refreshes to $nextState',
  async ({ kind, nextState }) => {
    const initial = {
      ...data,
      effects: [
        {
          id: 'effect',
          kind,
          state: 'uncertain',
          retryAt: 0,
          body: 'Approved content',
          specVersion: 1,
          createdAt: '2026-09-06T00:00:00Z',
          remoteId: null,
          error: null,
        },
      ],
    };
    api.getFactoryWriteback.mockResolvedValue(initial);
    await render();
    const label =
      kind === 'status'
        ? 'Relinquish status management'
        : 'Relinquish question reconciliation';
    const button = (text: string) =>
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === text,
      );
    expect(button(label)!.disabled).toBe(false);
    await click('Ask on GitHub');
    await type('Retained draft');
    const textarea = container.querySelector('textarea')!;
    textarea.focus();
    let resolve!: (value: typeof initial) => void;
    api.getFactoryWriteback.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    await act(async () => {
      void client.invalidateQueries({
        queryKey: ['factory-writeback', 'work'],
      });
    });
    await render();
    expect(client.isFetching({ queryKey: ['factory-writeback', 'work'] })).toBe(
      1,
    );
    expect(button(label)!.disabled).toBe(true);
    expect(button('Refresh publishing')!.disabled).toBe(false);
    expect(button('Recheck receipt (read only)')!.disabled).toBe(false);
    expect(container.querySelector('fieldset')!.disabled).toBe(false);
    expect(document.activeElement).toBe(textarea);
    await click(label);
    expect(api.recoverFactoryWriteback).not.toHaveBeenCalled();
    await act(async () => {
      resolve({
        ...initial,
        effects: [{ ...initial.effects[0], state: nextState }],
      });
    });
    await render();
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('Retained draft');
    if (nextState === 'sent') {
      expect(button(label)).toBeUndefined();
      expect(container.textContent).toContain('· sent');
      expect(api.recoverFactoryWriteback).not.toHaveBeenCalled();
    } else {
      expect(button(label)!.disabled).toBe(false);
      await click(label);
      expect(api.recoverFactoryWriteback).toHaveBeenCalledWith(
        'work',
        'effect',
        'relinquish',
      );
    }
  },
);
