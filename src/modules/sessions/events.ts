import type { ChatSessionCommandEvent, ChatSessionRecord } from './schemas';

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

export type ChatSessionCommandEventAction = 'created' | 'updated';

export type ChatSessionCommandChangeEvent = {
  id: string;
  action: ChatSessionCommandEventAction;
  sessionId: string;
  event: ChatSessionCommandEvent;
  changedAt: string;
};

type ChatSessionCommandEventListener = (
  event: ChatSessionCommandChangeEvent,
) => void;

const listeners = new Set<ChatSessionEventListener>();
const commandEventListeners = new Set<ChatSessionCommandEventListener>();

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

export function publishSessionCommandEvent(
  action: ChatSessionCommandEventAction,
  event: ChatSessionCommandEvent,
) {
  const change: ChatSessionCommandChangeEvent = {
    id: event.id,
    action,
    sessionId: event.sessionId,
    event,
    changedAt: new Date().toISOString(),
  };
  for (const listener of commandEventListeners) {
    try {
      listener(change);
    } catch (error) {
      commandEventListeners.delete(listener);
      console.error(
        '[neondeck] chat session command event listener failed',
        error,
      );
    }
  }
}

export function subscribeChatSessionCommandEvents(
  listener: ChatSessionCommandEventListener,
) {
  commandEventListeners.add(listener);
  return () => {
    commandEventListeners.delete(listener);
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

export function formatChatSessionCommandServerSentEvent(
  event: ChatSessionCommandChangeEvent,
) {
  return [
    'event: chat-session-command-change',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
