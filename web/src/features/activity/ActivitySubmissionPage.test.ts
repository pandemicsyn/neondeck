import { describe, expect, it } from 'vitest';
import type {
  ActivityEventRecord,
  ActivitySubmissionResponse,
} from '../../api';
import {
  activityEventDetails,
  latestActivityEventId,
  mergeActivitySubmissionResponse,
} from './ActivitySubmissionPage';

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
      contentStatus: null,
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

  it('explains legacy events whose task content was not retained', () => {
    expect(
      activityEventDetails(
        event({
          eventType: 'task_start',
          summary: { taskId: 'task-1', promptHash: 'sha256:legacy' },
        }),
      ).contentStatus,
    ).toBe('Task prompt was not retained for this event.');
  });

  it('explains content omitted by the retention limit', () => {
    expect(
      activityEventDetails(
        event({
          eventType: 'task',
          summary: {
            taskId: 'task-1',
            resultOmittedReason: 'retention_limit',
          },
        }),
      ).contentStatus,
    ).toBe(
      'Task output was omitted after the activity content retention limit was reached.',
    );
  });
});

describe('activity submission polling', () => {
  it('uses the greatest retained id as the incremental cursor', () => {
    expect(latestActivityEventId([event({ id: 9 }), event({ id: 4 })])).toBe(9);
    expect(latestActivityEventId([])).toBeUndefined();
  });

  it('merges incremental events without duplicating retained history', () => {
    const previous = response([event({ id: 1 }), event({ id: 2 })]);
    const incoming = response([event({ id: 2 }), event({ id: 3 })], {
      fetchedAt: '2026-08-22T17:01:00.000Z',
      totalEventCount: 3,
      retainedEventCount: 3,
    });

    expect(
      mergeActivitySubmissionResponse(previous, incoming).events.map(
        (item) => item.id,
      ),
    ).toEqual([1, 2, 3]);
  });

  it('drops cached events that are no longer retained by the server', () => {
    const previous = response([
      event({ id: 1 }),
      event({ id: 2 }),
      event({ id: 3 }),
    ]);
    const incoming = response([], {
      totalEventCount: 4,
      retainedEventCount: 2,
    });

    expect(
      mergeActivitySubmissionResponse(previous, incoming).events.map(
        (item) => item.id,
      ),
    ).toEqual([2, 3]);
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

function response(
  events: ActivityEventRecord[],
  overrides: {
    fetchedAt?: string;
    totalEventCount?: number;
    retainedEventCount?: number;
  } = {},
): ActivitySubmissionResponse {
  return {
    ok: true,
    action: 'activity_submission_read',
    submission: {
      submissionId: 'submission-1',
      kind: 'dispatch',
      agentName: 'pr-review-assistant',
      instanceId: 'review-1',
      status: 'running',
      queuedAt: '2026-08-22T17:00:00.000Z',
      startedAt: '2026-08-22T17:00:00.000Z',
      settledAt: null,
      lastEventAt: '2026-08-22T17:00:00.000Z',
      lastMessage: 'running',
      eventCount: overrides.totalEventCount ?? events.length,
      attemptCount: 1,
      isError: false,
      detailUrl: '/activity?submissionId=submission-1',
    },
    events,
    eventHistory: {
      totalEventCount: overrides.totalEventCount ?? events.length,
      retainedEventCount: overrides.retainedEventCount ?? events.length,
      isTruncated: false,
    },
    fetchedAt: overrides.fetchedAt ?? '2026-08-22T17:00:00.000Z',
  };
}
