import { describe, expect, it, vi } from 'vitest';
import {
  formatChatSessionCommandServerSentEvent,
  publishSessionCommandEvent,
  subscribeChatSessionCommandEvents,
  type ChatSessionCommandChangeEvent,
} from './events';
import type { ChatSessionCommandEvent } from './schemas';

describe('chat session command events', () => {
  it('publishes typed command changes and formats the dashboard SSE topic', () => {
    const listener = vi.fn<(event: ChatSessionCommandChangeEvent) => void>();
    const unsubscribe = subscribeChatSessionCommandEvents(listener);
    const event = commandEvent();

    publishSessionCommandEvent('updated', event);

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        id: event.id,
        action: 'updated',
        sessionId: event.sessionId,
        event,
      }),
    );
    const change = listener.mock.calls[0]?.[0];
    expect(formatChatSessionCommandServerSentEvent(change)).toContain(
      'event: chat-session-command-change',
    );

    unsubscribe();
    publishSessionCommandEvent('updated', event);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

function commandEvent(): ChatSessionCommandEvent {
  const timestamp = '2026-07-16T00:00:00.000Z';
  return {
    id: 'command-1',
    sessionId: 'session-1',
    input: '/briefing',
    status: 'completed',
    result: null,
    flueRunId: null,
    workflowSummaryId: null,
    createdAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}
