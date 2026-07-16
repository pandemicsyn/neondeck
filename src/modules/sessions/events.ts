import type { ChatSessionRecord } from './schemas';

export type ChatSessionEventAction =
  'created' | 'updated' | 'switched' | 'archived' | 'restored';

export type ChatSessionEvent = {
  id: string;
  action: ChatSessionEventAction;
  session: ChatSessionRecord;
  surface: string | null;
  changedAt: string;
};

type ChatSessionEventListener = (event: ChatSessionEvent) => void;

const listeners = new Set<ChatSessionEventListener>();

export function publishChatSessionEvent(event: ChatSessionEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      listeners.delete(listener);
      console.error('[neondeck] chat session event listener failed', error);
    }
  }
}

export function publishSessionEvent(
  action: ChatSessionEventAction,
  session: ChatSessionRecord,
  surface: string | null,
) {
  publishChatSessionEvent({
    id: session.id,
    action,
    session,
    surface,
    changedAt: new Date().toISOString(),
  });
}

export function subscribeChatSessionEvents(listener: ChatSessionEventListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatChatSessionServerSentEvent(event: ChatSessionEvent) {
  return [
    'event: chat-session-change',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
