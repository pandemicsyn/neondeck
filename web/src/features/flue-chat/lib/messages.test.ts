import type { FlueConversationMessage } from '@flue/react';
import { describe, expect, it } from 'vitest';
import { chatMessagesForRender } from './messages';

describe('chatMessagesForRender', () => {
  it('returns the Flue-owned transcript unchanged when no internal prompt exists', () => {
    const messages: FlueConversationMessage[] = [
      {
        id: 'live',
        role: 'assistant',
        parts: [{ type: 'text', state: 'streaming', text: 'live' }],
      },
    ];
    expect(chatMessagesForRender(messages)).toBe(messages);
  });

  it('keeps deterministic briefing grounding in Flue while rendering a compact turn', () => {
    const messages: FlueConversationMessage[] = [
      {
        id: 'briefing-input',
        role: 'user',
        parts: [
          {
            type: 'text',
            state: 'done',
            text: JSON.stringify(
              '[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=manual run=briefing:1]\n\nNeondeck fact snapshot:\n{...}',
            ),
          },
        ],
      },
      {
        id: 'assistant-output',
        role: 'assistant',
        parts: [{ type: 'text', state: 'done', text: 'Today needs review.' }],
      },
    ];

    expect(chatMessagesForRender(messages)).toEqual([
      expect.objectContaining({
        id: 'briefing-input',
        parts: [{ type: 'text', state: 'done', text: '/briefing' }],
      }),
      messages[1],
    ]);
  });

  it('labels background occurrences without exposing their internal prompt', () => {
    const messages: FlueConversationMessage[] = [
      {
        id: 'scheduled-input',
        role: 'user',
        parts: [
          {
            type: 'text',
            state: 'done',
            text: '[NEONDECK_INTERNAL_BRIEFING_INPUT v1 trigger=scheduled run=briefing:2]\n\nprivate grounding',
          },
        ],
      },
    ];

    expect(chatMessagesForRender(messages)[0]).toMatchObject({
      parts: [
        { type: 'text', state: 'done', text: 'Scheduled morning briefing' },
      ],
    });
  });
});
