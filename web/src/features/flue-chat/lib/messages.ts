import type { FlueConversationMessage } from '@flue/react';

const briefingInputMarker = '[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=';

export function chatMessagesForRender(messages: FlueConversationMessage[]) {
  return messages.some(isInternalBriefingInput)
    ? messages.map(compactInternalBriefingInput)
    : messages;
}

function isInternalBriefingInput(message: FlueConversationMessage) {
  if (message.role !== 'user') return false;
  return message.parts.some(
    (part) =>
      part.type === 'text' &&
      decodedDispatchText(part.text).startsWith(briefingInputMarker),
  );
}

function compactInternalBriefingInput(message: FlueConversationMessage) {
  if (message.role !== 'user') return message;
  const rawText = message.parts.find((part) => part.type === 'text')?.text;
  const text = rawText ? decodedDispatchText(rawText) : undefined;
  if (!text?.startsWith(briefingInputMarker)) return message;
  const scheduled = text.startsWith(`${briefingInputMarker}scheduled`);
  return {
    ...message,
    parts: [
      {
        type: 'text' as const,
        text: scheduled ? 'Scheduled morning briefing' : '/briefing',
        state: 'done' as const,
      },
    ],
  };
}

function decodedDispatchText(text: string) {
  if (!text.startsWith('"')) return text;
  try {
    const decoded = JSON.parse(text) as unknown;
    return typeof decoded === 'string' ? decoded : text;
  } catch {
    return text;
  }
}
