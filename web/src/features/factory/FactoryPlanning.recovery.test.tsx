// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryPlanning } from './FactoryPlanning';
import type { FactoryDetail } from '../../../../shared/factory';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  agent: {
    messages: [],
    settlements: [],
    historyReady: true,
    status: 'idle',
    refresh: () => {},
  },
}));
vi.mock('@flue/react', () => ({ useFlueAgent: () => mocks.agent }));
vi.mock('../../lib/flue', () => ({
  createFactoryPlannerConversationClient: () => ({}),
}));
vi.mock('../../lib/dashboard-connection', () => ({
  useDashboardEventConnectionState: () => 'open',
}));
vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  openChatSessionEventStream: () => () => {},
  openChatSessionCommandEventStream: () => () => {},
}));
vi.mock('../../api/factory', () => ({
  getFactoryPlanning: async () => ({
    sessionId: 'planner',
    plannerStarted: true,
    activity: 'completed',
    contextStale: false,
    submissionId: 'submission',
    triage: null,
  }),
  sendFactoryPlanning: mocks.send,
}));
const detail = {
  work: { id: 'task', version: 1, lifecycle: 'shaping' },
} as FactoryDetail;
const draftKey = 'factory-chat-draft:task:planner';
const requestKey = 'factory-planning-request:task';
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  mocks.send.mockReset();
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
async function render(evidence?: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <FactoryPlanning detail={detail} deliveryEvidence={evidence} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  // Flush the query's first notification before interacting with the composer.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}
async function click(label: string) {
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === label)!
      .click();
    await new Promise((r) => setTimeout(r, 10));
  });
}
it.each([false, true])(
  'replays evidence after reload and preserves newer draft=%s using the real composer',
  async (newer) => {
    const original = '  Please revise the plan\n';
    const evidence = 'Retained candidate evidence';
    sessionStorage.setItem(draftKey, original);
    mocks.send.mockRejectedValueOnce(new Error('Admission response lost'));
    await render(evidence);
    await click('Send');
    const envelope = mocks.send.mock.calls[0][1];
    expect(envelope.message).toBe(`${original.trim()}\n\n${evidence}`);
    expect(envelope).not.toHaveProperty('composer');
    expect(JSON.parse(sessionStorage.getItem(requestKey)!)).toEqual({
      ...envelope,
      composer: { message: original, storageKey: draftKey },
    });
    await act(async () => root.unmount());
    if (newer) sessionStorage.setItem(draftKey, 'A newer reply');
    root = createRoot(container);
    mocks.send.mockResolvedValue({ sessionId: 'planner' });
    await render(); // TaskDetail's transient evidence has been lost on reload.
    const composer = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await click('Retry original request');
    expect(mocks.send.mock.calls[1][1]).toEqual(envelope);
    expect(container.querySelector('textarea')).toBe(composer);
    expect(composer.value).toBe(newer ? 'A newer reply' : '');
    expect(sessionStorage.getItem(draftKey)).toBe(
      newer ? 'A newer reply' : null,
    );
    expect(sessionStorage.getItem(requestKey)).toBeNull();
  },
);
it('retains legacy request compatibility without guessing which evidence-free text to consume', async () => {
  const envelope = {
    requestKey: 'legacy-request',
    message: 'Original\n\nEvidence',
    expectedVersion: 1,
  };
  sessionStorage.setItem(requestKey, JSON.stringify(envelope));
  sessionStorage.setItem(draftKey, 'Original');
  mocks.send.mockResolvedValue({ sessionId: 'planner' });
  await render();
  await click('Retry original request');
  expect(mocks.send).toHaveBeenCalledWith('task', envelope);
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    'Original',
  );
});
it('retains malformed composer metadata and blocks dispatch', async () => {
  const raw = JSON.stringify({
    requestKey: 'request',
    message: 'Original',
    expectedVersion: 1,
    composer: { message: 4, storageKey: draftKey },
  });
  sessionStorage.setItem(requestKey, raw);
  await render();
  expect(container.textContent).toContain(
    'Saved planning request could not be read',
  );
  expect(mocks.send).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(requestKey)).toBe(raw);
});

it.each([
  { message: 'Original', storageKey: 'unrelated-preferences' },
  {
    message: 'Original',
    storageKey: 'factory-chat-draft:another-task:planner',
  },
  { message: 'Original', storageKey: 'factory-chat-draft:task:' },
  { message: 'x'.repeat(12001), storageKey: draftKey },
])(
  'preserves corrupt metadata without replay or unrelated storage removal: $storageKey',
  async (composer) => {
    const raw = JSON.stringify({
      requestKey: 'request',
      message: 'Original',
      expectedVersion: 1,
      composer,
    });
    sessionStorage.setItem(composer.storageKey, composer.message);
    sessionStorage.setItem(requestKey, raw);
    await render();
    expect(container.textContent).toContain(
      'Saved planning request could not be read',
    );
    expect(mocks.send).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(requestKey)).toBe(raw);
    expect(sessionStorage.getItem(composer.storageKey)).toBe(composer.message);
  },
);
it('consumes the original session draft within this task without touching the current composer', async () => {
  const originalKey = 'factory-chat-draft:task:original-session';
  const envelope = {
    requestKey: 'request',
    message: 'Original with evidence',
    expectedVersion: 1,
  };
  sessionStorage.setItem(
    requestKey,
    JSON.stringify({
      ...envelope,
      composer: { message: 'Original', storageKey: originalKey },
    }),
  );
  sessionStorage.setItem(originalKey, 'Original');
  sessionStorage.setItem(draftKey, 'Original');
  mocks.send.mockResolvedValue({ sessionId: 'planner' });
  await render();
  await click('Retry original request');
  expect(mocks.send).toHaveBeenCalledWith('task', envelope);
  expect(sessionStorage.getItem(originalKey)).toBeNull();
  expect(sessionStorage.getItem(draftKey)).toBe('Original');
  expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
    'Original',
  );
});
