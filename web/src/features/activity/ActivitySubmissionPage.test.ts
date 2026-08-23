import { describe, expect, it } from 'vitest';
import type { ActivityEventRecord } from '../../api';
import { activityEventDetails } from './ActivitySubmissionPage';

describe('activity event details', () => {
  it('presents delegated prompts separately from task metadata', () => {
    expect(
      activityEventDetails(
        event({
          eventType: 'task_start',
          summary: {
            taskId: 'task-1',
            prompt: 'Question: inspect the retry path',
            promptLength: 32,
            promptTruncated: false,
          },
        }),
      ),
    ).toEqual({
      content: {
        label: 'delegated prompt',
        value: 'Question: inspect the retry path',
        truncated: false,
      },
      metadata: {
        taskId: 'task-1',
        promptLength: 32,
        promptTruncated: false,
      },
    });
  });

  it('presents completed task output separately from task metadata', () => {
    expect(
      activityEventDetails(
        event({
          eventType: 'task',
          summary: {
            taskId: 'task-1',
            result: 'Answer: the retry is bounded',
            resultTruncated: true,
          },
        }),
      ).content,
    ).toEqual({
      label: 'task output',
      value: 'Answer: the retry is bounded',
      truncated: true,
    });
  });
});

function event(
  overrides: Partial<ActivityEventRecord> = {},
): ActivityEventRecord {
  return {
    id: 1,
    submissionId: 'submission-1',
    eventType: 'log',
    eventIndex: 1,
    level: null,
    message: 'event message',
    name: null,
    operationKind: null,
    operationId: null,
    agentName: 'pr-review-assistant',
    instanceId: 'review-1',
    conversationId: 'conversation-1',
    durationMs: null,
    isError: false,
    summary: null,
    createdAt: '2026-08-22T17:00:00.000Z',
    detailUrl: '/activity?submissionId=submission-1',
    ...overrides,
  };
}
