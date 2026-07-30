// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrWatch } from '../api';
import { activePrWatches, WatchRow } from './ActiveWatches';

const flue = vi.hoisted(() => ({
  sendMessage: vi.fn<(message: string) => Promise<void>>(async () => undefined),
  useFlueAgent: vi.fn<(input: { name: string; id?: string }) => void>(),
}));
const api = vi.hoisted(() => ({
  messagePrAutopilotOwner: vi.fn<
    (
      id: string,
      message: string,
    ) => Promise<{
      ok: boolean;
      action: string;
      changed: boolean;
      message: string;
    }>
  >(async () => ({
    ok: true,
    action: 'autopilot_owner_message',
    changed: true,
    message: 'Sent the human instruction.',
  })),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  messagePrAutopilotOwner: api.messagePrAutopilotOwner,
}));

vi.mock('@flue/react', () => ({
  useFlueAgent: (input: { name: string; id?: string }) => {
    flue.useFlueAgent(input);
    return {
      error: undefined,
      historyReady: true,
      messages: [
        {
          id: 'owner-history-1',
          role: 'assistant',
          parts: [
            { type: 'text', state: 'done', text: 'Held change is ready.' },
          ],
        },
      ],
      sendMessage: flue.sendMessage,
      status: 'idle',
    };
  },
  useFlueClient: () => ({
    workflows: {
      invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    },
  }),
}));

describe('ActiveWatches owner conversation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    flue.sendMessage.mockClear();
    flue.useFlueAgent.mockClear();
    api.messagePrAutopilotOwner.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('opens and continues the exact durable PR owner instead of creating a display chat', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow watch={watch()} />
        </QueryClientProvider>,
      ),
    );

    expect(container.textContent).not.toContain(
      'Does the same work, then waits; only your direct instruction in the owner chat can authorize it to push or respond.',
    );
    expect(
      Array.from(container.querySelectorAll('option')).map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual([
      'Notify only · no coding',
      'Prepare commit · never push',
      'Prepare commit · push after approval',
      'Autonomous judgment + delivery',
    ]);
    expect(container.textContent).not.toContain('Held change is ready.');
    expect(
      container.querySelector('button[aria-label^="Open chat"]'),
    ).toBeNull();
    act(() =>
      button(
        'Review owner agent for pandemicsyn/neondeck pull request 172',
      ).click(),
    );

    expect(flue.useFlueAgent).toHaveBeenCalledWith({
      name: 'pr-autopilot-owner',
      id: 'pr-owner-exact-172',
    });
    expect(container.textContent).toContain('pr-owner-exact-172');
    expect(container.textContent).toContain('Held change is ready.');
    const transcript = container.querySelector(
      '[aria-label="Chat transcript"]',
    );
    expect(transcript?.parentElement?.parentElement?.classList).toContain(
      'h-full',
    );

    const composer = container.querySelector(
      'textarea[aria-label="Message owner for pandemicsyn/neondeck pull request 172"]',
    ) as HTMLTextAreaElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(composer, 'approved, push');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      composer.form?.dispatchEvent(
        new SubmitEvent('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(api.messagePrAutopilotOwner).toHaveBeenCalledWith(
      'pandemicsyn/neondeck#172',
      'approved, push',
    );
    expect(flue.sendMessage).not.toHaveBeenCalled();

    function button(label: string) {
      return container.querySelector(
        `button[aria-label="${label}"]`,
      ) as HTMLButtonElement;
    }
  });

  it('puts an explicit guarded approval action after the prepared diff', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow watch={watch()} />
        </QueryClientProvider>,
      ),
    );

    act(() => buttonWithText(container, 'review diff').click());
    expect(container.textContent).toContain(
      'Push authority and current-branch guards are checked again before delivery.',
    );

    act(() => buttonWithText(container, 'approve & push').click());
    expect(container.textContent).toContain(
      'Approve this prepared commit and ask the owner to push it to the linked PR branch?',
    );
    await act(async () =>
      buttonWithText(container, 'confirm approval').click(),
    );

    expect(api.messagePrAutopilotOwner).toHaveBeenCalledWith(
      'pandemicsyn/neondeck#172',
      'I reviewed the prepared diff. Approved: push this held commit to the linked pull request branch.',
    );
  });
});

