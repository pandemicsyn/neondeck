// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrWatch } from '../api';
import { activePrWatches, WatchRow } from './ActiveWatches';

const flue = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => undefined),
  useFlueAgent: vi.fn(),
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
  useFlueClient: () => ({ workflows: { invoke: vi.fn() } }),
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

    expect(container.textContent).toContain(
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
    expect(flue.sendMessage).toHaveBeenCalledWith('approved, push');

    function button(label: string) {
      return container.querySelector(
        `button[aria-label="${label}"]`,
      ) as HTMLButtonElement;
    }
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
