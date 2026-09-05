// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryTaskDetail } from './FactoryTaskDetail';
import {
  emptyFactorySpec,
  type FactoryDetail,
} from '../../../../shared/factory';
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
const refresh = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  current = fixture();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <FactoryTaskDetail
        detail={current}
        repos={[{ id: 'demo', name: 'Demo' }]}
        refresh={refresh}
      />,
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
  expect(button('Release v1').disabled).toBe(true);
  await click('Release v1');
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
  expect(button('Release v1').disabled).toBe(true);
  await click('View current v3');
  await click('Release v3');
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
