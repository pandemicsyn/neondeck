import { useFlueAgent } from '@flue/react';
import { useMemo, useState, type FormEvent } from 'react';
import { prReviewerConversationId } from '../../../../shared/pr-reviewer-session';
import type { PrReviewRecord } from '../../api';
import { ChatTimelineItems } from '../flue-chat/components/chat-timeline';
import { chatMessagesForRender } from '../flue-chat/lib/messages';
import { sessionTimelineItems } from '../flue-chat/lib/timeline';
import { useChatAutoScroll } from '../flue-chat/lib/use-chat-auto-scroll';

export function PrReviewReviewerChat({
  review,
}: {
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
      <ReviewerUnavailable copy="The reviewer conversation will be available when the initial review finishes." />
    );
  }
  if (review.status === 'failed') {
    return (
      <ReviewerUnavailable copy="The initial review failed. Retry it before asking the reviewer follow-up questions." />
    );
  }

  const agentId = prReviewerConversationId(review.id, review.headSha);
  return (
    <ReviewerConversation
      agentId={agentId}
      key={`${agentId}:${connectionAttempt}`}
      onReconnect={() => setConnectionAttempt((attempt) => attempt + 1)}
    />
  );
}

function ReviewerConversation({
  agentId,
  onReconnect,
}: {
  agentId: string;
  onReconnect: () => void;
}) {
  const agent = useFlueAgent({ name: 'pr-reviewer', id: agentId });
  const [input, setInput] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
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
  const ready = agent.historyReady && !connectionError && !busy;

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
          disabled={!ready}
          id="pr-reviewer-chat-input"
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder={
            connectionError
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
          <span aria-live="polite">
            {agent.status === 'streaming'
              ? 'Reviewer is responding…'
              : sendError}
          </span>
          {connectionError ? (
            <button onClick={onReconnect} type="button">
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

function ReviewerUnavailable({ copy }: { copy: string }) {
  return <p className="pr-reviewer-chat-unavailable">{copy}</p>;
}
