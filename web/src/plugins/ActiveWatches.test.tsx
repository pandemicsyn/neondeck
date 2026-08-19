// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrWatch } from '../api';
import { activePrWatches, StopOutcomeNotice, WatchRow } from './ActiveWatches';

const flue = vi.hoisted(() => ({
  client: { url: 'test:owner' },
  messages: [
    {
      id: 'owner-history-1',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      parts: [{ type: 'text', state: 'done', text: 'Held change is ready.' }],
    },
  ] as Array<Record<string, unknown>>,
  settlements: [] as Array<{
    submissionId: string;
    outcome: 'completed' | 'failed' | 'aborted';
  }>,
  sendMessage: vi.fn<(message: string) => Promise<void>>(async () => undefined),
  useFlueAgent: vi.fn<(input: unknown) => void>(),
}));
const api = vi.hoisted(() => ({
  controlPrAutopilot: vi.fn<
    (
      id: string,
      operation: 'pause' | 'resume' | 'retry' | 'stop',
      options?: { confirmPreparedDiff?: boolean },
    ) => Promise<{
      ok: boolean;
      action: string;
      changed: boolean;
      message: string;
      detachedWorktreeId?: string | null;
      cleanupRecovery?: string | null;
    }>
  >(async () => ({
    ok: true,
    action: 'autopilot_watch_stop',
    changed: true,
    message: 'Stopped Autopilot.',
  })),
  configurePrAutopilot: vi.fn<
    (input: {
      ref: string;
      mode:
        | 'notify-only'
        | 'prepare-only'
        | 'autofix-with-approval'
        | 'autofix-push-when-safe';
      processExisting: boolean;
      confirm?: boolean;
    }) => Promise<{
      ok: boolean;
      action: string;
      changed: boolean;
      message: string;
      dispatchId?: string | null;
    }>
  >(async () => ({
    ok: true,
    action: 'autopilot_configure_pr',
    changed: true,
    message: 'Configured Autopilot.',
  })),
  approvePrAutopilotChange: vi.fn<
    (
      id: string,
      expectedRevisionKey: string,
    ) => Promise<{
      ok: boolean;
      action: string;
      changed: boolean;
      message: string;
    }>
  >(async () => ({
    ok: true,
    action: 'autopilot_change_approve',
    changed: true,
    message: 'Approved the reviewed change.',
  })),
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
    dispatchId: 'sub-owner-message-1',
  })),
}));
const diffViewer = vi.hoisted(() => ({
  onReviewStateChange: undefined as
    | ((state: {
        status: 'loading' | 'unavailable' | 'empty' | 'reviewable';
        revisionKey: string | null;
      }) => void)
    | undefined,
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  controlPrAutopilot: api.controlPrAutopilot,
  configurePrAutopilot: api.configurePrAutopilot,
  approvePrAutopilotChange: api.approvePrAutopilotChange,
  messagePrAutopilotOwner: api.messagePrAutopilotOwner,
}));

vi.mock('../features/diff-viewer/surfaces', () => ({
  WorktreeDiffReview: (props: {
    onReviewStateChange?: typeof diffViewer.onReviewStateChange;
  }) => {
    diffViewer.onReviewStateChange = props.onReviewStateChange;
    return <div>Prepared diff</div>;
  },
}));

vi.mock('@flue/react', () => ({
  useFlueAgent: (input: unknown) => {
    flue.useFlueAgent(input);
    return {
      error: undefined,
      historyReady: true,
      messages: flue.messages,
      settlements: flue.settlements,
      sendMessage: flue.sendMessage,
      status: 'idle',
    };
  },
}));

