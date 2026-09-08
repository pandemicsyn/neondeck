import { validationPreview } from './FactoryDelivery.fixtures';
// @vitest-environment jsdom
import { act, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { codingState } from './FactoryCoding.fixtures';
const factoryCodingStateKey = ['factory-coding-state'];
import { getFactoryCodingState } from '../../api/factory-coding';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryTaskDetail } from './FactoryTaskDetail';
import {
  emptyFactorySpec,
  type FactoryDetail,
} from '../../../../shared/factory';
// Coding query behavior is covered separately in FactoryCoding.test.tsx.
vi.mock('../../api/factory-delivery', () => ({
  getFactoryValidationPolicy: vi.fn(
    async () => validationPreview().validationPolicy,
  ),
  getFactoryDeliveryState: vi.fn(async () => ({ deliveries: [] })),
}));
vi.mock('./FactoryCoding', () => ({ FactoryCoding: () => null }));
vi.mock('../../api/factory-coding', () => ({
  getFactoryCodingState: vi.fn<typeof getFactoryCodingState>(),
}));
const api = vi.hoisted(() => ({ mutateFactory: vi.fn() }));
vi.mock('../../api/factory', () => api);
vi.mock('../diff-viewer/DocumentRevisionDiff', () => ({
  DocumentRevisionDiff: ({
    before,
    after,
  }: {
    before: { text: string };
    after: { text: string };
  }) => (
    <div data-testid="comparison">
      {before.text === after.text
        ? 'No document changes between these versions.'
        : `${before.text}\n→\n${after.text}`}
    </div>
  ),
}));
vi.mock('./FactoryPlanning', () => ({
  FactoryPlanning: ({
    discussion,
  }: {
    discussion?: { version: number; id: string };
  }) => {
    const [text, setText] = useState('');
    return (
      <section className="factory-planning">
        <p>
          Discussion {discussion?.version}:{discussion?.id}
        </p>
        <textarea
          aria-label="Chat draft"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </section>
    );
  },
}));
const hash = 'a'.repeat(64);
function fixture(): FactoryDetail {
  const spec = {
    ...emptyFactorySpec(),
    outcome: 'Find tasks',
    scope: 'Titles only',
    approach: 'Use a local filter',
    acceptanceCriteria: [{ id: 'ac-1', text: 'Filter titles' }],
    decisions: [
      {
        id: 'choice-1',
        question: 'Should matching ignore case?',
        blocking: true,
        answer: null,
      },
    ],
  };
  const rev = {
    workId: 'task',
    version: 1,
    parentVersion: null,
    spec,
    hash,
    sourceVersion: 1,
    repoFingerprint: hash,
    repoContext: {
      path: '/synthetic/repo',
      defaultBranch: 'main',
      commands: {},
    },
    authorKind: 'model' as const,
    actor: 'Neon',
    createdAt: '2026-09-05',
  };
  return {
    work: {
      id: 'task',
      sourceId: 'source',
      title: 'Filter inbox',
      repoId: 'demo',
      lifecycle: 'shaping',
      version: 2,
      specVersion: 2,
      createdAt: '2026-09-05',
      updatedAt: '2026-09-05',
    },
    source: {
      id: 'source',
      provider: 'manual',
      requestKey: 'r',
      requestHash: hash,
      title: 'Filter inbox',
      body: 'Find tasks',
      repoId: 'demo',
      version: 1,
      status: 'open',
      actor: 'human',
      createdAt: '2026-09-05',
    },
    revisions: [
      rev,
      {
        ...rev,
        version: 2,
        parentVersion: 1,
        hash: 'b'.repeat(64),
        spec: { ...spec, approach: 'Use a case-insensitive filter' },
      },
    ],
    releases: [],
    blockers: ['Resolve blocking decisions before release.'],
    eligible: false,
    repoFingerprint: hash,
    repoContext: rev.repoContext,
  };
}
let container: HTMLDivElement;
let root: Root;
let current: FactoryDetail;
let client: QueryClient;
const refresh = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:synthetic-recovery');
      static revokeObjectURL = vi.fn();
    },
  );
  sessionStorage.clear();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  current = fixture();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ['factory-validation-policy', 'demo'],
    validationPreview().validationPolicy,
  );
  client.setQueryData(factoryCodingStateKey, {
    ...codingState(),
    configFingerprint: 'c'.repeat(64),
  });
  vi.mocked(getFactoryCodingState).mockResolvedValue({
    ...codingState(),
    configFingerprint: 'c'.repeat(64),
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FactoryTaskDetail
          detail={current}
          repos={[{ id: 'demo', name: 'Demo' }]}
          refresh={refresh}
        />
      </QueryClientProvider>,
    ),
  );
}
function button(text: string) {
  return [...container.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function input(selector: string, value: string) {
  const el = container.querySelector<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(selector)!;
  await act(async () => {
    const proto =
      el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    );
  });
  return el;
}
it('compares any retained versions, including same-version, and never releases a different current version', async () => {
  await render();
  await click('Compare versions');
  expect(
    container.querySelector('[data-testid=comparison]')!.textContent,
  ).toContain('Use a local filter');
  await input('[aria-label="Compare from"]', '2');
  expect(container.textContent).toContain('No document changes');
  await input('[aria-label="Retained version"]', '1');
  expect(button('Approve plan and start').disabled).toBe(true);
  await click('Approve plan and start');
  expect(api.mutateFactory).not.toHaveBeenCalled();
  current = {
    ...current,
    blockers: [],
    revisions: [
      ...current.revisions,
      { ...current.revisions[1], version: 3, hash: 'c'.repeat(64) },
    ],
    work: { ...current.work, version: 3, specVersion: 3 },
  };
  await render();
  expect(button('Approve plan and start').disabled).toBe(true);
  await click('View current v3');
  await click('Approve plan and start');
  expect(api.mutateFactory).toHaveBeenCalledWith(
    'task',
    'release',
    expect.objectContaining({
      specVersion: 3,
      specHash: 'c'.repeat(64),
      expectedVersion: 3,
    }),
  );
});
it('retains local text across tabs and a two-editor race, requiring explicit recovery before CAS retry', async () => {
  await render();
  await click('Edit draft');
  const editor = await input(
    '.factory-editor-fields textarea',
    'My local outcome',
  );
  await input('[aria-label="Chat draft"]', 'Keep chat too');
  await click('Conversation');
  await click('Brief v2');
  expect(editor.value).toBe('My local outcome');
  await click('Compare versions');
  await click('Read brief');
  expect(editor.isConnected).toBe(true);
  current = {
    ...current,
    work: { ...current.work, version: 3, specVersion: 3 },
    revisions: [
      ...current.revisions,
      {
        ...current.revisions[1],
        version: 3,
        spec: { ...current.revisions[1].spec, outcome: 'Other editor outcome' },
      },
    ],
  };
  await render();
  expect(editor.value).toBe('My local outcome');
  expect(button('Save new revision').disabled).toBe(true);
  await act(async () => {
    editor.form!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
  });
  expect(api.mutateFactory).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Other editor outcome');
  await click('Use current save base and keep my text');
  api.mutateFactory.mockResolvedValue({
    ...current,
    work: { ...current.work, specVersion: 4 },
  });
  await click('Save new revision');
  expect(api.mutateFactory).toHaveBeenCalledWith(
    'task',
    'spec',
    expect.objectContaining({
      expectedVersion: 3,
      expectedSpecVersion: 3,
      spec: expect.objectContaining({ outcome: 'My local outcome' }),
    }),
  );
  expect(
    container.querySelector<HTMLTextAreaElement>('[aria-label="Chat draft"]')!
      .value,
  ).toBe('Keep chat too');
});
it('answers a blocking decision through an immutable human revision and retains input after failed save', async () => {
  await render();
  await click('Answer in a new revision');
  await input(
    '[aria-label="Answer choice-1"]',
    'Use case-insensitive matching.',
  );
  api.mutateFactory.mockRejectedValueOnce(new Error('Synthetic save failed'));
  await click('Save new revision');
  expect(
    container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Answer choice-1"]',
    )!.value,
  ).toBe('Use case-insensitive matching.');
  expect(api.mutateFactory).toHaveBeenCalledWith(
    'task',
    'spec',
    expect.objectContaining({
      expectedSpecVersion: 2,
      spec: expect.objectContaining({
        decisions: [
          expect.objectContaining({
            id: 'choice-1',
            answer: 'Use case-insensitive matching.',
          }),
        ],
      }),
    }),
  );
});
it('discusses a stable section from the selected revision and preserves its identity on updates', async () => {
  await render();
  await input('[aria-label="Retained version"]', '1');
  await click('Discuss ac-1');
  expect(container.textContent).toContain('Discussion 1:ac-1');
  current = {
    ...current,
    work: { ...current.work, specVersion: 3 },
    revisions: [...current.revisions, { ...current.revisions[1], version: 3 }],
  };
  await render();
  expect(container.textContent).toContain('Discussion 1:ac-1');
  await click('View current v3');
  expect(container.textContent).toContain('Discussion 1:ac-1');
});

