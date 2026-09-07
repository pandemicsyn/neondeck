// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FactoryPlanning } from './FactoryPlanning';
import {
  emptyFactorySpec,
  type FactoryDetail,
} from '../../../../shared/factory';
import { ApiError } from '../../api/http';
const api = vi.hoisted(() => ({
  getFactoryPlanning: vi.fn(),
  retryFactoryTriage: vi.fn(),
  sendFactoryPlanning: vi.fn(),
  recoverFactoryPlanning: vi.fn(),
  refreshFactoryPlanningContext: vi.fn(),
  stopFactoryPlanning: vi.fn(),
}));
vi.mock('../../api/factory', () => api);
vi.mock('../flue-chat/components/session-view', () => ({
  FlueChatSessionView: ({
    onSendMessage,
    responsePending,
    emptyMessage,
    consumedDraft,
  }: {
    onSendMessage: (message: string) => Promise<void>;
    responsePending?: boolean;
    emptyMessage?: string;
    consumedDraft?: { message: string };
  }) => {
    const [text, setText] = useState('');
    return (
      <form
        data-consumed-message={consumedDraft?.message}
        aria-label={responsePending ? 'Response pending' : emptyMessage}
        onSubmit={(e) => {
          e.preventDefault();
          void onSendMessage(text)
            .then(() => setText(''))
            .catch(() => {});
        }}
      >
        <input
          aria-label="Reply"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button>Send</button>
      </form>
    );
  },
}));
const ready = {
  sessionId: 'factory-test',
  plannerStarted: true,
  contextCapturedAt: '2026-01-01',
  model: 'faux/faux-1',
  contextStale: false,
  triage: null,
  activity: 'completed',
  error: null,
  submissionId: 'sub-1',
};
const detail = {
  work: { id: 'work-1', version: 1, lifecycle: 'shaping' },
  revisions: [{ version: 1, spec: emptyFactorySpec() }],
} as FactoryDetail;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.getFactoryPlanning.mockResolvedValue(ready);
  client.setQueryData(['factory-planning', 'work-1'], ready);
  api.sendFactoryPlanning.mockResolvedValue({
    sessionId: 'factory-test',
    intentId: 'i1',
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});
async function render(value = detail) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <FactoryPlanning detail={value} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
  });
}
async function typeReply() {
  const input = container.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, 'Keep this reply');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}
it('keeps the cached conversation and unsent reply mounted during background refetch failure', async () => {
  client.setQueryData(['factory-planning', 'work-1'], ready);
  await render();
  const input = await typeReply();
  api.getFactoryPlanning.mockRejectedValue(new Error('offline'));
  await act(async () => {
    await client.refetchQueries({ queryKey: ['factory-planning', 'work-1'] });
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(container.textContent).toContain('Planning refresh failed');
  expect(container.querySelector('input')).toBe(input);
  expect(input.value).toBe('Keep this reply');
});
it('shows initial-load failure without pretending a conversation exists', async () => {
  client.clear();
  api.getFactoryPlanning.mockRejectedValue(new Error('offline'));
  await render();
  await render();
  expect(container.textContent).toContain('Planning state unavailable');
  expect(container.querySelector('input')).toBeNull();
});
it('requires explicit review before replacing a rejected request and preserves the unsent message', async () => {
  client.setQueryData(['factory-planning', 'work-1'], ready);
  await render();
  await typeReply();
  api.sendFactoryPlanning.mockRejectedValueOnce(
    new ApiError('Task changed', 409, '/api/factory', {}),
  );
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(container.querySelector('input')!.value).toBe('Keep this reply');
  await render({ ...detail, work: { ...detail.work, version: 2 } });
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find(
        (b) => b.textContent === 'Dismiss rejection and review a new request',
      )!
      .click();
  });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
  const first = api.sendFactoryPlanning.mock.calls[0][1],
    second = api.sendFactoryPlanning.mock.calls[1][1];
  expect(second.message).toBe(first.message);
  expect(second.requestKey).not.toBe(first.requestKey);
  expect(second.expectedVersion).toBe(2);
});

