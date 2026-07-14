import type { FlueConversationMessage } from '@flue/react';
import { describe, expect, it } from 'vitest';
import type { ChatSessionActivityItem } from '../../../api';
import {
  sessionActivityForLinkedWatch,
  sessionTimelineItems,
} from './timeline';

describe('session timeline', () => {
  it('interleaves durable activity with Flue messages by timestamp', () => {
    const messages: FlueConversationMessage[] = [
      message('question', '2026-07-13T20:00:00.000Z'),
      message('answer', '2026-07-13T20:02:00.000Z'),
    ];
    const activity = [
      notification('review', '2026-07-13T20:01:00.000Z'),
      notification('checks', '2026-07-13T20:03:00.000Z'),
    ];

    expect(
      sessionTimelineItems(messages, activity).map((item) => item.id),
    ).toEqual([
      'message:question',
      'activity:review',
      'message:answer',
      'activity:checks',
    ]);
  });

  it('keeps untimestamped optimistic messages after durable history', () => {
    expect(
      sessionTimelineItems(
        [message('optimistic')],
        [notification('checks', '2026-07-13T20:03:00.000Z')],
      ).map((item) => item.id),
    ).toEqual(['activity:checks', 'message:optimistic']);
  });

  it('hides cached activity after the session is unlinked from its watch', () => {
    const cached = [notification('checks', '2026-07-13T20:03:00.000Z')];

    expect(sessionActivityForLinkedWatch('watch-1', cached)).toEqual(cached);
    expect(sessionActivityForLinkedWatch(null, cached)).toEqual([]);
  });
});

function message(id: string, timestamp?: string): FlueConversationMessage {
  return {
    id,
    role: 'assistant',
    parts: [{ type: 'text', state: 'done', text: id }],
    metadata: timestamp ? { timestamp } : undefined,
  };
}

function notification(id: string, updatedAt: string): ChatSessionActivityItem {
  return {
    id,
    kind: 'notification',
    level: 'info',
    title: id,
    message: id,
    source: 'watch-pr-events',
    sourceId: id,
    data: {},
    readAt: null,
    resolvedAt: null,
    occurrenceCount: 1,
    createdAt: updatedAt,
    updatedAt,
  };
}