it('restores selected view, incomplete local edits and revision-bound discussion after remount', async () => {
  await render();
  await click('Discuss scope');
  await click('Brief v2');
  await click('Edit draft');
  await input('.factory-editor-fields textarea', 'Unsaved outcome');
  await click('Add criterion');
  await click('Compare versions');
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(
    container.querySelector<HTMLTextAreaElement>(
      '.factory-editor-fields textarea',
    )!.value,
  ).toBe('Unsaved outcome');
  expect(
    container.querySelectorAll('.factory-brief .factory-editor-fields input'),
  ).toHaveLength(2);
  expect(button('Read brief')).toBeDefined();
  expect(container.textContent).toContain('Discussion 2:scope');
});

it.each([
  '{"editor":',
  JSON.stringify({ editor: { spec: { outcome: 'Recover this text' } } }),
])(
  'retains rejected draft data without autosave until explicit discard: %s',
  async (raw) => {
    sessionStorage.setItem('factory-workbench:task', raw);
    await render();
    expect(container.textContent).toContain('Saved draft needs recovery');
    expect(button('Pause').disabled).toBe(false);
    expect(sessionStorage.getItem('factory-workbench:task')).toBe(raw);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Saved draft data"]',
      )?.value,
    ).toBe(raw);
    await click('Retry draft recovery');
    expect(sessionStorage.getItem('factory-workbench:task')).toBe(raw);
    await click('Discard saved draft…');
    expect(sessionStorage.getItem('factory-workbench:task')).toBe(raw);
    await click('Keep saved data');
    expect(sessionStorage.getItem('factory-workbench:task')).toBe(raw);
    await click('Discard saved draft…');
    await click('Confirm discard saved draft');
    expect(container.textContent).not.toContain('Saved draft needs recovery');
    expect(
      JSON.parse(sessionStorage.getItem('factory-workbench:task')!).editor,
    ).toBeNull();
  },
);

