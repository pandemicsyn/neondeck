import { describe, expect, it } from 'vitest';
import type { ActivityEventRecord } from '../../api';
import { activitySubmissionMetrics } from './activity-metrics';

describe('activitySubmissionMetrics', () => {
  it('reports leaf model and tool timing without double-counting operation spans', () => {
    const metrics = activitySubmissionMetrics([
      event(1, 'operation', 9_000, { usage: { totalTokens: 999 } }),
      event(2, 'turn', 4_000, {
        responseModel: 'review-model',
        usage: { totalTokens: 2_400 },
      }),
      event(3, 'tool', 25, {
        category: 'review-workspace',
        operation: 'read',
        resultBytes: 1_200,
      }),
      event(4, 'tool', 35, {
        category: 'review-workspace',
        operation: 'diff',
        resultBytes: 3_000,
      }),
      event(5, 'turn', 6_000, {
        responseModel: 'review-model-v2',
        usage: { totalTokens: 4_800 },
      }),
    ]);

    expect(metrics).toEqual({
      modelTurns: 2,
      workspaceToolCalls: 2,
      modelDurationMs: 10_000,
      toolDurationMs: 60,
      latestTotalTokens: 4_800,
      responseModel: 'review-model-v2',
      resultBytes: 4_200,
      workspaceOperations: [
        { operation: 'diff', count: 1 },
        { operation: 'read', count: 1 },
      ],
    });
  });
});

function event(
  id: number,
  eventType: string,
  durationMs: number,
  summary: unknown,
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
    conversationId: 'conversation-1',
    durationMs,
    isError: false,
    summary,
    createdAt: `2026-08-05T15:00:0${id}.000Z`,
    detailUrl: '/activity?submissionId=sub_1',
  };
}
