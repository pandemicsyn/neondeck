import type { FlueConversationMessage } from '@flue/react';
import { describe, expect, it } from 'vitest';
import { chatMessagesForRender } from './messages';

describe('chatMessagesForRender', () => {
  it('returns the Flue-owned transcript unchanged when no internal prompt exists', () => {
    const messages: FlueConversationMessage[] = [
      {
        id: 'live',
        role: 'assistant',
        purpose: 'assistant',
        display: 'visible',
        parts: [{ type: 'text', state: 'streaming', text: 'live' }],
      },
    ];
    expect(chatMessagesForRender(messages)).toBe(messages);
  });

  it('hides typed dispatch/control messages while preserving visible replies', () => {
    const messages: FlueConversationMessage[] = [
      {
        id: 'briefing-input',
        role: 'system',
        purpose: 'dispatch',
        display: 'hidden',
        signal: { attributes: { briefingRunId: 'briefing:1' } },
        parts: [
          {
            type: 'text',
            state: 'done',
            text: 'Briefing briefing:1 is ready.',
          },
        ],
      },
      {
        id: 'assistant-output',
        role: 'assistant',
        purpose: 'assistant',
        display: 'visible',
        parts: [{ type: 'text', state: 'done', text: 'Today needs review.' }],
      },
    ];

    expect(chatMessagesForRender(messages)).toEqual([messages[1]]);
  });

  it('does not expose diagnostic runtime advisories in the chat lane', () => {
    const messages: FlueConversationMessage[] = [
      {
        id: 'scheduled-input',
        role: 'system',
        purpose: 'advisory',
        display: 'diagnostic',
        parts: [
          {
            type: 'text',
            state: 'done',
            text: 'Runtime diagnostic detail.',
          },
        ],
      },
    ];

    expect(chatMessagesForRender(messages)).toEqual([]);
  });
});