it('does not overwrite an unreadable draft and retries storage recovery explicitly', async () => {
  const original = sessionStorage;
  const set = vi.fn();
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('Storage unavailable');
    },
    setItem: set,
  });
  try {
    await render();
    expect(container.textContent).toContain('Saved draft needs recovery');
    expect(set).not.toHaveBeenCalled();
    vi.stubGlobal('sessionStorage', original);
    await click('Discard saved draft…');
    await click('Confirm discard saved draft');
    expect(container.textContent).not.toContain('Saved draft needs recovery');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('disables release without a current repository fingerprint and releases with a valid fingerprint', async () => {
  current = { ...current, blockers: [], repoFingerprint: null };
  await render();
  expect(button('Approve plan and start').disabled).toBe(true);
  await click('Approve plan and start');
  expect(api.mutateFactory).not.toHaveBeenCalled();
  current = { ...current, repoFingerprint: hash };
  await render();
  expect(button('Approve plan and start').disabled).toBe(false);
  await click('Approve plan and start');
  expect(api.mutateFactory).toHaveBeenCalledWith(
    'task',
    'release',
    expect.objectContaining({
      repoFingerprint: hash,
      expectedCodingConfigFingerprint: 'c'.repeat(64),
      specVersion: 2,
      specHash: 'b'.repeat(64),
      expectedVersion: 2,
    }),
  );
});

it('blocks release after a coding selection refresh failure and retains the displayed selection', async () => {
  current = { ...current, blockers: [] };
  await render();
  expect(button('Approve plan and start').disabled).toBe(false);
  vi.mocked(getFactoryCodingState).mockRejectedValue(
    new Error('Synthetic unavailable'),
  );
  await act(async () => {
    await client.refetchQueries({ queryKey: factoryCodingStateKey });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 35));
  });
  expect(button('Approve plan and start').disabled).toBe(true);
  expect(container.textContent).toContain('Coding selection is unavailable');
  await click('Approve plan and start');
  expect(api.mutateFactory).not.toHaveBeenCalled();
});