describe('ActiveWatches visibility', () => {
  it('keeps completed watch records out of the active panel', () => {
    expect(
      activePrWatches([
        watch(),
        watch({
          id: 'pandemicsyn/neondeck#173',
          prNumber: 173,
          autopilotStatus: 'complete',
        }),
      ]).map((item) => item.id),
    ).toEqual(['pandemicsyn/neondeck#172']);
  });

  it('does not repeat the idle watching status', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow
            watch={watch({ status: 'watching', autopilotStatus: 'watching' })}
          />
        </QueryClientProvider>,
      ),
    );

    expect(container.textContent?.match(/watching/g)).toHaveLength(1);

    act(() => root.unmount());
  });

  it('shows aggregate review approval as ready', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow
            watch={watch({
              status: 'ready',
              lastSnapshot: {
                ...watch().lastSnapshot!,
                reviewDecision: 'APPROVED',
              },
            })}
          />
        </QueryClientProvider>,
      ),
    );

    expect(container.textContent).toContain('ready');
    expect(container.textContent).toContain('review approved');

    act(() => root.unmount());
  });

  it('shows that a merged watch is waiting for checks to settle', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow
            watch={watch({
              status: 'ready',
              prState: 'closed',
              lastSnapshot: {
                ...watch().lastSnapshot!,
                state: 'closed',
                merged: true,
                reviewDecision: 'APPROVED',
                checks: {
                  status: 'pending',
                  total: 18,
                  successful: 8,
                  failed: 0,
                  pending: 10,
                  checkedAt: '2026-07-23T17:19:37.374Z',
                },
              },
            })}
          />
        </QueryClientProvider>,
      ),
    );

    expect(container.textContent).toContain('merged · checks pending');
    expect(container.textContent).not.toContain('ready');

    act(() => root.unmount());
  });

  it('keeps the conditional attention reason visible without mode help', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow
            watch={watch({
              prState: 'closed',
              lastSnapshot: {
                ...watch().lastSnapshot!,
                state: 'closed',
                merged: true,
                checks: {
                  status: 'failure',
                  total: 46,
                  successful: 45,
                  failed: 1,
                  pending: 0,
                  checkedAt: '2026-07-20T05:01:00.000Z',
                },
              },
            })}
          />
        </QueryClientProvider>,
      ),
    );

    expect(container.textContent).toContain(
      'why · Merged, but 1 of 46 checks failed.',
    );
    expect(container.textContent).not.toContain(
      'Does the same work, then waits; only your direct instruction in the owner chat can authorize it to push or respond.',
    );

    act(() => root.unmount());
  });
});

function watch(overrides: Partial<PrWatch> = {}): PrWatch {
  return {
    id: 'pandemicsyn/neondeck#172',
    repoId: 'neondeck',
    repoFullName: 'pandemicsyn/neondeck',
    githubOwner: 'pandemicsyn',
    githubName: 'neondeck',
    prNumber: 172,
    desiredTerminalState: 'merged',
    status: 'attention-needed',
    prState: 'open',
    title: 'Autopilot simplification',
    url: 'https://github.com/pandemicsyn/neondeck/pull/172',
    mergeCommitSha: null,
    lastSnapshot: {
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      checks: null,
      title: 'Autopilot simplification',
      url: 'https://github.com/pandemicsyn/neondeck/pull/172',
      updatedAt: '2026-07-20T05:00:00.000Z',
      headSha: 'a'.repeat(40),
      baseRef: 'main',
    },
    lastCheckedAt: '2026-07-20T05:01:00.000Z',
    createdBy: 'autopilot',
    processExisting: false,
    autopilotMode: 'autofix-with-approval',
    autopilotStatus: 'waiting',
    ownerInstanceId: 'pr-owner-exact-172',
    worktreeId: 'worktree-172',
    worktreeHeadSha: 'a'.repeat(40),
    lastEventFingerprint: 'feedback-1',
    updatedAt: '2026-07-20T05:01:00.000Z',
    ...overrides,
  };
}

function buttonWithText(container: HTMLElement, text: string) {
  const match = Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Missing button "${text}".`);
  return match;
}
