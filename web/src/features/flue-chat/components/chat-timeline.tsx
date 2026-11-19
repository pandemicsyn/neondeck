import type { FlueConversationMessage } from '@flue/react';
import { memo, type ReactNode } from 'react';
import type { SessionTimelineItem } from '../lib/timeline';
import { ChatPartEvent, renderMessagePart } from './message-parts';
import { SessionActivityRow } from './session-activity-row';

export const ChatTimelineItems = memo(function ChatTimelineItems({
  hasSession,
  items,
  renderPart = renderMessagePart,
}: {
  hasSession: boolean;
  items: SessionTimelineItem[];
  renderPart?: (part: unknown, key: string) => ReactNode;
}) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-center text-[13px] text-muted">
        <div className="max-w-[42ch]">
          <div className="miami-accent mx-auto mb-2 h-1.5 w-12" />
          <p className="font-medium text-ink">
            {hasSession ? 'Start a conversation' : 'Opening session'}
          </p>
          <p className="mt-1 leading-5">
            {hasSession
              ? 'Ask about a PR, check an active watch, or explore your runtime.'
              : 'Your chat will be ready in a moment.'}
          </p>
        </div>
      </div>
    );
  }

  return items.map((item) => {
    if (item.kind === 'activity') {
      return <SessionActivityRow activity={item.activity} key={item.id} />;
    }

    return (
      <ChatTimelineMessage
        key={item.id}
        message={item.message}
        renderPart={renderPart}
      />
    );
  });
});

export function ChatResponseProgress({
  phase,
}: {
  phase: 'admitting' | 'submitted' | 'streaming';
}) {
  const label =
    phase === 'admitting'
      ? 'Sending to Neon…'
      : phase === 'submitted'
        ? 'Neon is working…'
        : 'Neon is responding…';

  return (
    <output
      aria-live="polite"
      aria-label={label}
      className="chat-message chat-message-assistant flex items-center gap-2 font-mono text-[10.5px] text-muted"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 bg-primary [animation:nd-pulse_1.2s_ease-in-out_infinite]"
      />
      <span>{label}</span>
    </output>
  );
}

const ChatTimelineMessage = memo(function ChatTimelineMessage({
  message,
  renderPart,
}: {
  message: FlueConversationMessage;
  renderPart: (part: unknown, key: string) => ReactNode;
}) {
  return (
    <article
      className={`chat-message chat-message-${message.role} space-y-1.5`}
    >
      <p className="font-mono text-[10px] font-semibold text-muted">
        {message.role}
      </p>
      <div className="space-y-2 text-[13px] leading-[1.55] text-ink">
        {message.parts.length > 0 ? (
          message.parts.map((part, index) =>
            renderPart(part, `${message.id}-${index}`),
          )
        ) : (
          <ChatPartEvent
            kind="event"
            name="assistant message"
            preview="No visible message parts were returned."
          />
        )}
      </div>
    </article>
  );
});
