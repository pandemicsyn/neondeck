// @vitest-environment jsdom

import type { UseFlueAgentOptions, UseFlueAgentResult } from '@flue/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrReviewRecord } from '../../api';
import { PrReviewReviewerChat } from './PrReviewReviewerChat';

const useFlueAgentMock = vi.hoisted(() =>
  vi.fn<(options: UseFlueAgentOptions) => UseFlueAgentResult>(),
);

const conversationClient = vi.hoisted(() => ({ client: { url: 'test:' } }));

vi.mock('@flue/react', () => ({ useFlueAgent: useFlueAgentMock }));
vi.mock('../../lib/flue', () => ({
  createNeondeckConversationClient: () => conversationClient.client,
}));

describe('PrReviewReviewerChat', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useFlueAgentMock.mockReturnValue({
      messages: [],
      status: 'error',
      historyReady: false,
      error: new Error('History request failed.'),
      failedSends: [],
      settlements: [],
      sendMessage: vi.fn<UseFlueAgentResult['sendMessage']>(),
      refresh: vi.fn<() => void>(),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useFlueAgentMock.mockReset();
  });

  it('scopes history to the reviewed revision and offers reconnect on failure', async () => {
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;

    act(() => root.render(<PrReviewReviewerChat review={review} />));

    expect(useFlueAgentMock).toHaveBeenLastCalledWith({
      client: conversationClient.client,
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'History request failed.',
    );
    const reconnect = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Reconnect',
    );
    expect(reconnect).toBeDefined();

    await act(async () => {
      reconnect?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(useFlueAgentMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('explains that revision-bound chat reconnects after a re-review', () => {
    const review = {
      id: 'review-123',
      headSha: 'b'.repeat(40),
      status: 'reviewing',
    } as PrReviewRecord;

    act(() => root.render(<PrReviewReviewerChat review={review} />));

    expect(container.textContent).toContain(
      'Neon is reviewing the current PR revision.',
    );
    expect(container.textContent).toContain(
      'conversation will reconnect when it finishes',
    );
    expect(useFlueAgentMock).not.toHaveBeenCalled();
  });

  it('submits with Enter while preserving Shift+Enter for newlines', async () => {
    const sendMessage = vi.fn<UseFlueAgentResult['sendMessage']>(
      async () => undefined,
    );
    useFlueAgentMock.mockReturnValue({
      messages: [],
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage,
      refresh: vi.fn<() => void>(),
    });
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;

    act(() => root.render(<PrReviewReviewerChat review={review} />));

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(container.textContent).toContain('Enter send · Shift+Enter newline');

    await act(async () => {
      setTextareaValue(textarea!, 'What changed?');
      textarea!.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
          shiftKey: true,
        }),
      );
      await Promise.resolve();
    });
    expect(sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      textarea!.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        }),
      );
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenCalledWith('What changed?');
    expect(textarea?.value).toBe('');
  });

  it('locks new reviewer requests during a revision update', () => {
    useFlueAgentMock.mockReturnValue({
      messages: [],
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage: vi.fn<UseFlueAgentResult['sendMessage']>(),
      refresh: vi.fn<() => void>(),
    });
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;

    act(() => root.render(<PrReviewReviewerChat isLocked review={review} />));

    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(container.querySelector('textarea')?.placeholder).toBe(
      'Wait for the PR revision update to finish.',
    );
  });

  it('admits a follow-up while the reviewer is streaming', async () => {
    const sendMessage = vi.fn<UseFlueAgentResult['sendMessage']>(
      async () => undefined,
    );
    useFlueAgentMock.mockReturnValue({
      messages: [],
      status: 'streaming',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage,
      refresh: vi.fn<() => void>(),
    });
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;

    act(() => root.render(<PrReviewReviewerChat review={review} />));

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);
    expect(container.textContent).toContain(
      'Reviewer is responding · follow-ups are queued',
    );

    await act(async () => {
      setTextareaValue(textarea!, 'Please also inspect the retry path.');
      textarea!.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'Enter',
        }),
      );
      await Promise.resolve();
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'Please also inspect the retry path.',
    );
  });

  it('reports successful local draft mutations once so the review can refresh', () => {
    const onDraftChanged = vi.fn<() => void>();
    useFlueAgentMock.mockReturnValue({
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          purpose: 'answer',
          display: 'visible',
          parts: [
            {
              type: 'dynamic-tool',
              toolName: 'neondeck_pr_review_draft_comment_update',
              toolCallId: 'tool-call-1',
              state: 'output-available',
              input: { commentId: 'comment-1' },
              output: { ok: true, changed: false },
            },
          ],
        },
      ] as never,
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage: vi.fn<UseFlueAgentResult['sendMessage']>(),
      refresh: vi.fn<() => void>(),
    });
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;

    act(() =>
      root.render(
        <PrReviewReviewerChat
          onDraftChanged={onDraftChanged}
          review={review}
        />,
      ),
    );
    expect(onDraftChanged).toHaveBeenCalledTimes(1);

    act(() =>
      root.render(
        <PrReviewReviewerChat
          onDraftChanged={onDraftChanged}
          review={review}
        />,
      ),
    );
    expect(onDraftChanged).toHaveBeenCalledTimes(1);
  });
});

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