it.each([
  ['Pause', 'pause'],
  ['Withdraw release', 'withdraw'],
])(
  'allows %s during draft recovery without touching retained data',
  async (label, action) => {
    const raw = '{"editor":';
    sessionStorage.setItem('factory-workbench:task', raw);
    current = { ...current, work: { ...current.work, lifecycle: 'queued' } };
    api.mutateFactory.mockResolvedValue(current);
    await render();
    expect(button(label).disabled).toBe(false);
    expect(button('Approve plan and start').disabled).toBe(true);
    await click(label);
    expect(api.mutateFactory).toHaveBeenCalledWith('task', 'transition', {
      expectedVersion: current.work.version,
      action,
    });
    expect(sessionStorage.getItem('factory-workbench:task')).toBe(raw);
    expect(container.textContent).toContain('Saved draft needs recovery');
  },
);

it.each([false, true])(
  'reveals an older local editor from compare mode without discarding it (edited=%s)',
  async (edited) => {
    current = {
      ...current,
      blockers: [],
      work: { ...current.work, version: 1, specVersion: 1 },
      revisions: [current.revisions[0]],
    };
    await render();
    await click('Edit draft');
    if (edited)
      await input('.factory-editor-fields textarea', 'Keep my local outcome');
    const savedEditor = JSON.parse(
      sessionStorage.getItem('factory-workbench:task')!,
    ).editor;
    current = {
      ...current,
      work: { ...current.work, version: 4, specVersion: 4 },
      revisions: [
        ...current.revisions,
        {
          ...current.revisions[0],
          version: 4,
          hash: 'd'.repeat(64),
          spec: {
            ...current.revisions[0].spec,
            outcome: 'Latest model outcome',
          },
        },
      ],
    };
    await render();
    await input('[aria-label="Retained version"]', '4');
    await click('Compare versions');
    await click('Conversation');
    const field = container.querySelector<HTMLTextAreaElement>(
      '.factory-editor-fields textarea',
    )!;
    expect(field.closest('[hidden]')).not.toBeNull();
    const release = button('Approve plan and start');
    expect(release.disabled).toBe(true);
    expect(button('Pause').disabled).toBe(true);
    const notice = document.getElementById(
      release.getAttribute('aria-describedby')!,
    )!;
    expect(notice.textContent).toContain('local draft of v1 is open');
    expect(notice.textContent).toContain('latest saved brief is v4');
    await click('Approve plan and start');
    expect(api.mutateFactory).not.toHaveBeenCalled();
    await click('Review local draft');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(field.closest('[hidden]')).toBeNull();
    expect(
      container
        .querySelector('.factory-workbench')!
        .classList.contains('factory-view-brief'),
    ).toBe(true);
    expect(document.activeElement).toBe(field);
    expect(
      JSON.parse(sessionStorage.getItem('factory-workbench:task')!).editor,
    ).toEqual(savedEditor);
    expect(field.value).toBe(savedEditor.spec.outcome);
    expect(button('Approve plan and start').disabled).toBe(true);
    expect(api.mutateFactory).not.toHaveBeenCalled();
    await click('Cancel edits');
    expect(button('Approve plan and start').disabled).toBe(false);
    expect(api.mutateFactory).not.toHaveBeenCalled();
  },
);

