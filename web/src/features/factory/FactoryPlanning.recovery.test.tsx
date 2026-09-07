// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryPlanning } from './FactoryPlanning';
import { FlueChatSessionView } from '../flue-chat/components/session-view';
import type { FactoryDetail } from '../../../../shared/factory';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  refreshContext: vi.fn(),
  stale: false,
  plannerStarted: true,
  activity: 'completed',
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
  createNeondeckConversationClient: () => ({}),
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
    plannerStarted: mocks.plannerStarted,
    activity: mocks.activity,
    contextStale: mocks.stale,
    submissionId: 'submission',
    triage: null,
  }),
  sendFactoryPlanning: mocks.send,
  refreshFactoryPlanningContext: mocks.refreshContext,
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
  mocks.refreshContext.mockReset();
  mocks.stale = false;
  mocks.plannerStarted = true;
  mocks.activity = 'completed';
  mocks.agent.historyReady = true;
  detail.work.lifecycle = 'shaping';
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

async function typeReply(value: string) {
  const textarea = container.querySelector('textarea')!;
  expect(textarea.disabled).toBe(false);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function sendButton() {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Send',
  )!;
}
it.each(['stale', 'pending', 'paused', 'closed', 'queued'])(
  'allows a multiline draft but blocks submission while %s',
  async (gate) => {
    mocks.stale = gate === 'stale';
    if (gate === 'pending') mocks.activity = 'pending';
    if (gate === 'paused' || gate === 'closed' || gate === 'queued')
      detail.work.lifecycle = gate;
    await render();
    const textarea = container.querySelector('textarea')!;
    expect(textarea.rows).toBe(4);
    expect(container.querySelector('label')!.htmlFor).toBe(textarea.id);
    expect(container.querySelector('label')!.textContent).toBe('Reply to Neon');
    expect(textarea.placeholder).toBe(
      'Answer a question or ask Neon to revise the plan…',
    );
    await typeReply('First answer\nSecond answer');
    expect(sessionStorage.getItem(draftKey)).toBe(
      'First answer\nSecond answer',
    );
    expect(sendButton().disabled).toBe(true);
    await act(async () =>
      textarea.form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(mocks.send).not.toHaveBeenCalled();
  },
);
it('keeps Shift+Enter for newlines and Enter for sending the multiline reply', async () => {
  await render();
  await typeReply('First answer\nSecond answer');
  const textarea = container.querySelector('textarea')!;
  const newline = new KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    textarea.dispatchEvent(newline);
  });
  expect(newline.defaultPrevented).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
  mocks.send.mockResolvedValue({});
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(mocks.send.mock.calls[0][1].message).toBe(
    'First answer\nSecond answer',
  );
});
it('locks the editor and new sends while an uncertain request is retained', async () => {
  sessionStorage.setItem(draftKey, 'Original reply');
  mocks.send.mockRejectedValueOnce(new Error('Receipt lost'));
  await render();
  await click('Send');
  expect(container.querySelector('textarea')!.disabled).toBe(true);
  expect(sendButton().disabled).toBe(true);
  expect(JSON.parse(sessionStorage.getItem(requestKey)!).message).toBe(
    'Original reply',
  );
});
it('keeps ordinary chat compact and its existing editing gate', async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <FlueChatSessionView
          activeRecord={undefined}
          agentName="display-assistant"
          allowCommands={false}
          messageEnabled={false}
          quickCommands={[]}
          session={{
            id: 'ordinary',
            label: 'Chat',
            placeholder: 'Message Neon',
          }}
          sessionState={undefined}
        />
      </QueryClientProvider>,
    ),
  );
  const textarea = container.querySelector('textarea')!;
  expect(textarea.rows).toBe(1);
  expect(textarea.disabled).toBe(true);
  expect(container.querySelector('.flue-chat-composer-reply')).toBeNull();
});

it('refreshes stale context explicitly without submitting or losing the draft', async () => {
  mocks.stale = true;
  await render();
  await typeReply('First answer\nSecond answer');
  const textarea = container.querySelector('textarea')!;

  expect(textarea.form!.textContent).toContain(
    'refresh context before sending',
  );
  expect(
    [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Refresh planning context',
    ),
  ).toHaveLength(1);
  expect(mocks.refreshContext).not.toHaveBeenCalled();
  mocks.refreshContext.mockImplementation(async () => {
    mocks.stale = false;
  });
  await click('Refresh planning context');
  expect(mocks.refreshContext).toHaveBeenCalledWith('task', 1);
  expect(textarea.value).toBe('First answer\nSecond answer');
  expect(sendButton().disabled).toBe(false);

  expect(mocks.send).not.toHaveBeenCalled();
});
it.each(['history', 'stale', 'pending'])(
  'blocks keyboard submission while %s is gated, preserving the draft',
  async (gate) => {
    mocks.agent.historyReady = gate !== 'history';
    mocks.stale = gate === 'stale';
    if (gate === 'pending') mocks.activity = 'pending';
    await render();
    await typeReply('Draft while waiting');
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Draft while waiting');
    expect(sessionStorage.getItem(draftKey)).toBe('Draft while waiting');
  },
);

it('shows preparation while initial planning admission is unresolved and retains retry gates on failure', async () => {
  mocks.plannerStarted = false;
  let reject!: (error: Error) => void;
  mocks.send.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await render();
  await click('Ask Neon to plan');
  const preparing = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Preparing planning…',
  )!;
  expect(preparing.disabled).toBe(true);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  await act(async () => {
    reject(new Error('Admission response lost'));
  });
  const start = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Ask Neon to plan',
  )!;
  expect(start.disabled).toBe(true);
  expect(container.textContent).toContain('Retry original request');
  expect(container.textContent).not.toContain('Preparing planning…');
});
it.each([false, true])(
  'shows refresh progress with stale=%s and restores the control after completion',
  async (stale) => {
    mocks.stale = stale;
    let resolve!: () => void;
    mocks.refreshContext.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await render();
    await click('Refresh planning context');
    const refreshing = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Refreshing context…',
    )!;
    expect(refreshing.disabled).toBe(true);
    expect(mocks.refreshContext).toHaveBeenCalledWith('task', 1);
    expect(mocks.send).not.toHaveBeenCalled();
    await act(async () => {
      resolve();
    });
    const refresh = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Refresh planning context',
    )!;
    expect(refresh.disabled).toBe(false);
    expect(container.textContent).not.toContain('Refreshing context…');
  },
);