vi.mock('../lib/flue', () => ({
  createNeondeckConversationClient: () => flue.client,
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
    flue.messages.splice(1);
    flue.settlements.splice(0);
    api.controlPrAutopilot.mockClear();
    api.configurePrAutopilot.mockClear();
    api.approvePrAutopilotChange.mockClear();
    api.messagePrAutopilotOwner.mockClear();
    diffViewer.onReviewStateChange = undefined;
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
      'Does the same work, then waits for Review diff → Approve & push. Owner chat can guide edits or discard the held change, but cannot authorize delivery.',
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
      client: flue.client,
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
    expect(container.textContent).toContain('Neon is working…');

    flue.messages.push({
      id: 'owner-response-1',
      role: 'assistant',
      purpose: 'assistant',
      display: 'visible',
      submissionId: 'sub-owner-message-1',
      parts: [],
    });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow watch={watch()} />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain('Neon is responding…');

    flue.settlements.push({
      submissionId: 'sub-owner-message-1',
      outcome: 'completed',
    });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow watch={watch()} />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).not.toContain('Neon is responding…');

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
    expect(container.textContent).not.toContain('approve & push');

    act(() =>
      diffViewer.onReviewStateChange?.({
        status: 'reviewable',
        revisionKey: 'worktree-diff:base-sha:reviewed-revision',
      }),
    );
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

    expect(api.approvePrAutopilotChange).toHaveBeenCalledWith(
      'pandemicsyn/neondeck#172',
      'worktree-diff:base-sha:reviewed-revision',
    );
    expect(api.messagePrAutopilotOwner).not.toHaveBeenCalled();
  });

  it('confirms authority increases but applies downgrades directly', async () => {
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
    const select = container.querySelector(
      `select[aria-label="Autopilot mode for pandemicsyn/neondeck#172"]`,
    ) as HTMLSelectElement;

    await act(async () => {
      select.value = 'prepare-only';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(api.configurePrAutopilot).toHaveBeenLastCalledWith({
      ref: 'pandemicsyn/neondeck#172',
      mode: 'prepare-only',
      processExisting: false,
      confirm: false,
    });
    expect(container.textContent).not.toContain('confirm increase');

    await act(async () => {
      select.value = 'autofix-push-when-safe';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.textContent).toContain(
      'Increase Autopilot authority to autofix-push-when-safe?',
    );
    expect(api.configurePrAutopilot).toHaveBeenCalledTimes(1);

    await act(async () =>
      buttonWithText(container, 'confirm increase').click(),
    );
    expect(api.configurePrAutopilot).toHaveBeenLastCalledWith({
      ref: 'pandemicsyn/neondeck#172',
      mode: 'autofix-push-when-safe',
      processExisting: false,
      confirm: true,
    });
  });

  it('confirms prepared-commit discard explicitly before stopping', async () => {
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

    act(() => buttonWithText(container, 'stop').click());
    expect(container.textContent).toContain(
      'If one holds an unpushed prepared commit, this confirms that you reviewed and want to discard it.',
    );
    expect(api.controlPrAutopilot).not.toHaveBeenCalled();

    await act(async () => buttonWithText(container, 'confirm').click());
    expect(api.controlPrAutopilot).toHaveBeenCalledWith(
      'pandemicsyn/neondeck#172',
      'stop',
      { confirmPreparedDiff: true },
    );
  });

  it('reports a retained cleanup result before the completed watch row disappears', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const onStopOutcome = vi.fn();
    api.controlPrAutopilot.mockResolvedValueOnce({
      ok: true,
      action: 'autopilot_watch_stop',
      changed: true,
      message: 'Stopped Autopilot with a retained worktree.',
      detachedWorktreeId: 'worktree-recovery-172',
      cleanupRecovery:
        'Managed worktree worktree-recovery-172 was retained for manual recovery.',
    });
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <WatchRow onStopOutcome={onStopOutcome} watch={watch()} />
        </QueryClientProvider>,
      ),
    );

    act(() => buttonWithText(container, 'stop').click());
    await act(async () => buttonWithText(container, 'confirm').click());

    expect(onStopOutcome).toHaveBeenCalledWith({
      watchId: 'pandemicsyn/neondeck#172',
      message: 'Stopped Autopilot with a retained worktree.',
      detachedWorktreeId: 'worktree-recovery-172',
      cleanupRecovery:
        'Managed worktree worktree-recovery-172 was retained for manual recovery.',
    });
  });

  it('withdraws approval when the loaded diff becomes empty or unavailable', () => {
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
    act(() =>
      diffViewer.onReviewStateChange?.({
        status: 'reviewable',
        revisionKey: 'worktree-diff:base-sha:reviewed-revision',
      }),
    );
    expect(container.textContent).toContain('approve & push');

    act(() =>
      diffViewer.onReviewStateChange?.({
        status: 'empty',
        revisionKey: null,
      }),
    );
    expect(container.textContent).not.toContain('approve & push');
  });
});

describe('ActiveWatches visibility', () => {
  it('keeps retained-worktree recovery visible until dismissed', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onDismiss = vi.fn();

    act(() =>
      root.render(
        <StopOutcomeNotice
          onDismiss={onDismiss}
          outcome={{
            watchId: 'pandemicsyn/neondeck#172',
            message: 'Stopped Autopilot.',
            detachedWorktreeId: 'worktree-recovery-172',
            cleanupRecovery:
              'The worktree was retained and detached for manual recovery.',
          }}
        />,
      ),
    );

    expect(container.textContent).toContain('Worktree retained for recovery');
    expect(container.textContent).toContain(
      'The worktree was retained and detached for manual recovery.',
    );
    expect(container.textContent).toContain(
      'Recovery worktree: worktree-recovery-172',
    );
    act(() => buttonWithText(container, 'dismiss').click());
    expect(onDismiss).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

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
      'Does the same work, then waits for Review diff → Approve & push. Owner chat can guide edits or discard the held change, but cannot authorize delivery.',
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
