import type { FlueConversationMessage } from '@flue/react';

export function chatMessagesForRender(messages: FlueConversationMessage[]) {
  const visible = messages.filter((message) => message.display === 'visible');
  return visible.length === messages.length ? messages : visible;
}
