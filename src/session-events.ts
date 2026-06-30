import type { ChatSessionRecord } from './session-actions';

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

export function subscribeChatSessionEvents(listener: ChatSessionEventListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatChatSessionServerSentEvent(event: ChatSessionEvent) {
  return [
    `id: ${event.id}:${event.changedAt}`,
    'event: chat-session-change',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
