import type { FlueConversationMessage } from '@flue/react';
import type { ChatSessionActivityItem } from '../../../api';

export type SessionTimelineItem =
  | {
      kind: 'message';
      id: string;
      order: number;
      timestamp: string | undefined;
      message: FlueConversationMessage;
    }
  | {
      kind: 'activity';
      id: string;
      order: number;
      timestamp: string;
      activity: ChatSessionActivityItem;
    };

export function sessionActivityForLinkedWatch(
  linkedWatchId: string | null | undefined,
  activity: ChatSessionActivityItem[] | undefined,
) {
  return linkedWatchId ? (activity ?? []) : [];
}

export function sessionTimelineItems(
  messages: FlueConversationMessage[],
  activity: ChatSessionActivityItem[],
): SessionTimelineItem[] {
  return [
    ...messages.map((message, index): SessionTimelineItem => ({
      kind: 'message',
      id: `message:${message.id}`,
      order: index,
      timestamp: message.metadata?.timestamp,
      message,
    })),
    ...activity.map((item, index): SessionTimelineItem => ({
      kind: 'activity',
      id: `activity:${item.id}`,
      order: messages.length + index,
      timestamp: item.updatedAt,
      activity: item,
    })),
  ].sort(compareTimelineItems);
}

function compareTimelineItems(
  left: SessionTimelineItem,
  right: SessionTimelineItem,
) {
  const leftTime = timestamp(left.timestamp);
  const rightTime = timestamp(right.timestamp);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftTime === null && rightTime !== null) return 1;
  if (leftTime !== null && rightTime === null) return -1;
  return left.order - right.order;
}

function timestamp(value: string | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
