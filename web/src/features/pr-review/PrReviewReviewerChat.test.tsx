// @vitest-environment jsdom

import type { UseFlueAgentOptions, UseFlueAgentResult } from '@flue/react';
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrReviewRecord } from '../../api';
import { prReviewerConversationId } from '../../../../shared/pr-reviewer-session';
import {
  PrReviewReviewerChat,
  PrReviewReviewerController,
} from './PrReviewReviewerChat';

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

  it('activates only tours published after history hydration', () => {
    const onTourPublished =
      vi.fn<(tourId: string, generation: number) => void>();
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;
    const historicalPublication = tourPublicationMessage(
      'assistant-history',
      'tool-call-history',
      'tour-history',
      1,
    );
    const agentResult = {
      messages: [historicalPublication],
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage: vi.fn<UseFlueAgentResult['sendMessage']>(),
      refresh: vi.fn<() => void>(),
    } as UseFlueAgentResult;
    useFlueAgentMock.mockReturnValue(agentResult);

    act(() =>
      root.render(
        <PrReviewReviewerChat
          onTourPublished={onTourPublished}
          review={review}
        />,
      ),
    );
    expect(onTourPublished).not.toHaveBeenCalled();

    useFlueAgentMock.mockReturnValue({
      ...agentResult,
      messages: [
        historicalPublication,
        tourPublicationMessage(
          'assistant-live',
          'tool-call-live',
          'tour-live',
          2,
        ),
      ],
    });
    act(() =>
      root.render(
        <PrReviewReviewerChat
          onTourPublished={onTourPublished}
          review={review}
        />,
      ),
    );
    expect(onTourPublished).toHaveBeenCalledTimes(1);
    expect(onTourPublished).toHaveBeenCalledWith('tour-live', 2);

    act(() =>
      root.render(
        <PrReviewReviewerChat
          onTourPublished={onTourPublished}
          review={review}
        />,
      ),
    );
    expect(onTourPublished).toHaveBeenCalledTimes(1);
  });

  it('dispatches a contextual reviewer request exactly once', async () => {
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
    const request = {
      id: 1,
      conversationId: prReviewerConversationId(review.id, review.headSha),
      message: '/show-me untrusted finding data',
      delivery: 'pending' as const,
      error: null,
    };
    const onRequestDeliveryChange =
      vi.fn<
        (
          id: number,
          delivery: 'pending' | 'sending' | 'sent' | 'failed',
          error?: string | null,
        ) => void
      >();

    await act(async () => {
      root.render(
        <PrReviewReviewerChat
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={request}
          review={review}
        />,
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledWith(request.message);
    expect(onRequestDeliveryChange).toHaveBeenCalledWith(1, 'sending');
    expect(onRequestDeliveryChange).toHaveBeenCalledWith(1, 'sent');

    await act(async () => {
      root.render(
        <PrReviewReviewerChat
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={{ ...request, delivery: 'sent' }}
          review={review}
        />,
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <PrReviewReviewerChat
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={request}
          review={{ ...review, headSha: 'b'.repeat(40) }}
        />,
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('waits for an explicit retry after a contextual request fails', async () => {
    const sendMessage = vi.fn<UseFlueAgentResult['sendMessage']>(async () => {
      throw new Error('Request unavailable');
    });
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
    const request = {
      id: 2,
      conversationId: prReviewerConversationId(review.id, review.headSha),
      message: '/show-me failed request',
      delivery: 'pending' as const,
      error: null,
    };
    const onRequestDeliveryChange =
      vi.fn<
        (
          id: number,
          delivery: 'pending' | 'sending' | 'sent' | 'failed',
          error?: string | null,
        ) => void
      >();

    await act(async () => {
      root.render(
        <PrReviewReviewerChat
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={request}
          review={review}
        />,
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(onRequestDeliveryChange).toHaveBeenLastCalledWith(
      2,
      'failed',
      'Request unavailable',
    );

    await act(async () => {
      root.render(
        <PrReviewReviewerChat
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={{
            ...request,
            delivery: 'failed',
            error: 'Request unavailable',
          }}
          review={review}
        />,
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Reviewer request failed');
  });

  it('correlates a local request with its admitted Flue submission', async () => {
    const sendMessage = vi.fn<UseFlueAgentResult['sendMessage']>(
      async () => undefined,
    );
    const oldLocalMessage = {
      id: 'local:0',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: 'submission-old',
      parts: [{ type: 'text', state: 'done', text: 'Earlier question' }],
    } as never;
    const baseAgent = {
      messages: [oldLocalMessage],
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage,
      refresh: vi.fn<() => void>(),
    } as UseFlueAgentResult;
    useFlueAgentMock.mockReturnValue(baseAgent);
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;
    const request = {
      id: 3,
      conversationId: prReviewerConversationId(review.id, review.headSha),
      message: '/show-me correlated request',
      delivery: 'pending' as const,
      error: null,
    };
    const onSubmissionIdentified = vi.fn<(submissionId: string) => void>();
    const onSubmissionSettled =
      vi.fn<
        (
          submissionId: string,
          outcome: 'completed' | 'failed' | 'aborted',
        ) => void
      >();

    await act(async () => {
      root.render(
        <PrReviewReviewerChat
          onSubmissionIdentified={onSubmissionIdentified}
          onSubmissionSettled={onSubmissionSettled}
          request={request}
          review={review}
        />,
      );
      await Promise.resolve();
    });

    const admittedMessage = {
      id: 'local:1',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: 'submission-local-1',
      parts: [{ type: 'text', state: 'done', text: request.message }],
    } as never;
    const foreignMessage = {
      id: 'local:foreign',
      role: 'user',
      purpose: 'user',
      display: 'visible',
      submissionId: 'submission-foreign',
      parts: [{ type: 'text', state: 'done', text: 'Another window request' }],
    } as never;
    useFlueAgentMock.mockReturnValue({
      ...baseAgent,
      messages: [oldLocalMessage, foreignMessage, admittedMessage],
      status: 'streaming',
    });
    act(() =>
      root.render(
        <PrReviewReviewerChat
          onSubmissionIdentified={onSubmissionIdentified}
          onSubmissionSettled={onSubmissionSettled}
          request={{ ...request, delivery: 'sent' }}
          review={review}
        />,
      ),
    );
    expect(onSubmissionIdentified).toHaveBeenCalledWith('submission-local-1');
    expect(onSubmissionIdentified).not.toHaveBeenCalledWith(
      'submission-foreign',
    );

    useFlueAgentMock.mockReturnValue({
      ...baseAgent,
      messages: [oldLocalMessage, foreignMessage, admittedMessage],
      settlements: [
        { submissionId: 'submission-local-1', outcome: 'completed' },
      ],
    });
    act(() =>
      root.render(
        <PrReviewReviewerChat
          onSubmissionIdentified={onSubmissionIdentified}
          onSubmissionSettled={onSubmissionSettled}
          request={{ ...request, delivery: 'sent' }}
          review={review}
        />,
      ),
    );
    expect(onSubmissionSettled).toHaveBeenCalledWith(
      'submission-local-1',
      'completed',
    );
  });

  it('keeps request delivery and tour observation alive when the visible chat unmounts', async () => {
    const sendMessage = vi.fn<UseFlueAgentResult['sendMessage']>(
      async () => undefined,
    );
    const agentResult = {
      messages: [],
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage,
      refresh: vi.fn<() => void>(),
    } as UseFlueAgentResult;
    useFlueAgentMock.mockReturnValue(agentResult);
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;
    const request = {
      id: 4,
      conversationId: prReviewerConversationId(review.id, review.headSha),
      message: '/show-me stable controller request',
      delivery: 'pending' as const,
      error: null,
    };
    const onRequestDeliveryChange =
      vi.fn<
        (
          id: number,
          delivery: 'pending' | 'sending' | 'sent' | 'failed',
          error?: string | null,
        ) => void
      >();
    const onTourPublished =
      vi.fn<(tourId: string, generation: number) => void>();

    await act(async () => {
      root.render(
        <StrictMode>
          <PrReviewReviewerController
            onRequestDeliveryChange={onRequestDeliveryChange}
            onTourPublished={onTourPublished}
            request={request}
            review={review}
          />
          <PrReviewReviewerChat
            onSendMessage={() => undefined}
            request={request}
            review={review}
          />
        </StrictMode>,
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);

    useFlueAgentMock.mockReturnValue({
      ...agentResult,
      messages: [
        tourPublicationMessage(
          'assistant-live',
          'tool-call-live',
          'tour-live',
          2,
        ),
      ],
    });
    act(() =>
      root.render(
        <StrictMode>
          <PrReviewReviewerController
            onRequestDeliveryChange={onRequestDeliveryChange}
            onTourPublished={onTourPublished}
            request={{ ...request, delivery: 'sent' }}
            review={review}
          />
        </StrictMode>,
      ),
    );

    expect(onTourPublished).toHaveBeenCalledWith('tour-live', 2);
  });

  it('surfaces a controller connection failure and reconnects before retrying', async () => {
    const sendMessage = vi.fn<UseFlueAgentResult['sendMessage']>(
      async () => undefined,
    );
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;
    const request = {
      id: 5,
      conversationId: prReviewerConversationId(review.id, review.headSha),
      message: 'Recover this request',
      delivery: 'pending' as const,
      error: null,
    };
    const onRequestDeliveryChange =
      vi.fn<
        (
          id: number,
          delivery: 'pending' | 'sending' | 'sent' | 'failed',
          error?: string | null,
        ) => void
      >();
    const connectedAgent = {
      messages: [],
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage,
      refresh: vi.fn<() => void>(),
    } as UseFlueAgentResult;
    useFlueAgentMock.mockReturnValue({
      ...connectedAgent,
      error: new Error('Socket unavailable'),
    });

    act(() =>
      root.render(
        <PrReviewReviewerController
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={request}
          review={review}
        />,
      ),
    );
    expect(onRequestDeliveryChange).toHaveBeenCalledWith(
      5,
      'failed',
      'Reviewer connection unavailable: Socket unavailable',
    );
    expect(sendMessage).not.toHaveBeenCalled();

    act(() =>
      root.render(
        <PrReviewReviewerController
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={{
            ...request,
            delivery: 'failed',
            error: 'Reviewer connection unavailable: Socket unavailable',
          }}
          review={review}
        />,
      ),
    );
    useFlueAgentMock.mockReturnValue(connectedAgent);
    act(() => container.querySelector('button')?.click());
    expect(onRequestDeliveryChange).toHaveBeenCalledWith(5, 'pending', null);

    await act(async () => {
      root.render(
        <PrReviewReviewerController
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={request}
          review={review}
        />,
      );
      await Promise.resolve();
    });
    expect(sendMessage).toHaveBeenCalledWith('Recover this request');
  });

  it('reconnects the controller before retrying a failed admission', async () => {
    const failedSend = vi.fn<UseFlueAgentResult['sendMessage']>(async () => {
      throw new Error('Admission failed');
    });
    const successfulSend = vi.fn<UseFlueAgentResult['sendMessage']>(
      async () => undefined,
    );
    const review = {
      id: 'review-123',
      headSha: 'a'.repeat(40),
      status: 'ready',
    } as PrReviewRecord;
    const request = {
      id: 6,
      conversationId: prReviewerConversationId(review.id, review.headSha),
      message: 'Retry admission',
      delivery: 'pending' as const,
      error: null,
    };
    const onRequestDeliveryChange =
      vi.fn<
        (
          id: number,
          delivery: 'pending' | 'sending' | 'sent' | 'failed',
          error?: string | null,
        ) => void
      >();
    const agentResult = {
      messages: [],
      status: 'idle',
      historyReady: true,
      error: undefined,
      failedSends: [],
      settlements: [],
      sendMessage: failedSend,
      refresh: vi.fn<() => void>(),
    } as UseFlueAgentResult;
    useFlueAgentMock.mockReturnValue(agentResult);

    await act(async () => {
      root.render(
        <PrReviewReviewerController
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={request}
          review={review}
        />,
      );
      await Promise.resolve();
    });
    expect(onRequestDeliveryChange).toHaveBeenCalledWith(
      6,
      'failed',
      'Admission failed',
    );

    act(() =>
      root.render(
        <PrReviewReviewerController
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={{
            ...request,
            delivery: 'failed',
            error: 'Admission failed',
          }}
          review={review}
        />,
      ),
    );
    useFlueAgentMock.mockReturnValue({
      ...agentResult,
      sendMessage: successfulSend,
    });
    act(() => container.querySelector('button')?.click());

    await act(async () => {
      root.render(
        <PrReviewReviewerController
          onRequestDeliveryChange={onRequestDeliveryChange}
          request={request}
          review={review}
        />,
      );
      await Promise.resolve();
    });
    expect(failedSend).toHaveBeenCalledTimes(1);
    expect(successfulSend).toHaveBeenCalledWith('Retry admission');
  });
});

function tourPublicationMessage(
  id: string,
  toolCallId: string,
  tourId: string,
  generation: number,
) {
  return {
    id,
    role: 'assistant',
    purpose: 'answer',
    display: 'visible',
    parts: [
      {
        type: 'dynamic-tool',
        toolName: 'neondeck_publish_pr_tour',
        toolCallId,
        state: 'output-available',
        input: {},
        output: { ok: true, tourId, generation },
      },
    ],
  } as never;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