it('explains draft recovery beside Release without deleting retained data', async () => {
  const raw = '{invalid synthetic draft';
  sessionStorage.setItem('factory-workbench:task', raw);
  current = { ...current, blockers: [] };
  await render();
  const release = button('Approve plan and start');
  expect(release.disabled).toBe(true);
  expect(
    document.getElementById(release.getAttribute('aria-describedby')!)!
      .textContent,
  ).toContain('resolve Saved draft needs recovery');
  expect(sessionStorage.getItem('factory-workbench:task')).toBe(raw);
  expect(api.mutateFactory).not.toHaveBeenCalled();
});

it('explains an unresolved mutation beside Release until it settles', async () => {
  current = { ...current, blockers: [] };
  let resolve!: (value: FactoryDetail) => void;
  api.mutateFactory.mockImplementationOnce(
    () =>
      new Promise<FactoryDetail>((done) => {
        resolve = done;
      }),
  );
  await render();
  await click('Approve plan and start');
  const release = button('Approve plan and start');
  expect(release.disabled).toBe(true);
  expect(
    document.getElementById(release.getAttribute('aria-describedby')!)!
      .textContent,
  ).toContain('Saving task changes');
  await act(async () => {
    resolve(current);
  });
  expect(button('Approve plan and start').disabled).toBe(false);
});

it('keeps the withdrawn plan open and blocks reapproval until reviewer configuration recovers', async () => {
  const { getFactoryValidationPolicy } =
    await import('../../api/factory-delivery');
  current = {
    ...current,
    blockers: [],
    eligible: true,
    work: { ...current.work, lifecycle: 'queued' },
  };
  await render();
  expect(button('Approve plan and start').disabled).toBe(true);
  const withdrawn = {
    ...current,
    eligible: false,
    work: {
      ...current.work,
      lifecycle: 'shaping' as const,
      version: current.work.version + 1,
    },
  };
  api.mutateFactory.mockResolvedValue(withdrawn);
  await click('Withdraw release');
  expect(api.mutateFactory).toHaveBeenCalledWith('task', 'transition', {
    expectedVersion: current.work.version,
    action: 'withdraw',
  });
  current = withdrawn;
  // A remount after withdrawal reproduces the live no-data validation read.
  await act(async () => root.render(null));
  client.removeQueries({ queryKey: ['factory-validation-policy'] });
  vi.mocked(getFactoryValidationPolicy).mockRejectedValue(
    new Error('Independent reviewer model is missing'),
  );
  try {
    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const approve = button('Approve plan and start');
    expect(approve.disabled).toBe(true);
    expect(container.textContent).toContain('Find tasks');
    expect(
      document.getElementById(approve.getAttribute('aria-describedby')!)
        ?.textContent,
    ).toContain('Independent reviewer model is missing');
    api.mutateFactory.mockClear();
    await click('Approve plan and start');
    expect(api.mutateFactory).not.toHaveBeenCalled();
    vi.mocked(getFactoryValidationPolicy).mockResolvedValue(
      validationPreview().validationPolicy,
    );
    await click('Reload validation policy');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(approve.disabled).toBe(false);
    expect(api.mutateFactory).not.toHaveBeenCalled();
    await click('Approve plan and start');
    expect(api.mutateFactory).toHaveBeenCalledWith(
      'task',
      'release',
      expect.objectContaining({
        expectedVersion: withdrawn.work.version,
        specVersion: withdrawn.work.specVersion,
        validationPolicy: validationPreview().validationPolicy,
      }),
    );
  } finally {
    vi.mocked(getFactoryValidationPolicy).mockResolvedValue(
      validationPreview().validationPolicy,
    );
  }
});
