import type { ActivityEventRecord } from '../../api';

export type ActivityScopeMetrics = {
  modelTurns: number;
  workspaceToolCalls: number;
  modelDurationMs: number;
  toolDurationMs: number;
  latestTotalTokens: number | null;
  responseModel: string | null;
  resultBytes: number;
  workspaceOperations: Array<{ operation: string; count: number }>;
};

export type ActivityDelegateMetrics = ActivityScopeMetrics & {
  agent: string;
  conversationId: string | null;
  durationMs: number;
  isError: boolean;
  startedAt: string;
  status: 'running' | 'completed' | 'failed';
  taskId: string;
};

export type ActivitySubmissionMetrics = {
  reviewer: ActivityScopeMetrics;
  delegated: ActivityScopeMetrics;
  delegates: ActivityDelegateMetrics[];
  maxConcurrentDelegates: number;
  longestDelegateDurationMs: number;
};

type DelegateRecord = {
  agent: string;
  conversationId: string | null;
  durationMs: number;
  isError: boolean;
  startedAt: string;
  status: 'running' | 'completed' | 'failed';
  taskId: string;
};

export function activitySubmissionMetrics(
  events: ActivityEventRecord[],
  observedAt?: string,
): ActivitySubmissionMetrics {
  const delegatesByTask = collectDelegates(events, observedAt);
  const delegateConversationIds = new Set(
    [...delegatesByTask.values()]
      .map((delegate) => delegate.conversationId)
      .filter((value): value is string => value !== null),
  );
  const reviewerEvents = events.filter(
    (event) =>
      event.conversationId === null ||
      !delegateConversationIds.has(event.conversationId),
  );
  const delegatedEvents = events.filter(
    (event) =>
      event.conversationId !== null &&
      delegateConversationIds.has(event.conversationId),
  );
  const delegates = [...delegatesByTask.values()]
    .sort(
      (left, right) =>
        timestamp(left.startedAt) - timestamp(right.startedAt) ||
        left.taskId.localeCompare(right.taskId),
    )
    .map((delegate) => ({
      ...delegate,
      ...scopeMetrics(
        delegate.conversationId === null
          ? []
          : events.filter(
              (event) => event.conversationId === delegate.conversationId,
            ),
      ),
    }));

  return {
    reviewer: scopeMetrics(reviewerEvents),
    delegated: scopeMetrics(delegatedEvents),
    delegates,
    maxConcurrentDelegates: maxConcurrentDelegates(delegates),
    longestDelegateDurationMs: delegates.reduce(
      (longest, delegate) => Math.max(longest, delegate.durationMs),
      0,
    ),
  };
}

function collectDelegates(events: ActivityEventRecord[], observedAt?: string) {
  const delegates = new Map<string, DelegateRecord>();
  const latestTimestamp = events.reduce(
    (latest, event) => Math.max(latest, timestamp(event.createdAt)),
    observedAt ? timestamp(observedAt) : 0,
  );

  for (const event of events) {
    if (event.eventType !== 'task_start') continue;
    const summary = record(event.summary);
    const taskId = string(summary?.taskId);
    if (!taskId) continue;
    delegates.set(taskId, {
      agent: string(summary?.agent) ?? event.name ?? 'subagent',
      conversationId: event.conversationId,
      durationMs: Math.max(0, latestTimestamp - timestamp(event.createdAt)),
      isError: false,
      startedAt: event.createdAt,
      status: 'running',
      taskId,
    });
  }

  for (const event of events) {
    if (event.eventType !== 'task') continue;
    const summary = record(event.summary);
    const taskId = string(summary?.taskId);
    if (!taskId) continue;
    const existing = delegates.get(taskId);
    const isError = event.isError;
    const terminalDurationMs = duration(event.durationMs);
    delegates.set(taskId, {
      agent:
        string(summary?.agent) ?? event.name ?? existing?.agent ?? 'subagent',
      conversationId: event.conversationId ?? existing?.conversationId ?? null,
      durationMs: terminalDurationMs,
      isError,
      startedAt:
        existing?.startedAt ??
        new Date(
          Math.max(0, timestamp(event.createdAt) - terminalDurationMs),
        ).toISOString(),
      status: isError ? 'failed' : 'completed',
      taskId,
    });
  }

  return delegates;
}

function scopeMetrics(events: ActivityEventRecord[]): ActivityScopeMetrics {
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
    // Delegated task duration is reported separately. Counting the parent task
    // tool here makes concurrent child work look like serial tool execution.
    if (event.name !== 'task') toolDurationMs += duration(event.durationMs);
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

function maxConcurrentDelegates(delegates: ActivityDelegateMetrics[]) {
  const boundaries = delegates.flatMap((delegate) => {
    const start = timestamp(delegate.startedAt);
    return [
      { at: start, delta: 1 },
      { at: start + Math.max(1, delegate.durationMs), delta: -1 },
    ];
  });
  boundaries.sort(
    (left, right) => left.at - right.at || left.delta - right.delta,
  );
  let active = 0;
  let maximum = 0;
  for (const boundary of boundaries) {
    active += boundary.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
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

function timestamp(value: string) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