it('restores the exact uncertain envelope across reload and changed context without a duplicate admission', async () => {
  const discussion = {
    version: 1,
    hash: 'a'.repeat(64),
    kind: 'section' as const,
    id: 'approach',
  };
  const admitted = new Map<string, unknown>();
  api.sendFactoryPlanning.mockImplementation(async (_id, envelope) => {
    if (!admitted.has(envelope.requestKey)) {
      admitted.set(envelope.requestKey, structuredClone(envelope));
      throw new Error('HTTP response lost after durable admission');
    }
    expect(envelope).toEqual(admitted.get(envelope.requestKey));
    return { sessionId: 'factory-test', intentId: 'durable-one' };
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <FactoryPlanning detail={detail} discussion={discussion} />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
  });
  await typeReply();
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
  const first = api.sendFactoryPlanning.mock.calls[0][1];
  expect(
    JSON.parse(sessionStorage.getItem('factory-planning-request:work-1')!),
  ).toEqual({
    ...first,
    composer: {
      message: 'Keep this reply',
      storageKey: 'factory-chat-draft:work-1:factory-test',
    },
  });
  await act(async () => root.unmount());
  root = createRoot(container);
  client.setQueryData(['factory-planning', 'work-1'], {
    ...ready,
    contextStale: true,
  });
  api.getFactoryPlanning.mockResolvedValue({ ...ready, contextStale: true });
  await render({
    ...detail,
    work: { ...detail.work, version: 3, lifecycle: 'queued' },
  });
  expect(container.textContent).toContain(
    'Original reference: v1 · section: approach',
  );
  expect(container.textContent).toContain('Planning receipt not confirmed');
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Retry original request')!
      .click();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(api.sendFactoryPlanning.mock.calls[1][1]).toEqual(first);
  expect(admitted.size).toBe(1);
  expect(sessionStorage.getItem('factory-planning-request:work-1')).toBeNull();
});
it('does not dispatch if durable browser envelope storage fails', async () => {
  await render();
  await typeReply();
  const fail = vi
    .spyOn(Object.getPrototypeOf(sessionStorage), 'setItem')
    .mockImplementation(() => {
      throw new Error('Storage unavailable');
    });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(api.sendFactoryPlanning).not.toHaveBeenCalled();
  fail.mockRestore();
});

it('keeps the transcript mounted after successful planning admission', async () => {
  await render();
  const input = await typeReply();
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(api.sendFactoryPlanning).toHaveBeenCalledTimes(1);
  expect(container.querySelector('input')).toBe(input);
  expect(input.value).toBe('');
});

it('restores pending activity from server state before any local send', async () => {
  api.getFactoryPlanning.mockResolvedValue({ ...ready, activity: 'pending' });
  client.setQueryData(['factory-planning', 'work-1'], {
    ...ready,
    activity: 'pending',
  });
  await render();
  expect(container.querySelector('form')?.getAttribute('aria-label')).toBe(
    'Response pending',
  );
  expect(container.textContent).toContain('Neon is working on this request');
  expect(api.sendFactoryPlanning).not.toHaveBeenCalled();
});
it('provides task-specific empty conversation guidance', async () => {
  await render();
  expect(container.querySelector('form')?.getAttribute('aria-label')).toContain(
    'revise this brief',
  );
});

it('retains a newer composer draft when retry confirms the original request', async () => {
  sessionStorage.setItem(
    'factory-planning-request:work-1',
    JSON.stringify({
      requestKey: 'retained-request',
      message: 'Original request',
      expectedVersion: 1,
    }),
  );
  const draftKey = 'factory-chat-draft:work-1:factory-test';
  sessionStorage.setItem(draftKey, 'Newer unsent reply');
  await render();
  const input = await typeReply();
  await act(async () => {
    [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Retry original request')!
      .click();
    await new Promise((r) => setTimeout(r, 10));
  });
  expect(sessionStorage.getItem(draftKey)).toBe('Newer unsent reply');
  expect(container.querySelector('input')).toBe(input);
  expect(input.value).toBe('Keep this reply');
  expect(container.querySelector('form')?.dataset.consumedMessage).toBe(
    'Original request',
  );
});

it('keeps recovery actions before collapsed original payload and provides a keyboard-scrollable region', async () => {
  const message =
    'Please review\n\n' +
    JSON.stringify({ evidence: 'Long retained evidence'.repeat(50) });
  sessionStorage.setItem(
    'factory-planning-request:work-1',
    JSON.stringify({
      requestKey: 'retained-request',
      message,
      expectedVersion: 1,
      discussion: {
        version: 1,
        hash: 'a'.repeat(64),
        kind: 'section',
        id: 'approach',
      },
    }),
  );
  await render();
  const disclosure = [...container.querySelectorAll('details')].find(
    (el) =>
      el.querySelector('summary')?.textContent ===
      'Review original request and context',
  )!;
  const retry = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === 'Retry original request',
  )!;
  expect(disclosure.open).toBe(false);
  expect(
    retry.compareDocumentPosition(disclosure) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(disclosure.textContent).toContain('Original reference: v1');
  const payload = disclosure.querySelector<HTMLElement>('[role="region"]')!;
  expect(payload.getAttribute('aria-label')).toBe('Original planning request');
  expect(payload.tabIndex).toBe(0);
  expect(payload.textContent).toBe(message);
  api.sendFactoryPlanning.mockRejectedValueOnce(
    new ApiError('Task changed', 409, '/api/factory', {}),
  );
  await act(async () => {
    retry.click();
    await new Promise((r) => setTimeout(r, 10));
  });
  const dismiss = [...container.querySelectorAll('button')].find(
    (el) => el.textContent === 'Dismiss rejection and review a new request',
  )!;
  expect(
    dismiss.compareDocumentPosition(disclosure) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(api.sendFactoryPlanning.mock.calls[0][1].message).toBe(message);
});
