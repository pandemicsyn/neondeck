import { describe, expect, it } from 'vitest';
import type { ActivityEventRecord } from '../../api';
import { activitySubmissionMetrics } from './activity-metrics';

describe('activitySubmissionMetrics', () => {
  it('separates reviewer work from concurrent delegated Explore work', () => {
    const metrics = activitySubmissionMetrics([
      event(1, 'operation', 9_000, { usage: { totalTokens: 999 } }),
      event(2, 'turn', 4_000, {
        responseModel: 'review-model',
        usage: { totalTokens: 2_400 },
      }),
      event(
        3,
        'tool',
        25,
        {
          category: 'review-workspace',
          operation: 'read',
          resultBytes: 1_200,
        },
        { name: 'neondeck_review_workspace_read' },
      ),
      event(
        4,
        'task_start',
        null,
        { agent: 'explore', taskId: 'task-a' },
        {
          conversationId: 'delegate-a',
          createdAt: '2026-08-05T15:00:04.000Z',
          name: 'explore',
        },
      ),
      event(
        5,
        'task_start',
        null,
        { agent: 'explore', taskId: 'task-b' },
        {
          conversationId: 'delegate-b',
          createdAt: '2026-08-05T15:00:04.001Z',
          name: 'explore',
        },
      ),
      event(
        6,
        'turn',
        6_000,
        {
          responseModel: 'explore-model',
          usage: { totalTokens: 4_800 },
        },
        { conversationId: 'delegate-a' },
      ),
      event(
        7,
        'tool',
        35,
        {
          category: 'review-workspace',
          operation: 'search',
          resultBytes: 3_000,
        },
        {
          conversationId: 'delegate-a',
          name: 'neondeck_review_workspace_search',
        },
      ),
      event(
        8,
        'turn',
        7_000,
        {
          responseModel: 'explore-model',
          usage: { totalTokens: 6_200 },
        },
        { conversationId: 'delegate-b' },
      ),
      event(
        9,
        'task',
        55_000,
        { agent: 'explore', taskId: 'task-a' },
        { conversationId: 'delegate-a', name: 'explore' },
      ),
      event(
        10,
        'task',
        87_000,
        { agent: 'explore', taskId: 'task-b' },
        { conversationId: 'delegate-b', name: 'explore' },
      ),
      event(11, 'tool', 55_000, { toolName: 'task' }, { name: 'task' }),
      event(12, 'tool', 87_000, { toolName: 'task' }, { name: 'task' }),
    ]);

    expect(metrics.reviewer).toEqual({
      modelTurns: 1,
      workspaceToolCalls: 1,
      modelDurationMs: 4_000,
      toolDurationMs: 25,
      latestTotalTokens: 2_400,
      responseModel: 'review-model',
      resultBytes: 1_200,
      workspaceOperations: [{ operation: 'read', count: 1 }],
    });
    expect(metrics.delegated).toEqual({
      modelTurns: 2,
      workspaceToolCalls: 1,
      modelDurationMs: 13_000,
      toolDurationMs: 35,
      latestTotalTokens: 6_200,
      responseModel: 'explore-model',
      resultBytes: 3_000,
      workspaceOperations: [{ operation: 'search', count: 1 }],
    });
    expect(metrics.delegates).toMatchObject([
      {
        agent: 'explore',
        durationMs: 55_000,
        modelTurns: 1,
        status: 'completed',
        taskId: 'task-a',
        workspaceToolCalls: 1,
      },
      {
        agent: 'explore',
        durationMs: 87_000,
        modelTurns: 1,
        status: 'completed',
        taskId: 'task-b',
        workspaceToolCalls: 0,
      },
    ]);
    expect(metrics.maxConcurrentDelegates).toBe(2);
    expect(metrics.longestDelegateDurationMs).toBe(87_000);
  });

  it('reports an active delegate using the latest retained event time', () => {
    const metrics = activitySubmissionMetrics(
      [
        event(
          1,
          'task_start',
          null,
          { agent: 'explore', taskId: 'task-a' },
          {
            conversationId: 'delegate-a',
            createdAt: '2026-08-05T15:00:00.000Z',
            name: 'explore',
          },
        ),
        event(
          2,
          'turn_start',
          null,
          {},
          {
            conversationId: 'delegate-a',
            createdAt: '2026-08-05T15:00:12.000Z',
          },
        ),
      ],
      '2026-08-05T15:00:20.000Z',
    );

    expect(metrics.delegates[0]).toMatchObject({
      durationMs: 20_000,
      status: 'running',
    });
    expect(metrics.maxConcurrentDelegates).toBe(1);
  });

  it('reconstructs delegate timing when the retained history starts at completion', () => {
    const metrics = activitySubmissionMetrics([
      event(
        1,
        'task',
        30_000,
        { agent: 'explore', taskId: 'task-a' },
        {
          conversationId: 'delegate-a',
          createdAt: '2026-08-05T15:01:00.000Z',
          name: 'explore',
        },
      ),
    ]);

    expect(metrics.delegates[0]).toMatchObject({
      durationMs: 30_000,
      startedAt: '2026-08-05T15:00:30.000Z',
      status: 'completed',
    });
    expect(metrics.maxConcurrentDelegates).toBe(1);
  });
});

function event(
  id: number,
  eventType: string,
  durationMs: number | null,
  summary: unknown,
  overrides: Partial<ActivityEventRecord> = {},
): ActivityEventRecord {
  return {
    id,
    submissionId: 'sub_1',
    eventType,
    eventIndex: id,
    level: null,
    message: eventType,
    name: null,
    operationKind: null,
    operationId: null,
    agentName: 'pr-review-assistant',
    instanceId: 'review-1',
    conversationId: 'review-conversation',
    durationMs,
    isError: false,
    summary,
    createdAt: `2026-08-05T15:00:${String(id).padStart(2, '0')}.000Z`,
    detailUrl: '/activity?submissionId=sub_1',
    ...overrides,
  };
}
