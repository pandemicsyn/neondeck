import { useFlueAgent } from '@flue/react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import * as v from 'valibot';
import {
  isPrReviewerDraftToolName,
  prReviewerConversationId,
} from '../../../../shared/pr-reviewer-session';
import type { PrReviewRecord } from '../../api';
import { ChatTimelineItems } from '../flue-chat/components/chat-timeline';
import { chatMessagesForRender } from '../flue-chat/lib/messages';
import { sessionTimelineItems } from '../flue-chat/lib/timeline';
import { useChatAutoScroll } from '../flue-chat/lib/use-chat-auto-scroll';
import { createNeondeckConversationClient } from '../../lib/flue';

export function PrReviewReviewerChat({
  isLocked = false,
  onDraftChanged,
  review,
}: {
  isLocked?: boolean;
  onDraftChanged?: () => void;
  review: PrReviewRecord | null;
}) {
  const [connectionAttempt, setConnectionAttempt] = useState(0);

  if (!review) {
    return (
      <ReviewerUnavailable copy="Run Neon on this PR to open a reviewer conversation." />
    );
  }
  if (review.status === 'reviewing') {
    return (
      <ReviewerUnavailable copy="Neon is reviewing the current PR revision. The reviewer conversation will reconnect when it finishes." />
    );
  }
  if (review.status === 'failed') {
    return (
      <ReviewerUnavailable copy="The Neon review run failed. Retry it before asking follow-up questions." />
    );
  }

  const agentId = prReviewerConversationId(review.id, review.headSha);
  return (
    <ReviewerConversation
      agentId={agentId}
      isLocked={isLocked}
      key={`${agentId}:${connectionAttempt}`}
      onDraftChanged={onDraftChanged}
      onReconnect={() => setConnectionAttempt((attempt) => attempt + 1)}
    />
  );
}

function ReviewerConversation({
  agentId,
  isLocked,
  onDraftChanged,
  onReconnect,
}: {
  agentId: string;
  isLocked: boolean;
  onDraftChanged?: () => void;
  onReconnect: () => void;
}) {
  const conversationClient = useMemo(
    () => createNeondeckConversationClient('pr-reviewer', agentId),
    [agentId],
  );
  const agent = useFlueAgent({ client: conversationClient });
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const observedDraftToolCalls = useRef(new Set<string>());
  const messages = useMemo(
    () => chatMessagesForRender(agent.messages),
    [agent.messages],
  );
  const items = useMemo(() => sessionTimelineItems(messages, []), [messages]);
  const autoScroll = useChatAutoScroll(agentId);
  const connectionError = agent.error?.message ?? null;
  const busy =
    sending ||
    agent.status === 'connecting' ||
    agent.status === 'submitted' ||
    agent.status === 'streaming';
  const ready = agent.historyReady && !connectionError && !busy && !isLocked;

  useEffect(() => {
    let changed = false;
    for (const message of agent.messages) {
      for (const part of message.parts) {
        if (
          part.type !== 'dynamic-tool' ||
          part.state !== 'output-available' ||
          !isPrReviewerDraftToolName(part.toolName) ||
          observedDraftToolCalls.current.has(part.toolCallId)
        ) {
          continue;
        }
        observedDraftToolCalls.current.add(part.toolCallId);
        if (draftMutationSucceeded(part.output)) changed = true;
      }
    }
    if (changed) onDraftChanged?.();
  }, [agent.messages, onDraftChanged]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || !ready) return;
    setSendError(null);
    setSending(true);
    try {
      await agent.sendMessage(message);
      setInput('');
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return (
    <section className="pr-reviewer-chat" aria-label="Reviewer conversation">
      <div
        className="pr-reviewer-chat-timeline"
        onScroll={autoScroll.handleScroll}
        ref={autoScroll.transcriptRef}
      >
        {connectionError ? (
          <div className="pr-reviewer-chat-error" role="alert">
            <p>Reviewer connection failed</p>
            <span>{connectionError}</span>
          </div>
        ) : null}
        {items.length > 0 ? (
          <ChatTimelineItems hasSession items={items} />
        ) : connectionError ? null : (
          <div className="pr-reviewer-chat-empty">
            <p>Ask the reviewer</p>
            <span>
              Challenge a finding, request evidence, or ask about a specific
              path and line.
            </span>
          </div>
        )}
      </div>
      {autoScroll.hasNewActivity ? (
        <button
          className="pr-reviewer-chat-latest"
          onClick={autoScroll.jumpToLatest}
          type="button"
        >
          New response · jump to latest
        </button>
      ) : null}
      <form className="pr-reviewer-chat-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="pr-reviewer-chat-input">
          Ask the reviewer a question
        </label>
        <textarea
          aria-describedby="pr-reviewer-chat-shortcut"
          disabled={!ready}
          id="pr-reviewer-chat-input"
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isLocked
              ? 'Wait for the PR revision update to finish.'
              : connectionError
                ? 'Reviewer connection unavailable.'
                : agent.historyReady
                  ? busy
                    ? 'Reviewer is working…'
                    : 'Ask why this is an issue…'
                  : 'Loading reviewer history…'
          }
          rows={3}
          value={input}
        />
        <div className="pr-reviewer-chat-actions">
          <span aria-live="polite" id="pr-reviewer-chat-shortcut">
            {agent.status === 'streaming'
              ? 'Reviewer is responding…'
              : sendError || 'Enter send · Shift+Enter newline'}
          </span>
          {connectionError ? (
            <button disabled={isLocked} onClick={onReconnect} type="button">
              Reconnect
            </button>
          ) : (
            <button
              disabled={!ready || input.trim().length === 0}
              type="submit"
            >
              {sending ? 'Sending' : 'Ask'}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function draftMutationSucceeded(cause: unknown) {
  const parsed = v.safeParse(v.looseObject({ ok: v.boolean() }), cause);
  return parsed.success && parsed.output.ok;
}

function ReviewerUnavailable({ copy }: { copy: string }) {
  return <p className="pr-reviewer-chat-unavailable">{copy}</p>;
}
