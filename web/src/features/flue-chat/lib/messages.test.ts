import type { FlueConversationMessage } from '@flue/react';
import { describe, expect, it } from 'vitest';
import { chatMessagesForRender } from './messages';

describe('chatMessagesForRender', () => {
  const live: FlueConversationMessage[] = [
    {
      id: 'live',
      role: 'assistant',
      parts: [{ type: 'text', state: 'streaming', text: 'live' }],
    },
  ];
  const canonical: FlueConversationMessage[] = [
    {
      id: 'canonical',
      role: 'assistant',
      parts: [{ type: 'text', state: 'done', text: 'canonical' }],
    },
  ];

  it('keeps live streaming messages while a turn is active', () => {
    expect(chatMessagesForRender(live, canonical, 'streaming')).toBe(live);
    expect(chatMessagesForRender(live, canonical, 'submitted')).toBe(live);
  });

  it('uses canonical history after the turn settles idle', () => {
    expect(chatMessagesForRender(live, canonical, 'idle')).toBe(canonical);
  });

  it('falls back to live messages when canonical history is unavailable', () => {
    expect(chatMessagesForRender(live, undefined, 'idle')).toBe(live);
  });

  it('does not hide newer live history behind a stale canonical snapshot', () => {
    const newerLive = [
      ...canonical,
      {
        id: 'new-assistant',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, state: 'done' as const, text: 'new' }],
      },
    ];
    expect(chatMessagesForRender(newerLive, canonical, 'idle')).toBe(newerLive);
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

    expect(chatMessagesForRender(messages, messages, 'idle')).toEqual([
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

    expect(
      chatMessagesForRender(messages, undefined, 'streaming')[0],
    ).toMatchObject({
      parts: [
        { type: 'text', state: 'done', text: 'Scheduled morning briefing' },
      ],
    });
  });
});
