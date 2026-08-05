import type { ActivityEventRecord } from '../../api';

export type ActivitySubmissionMetrics = {
  modelTurns: number;
  workspaceToolCalls: number;
  modelDurationMs: number;
  toolDurationMs: number;
  latestTotalTokens: number | null;
  responseModel: string | null;
  resultBytes: number;
  workspaceOperations: Array<{ operation: string; count: number }>;
};

export function activitySubmissionMetrics(
  events: ActivityEventRecord[],
): ActivitySubmissionMetrics {
  let modelTurns = 0;
  let workspaceToolCalls = 0;
  let modelDurationMs = 0;
  let toolDurationMs = 0;
  let latestTotalTokens: number | null = null;
  let responseModel: string | null = null;
  let resultBytes = 0;
  const operationCounts = new Map<string, number>();

  for (const event of events) {
    const summary = record(event.summary);
    if (event.eventType === 'turn') {
      modelTurns += 1;
      modelDurationMs += duration(event.durationMs);
      const usage = record(summary?.usage);
      latestTotalTokens = number(usage?.totalTokens) ?? latestTotalTokens;
      responseModel = string(summary?.responseModel) ?? responseModel;
    }
    if (event.eventType !== 'tool') continue;
    toolDurationMs += duration(event.durationMs);
    if (summary?.category !== 'review-workspace') continue;
    workspaceToolCalls += 1;
    resultBytes += number(summary.resultBytes) ?? 0;
    const operation = string(summary.operation);
    if (operation) {
      operationCounts.set(operation, (operationCounts.get(operation) ?? 0) + 1);
    }
  }

  return {
    modelTurns,
    workspaceToolCalls,
    modelDurationMs,
    toolDurationMs,
    latestTotalTokens,
    responseModel,
    resultBytes,
    workspaceOperations: [...operationCounts]
      .map(([operation, count]) => ({ operation, count }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.operation.localeCompare(right.operation),
      ),
  };
}

function record(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function string(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function duration(value: number | null) {
  return value !== null && Number.isFinite(value) ? Math.max(0, value) : 0;
}
