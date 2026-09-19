import type { JsonValue } from '@flue/runtime';
import type { ActivityEventRecord } from './activity-types';

type ActivityUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  cost: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    total: number | null;
  } | null;
  complete: boolean;
};

type ActivityUsageAccumulator = { turns: number; usage: ActivityUsage };

type ReviewTaskPerformance = {
  taskId: string;
  wave: number;
  thoroughness: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  outcome: 'completed' | 'failed' | 'unknown';
  resultContract: boolean | null;
  stopReason: 'answered' | 'insufficient evidence' | 'blocked' | null;
};

export type PrReviewPerformanceProjection = {
  ok: true;
  action: 'pr_review_performance_read';
  review: {
    reviewId: string;
    attemptId: string;
    submissionId: string | null;
    headSha: string;
    baseSha: string | null;
    mergeBase: string | null;
    status: string;
  };
  correlation: {
    taskCorrelationAvailable: boolean;
    waveCorrelationAvailable: boolean;
    retainedObservationComplete: boolean;
    observedSubmissionQueued: boolean;
    metricsCoverage: 'anchored-best-effort' | 'partial';
    retainedEventCount: number;
    observedEventCount: number | null;
    limitations: string[];
  };
  models: {
    parent: { models: string[]; thinkingLevels: string[] } | null;
    explore: { models: string[]; thinkingLevels: string[] } | null;
  };
  timings: {
    admittedToFirstParentTurnMs: number | null;
    firstParentTurnToFirstTaskWaveMs: number | null;
    finalTaskToReviewSubmitMs: number | null;
    admittedToSettlementMs: number | null;
  };
  taskWaves: Array<{
    wave: number;
    taskCount: number;
    taskIds: string[];
    startedAt: string | null;
    endedAt: string | null;
    criticalPathMs: number | null;
    summedTaskDurationMs: number;
    concurrencyEfficiency: number | null;
  }> | null;
  tasks: ReviewTaskPerformance[] | null;
  turns: { parent: number | null; child: number | null };
  workspaceTools: {
    parent: Record<string, { calls: number; durationMs: number }> | null;
    child: Record<string, { calls: number; durationMs: number }> | null;
  };
  usage: { parent: ActivityUsage | null; child: ActivityUsage | null };
  taskBriefs: { allRequiredFieldsPresent: boolean | null };
  repetition: {
    promptHashesWithinAttempt: string[] | null;
    promptHashesAcrossExactRevision: string[] | null;
    repeatedWorkspaceQueries: number | null;
    retainedOutputReuses: number | null;
    parentReplaySignals: number | null;
  };
};

const taskBriefSchemaVersion = 1;
const reviewWorkspaceToolPrefix = 'neondeck_review_workspace_';

export function projectPrReviewPerformance(input: {
  review: {
    reviewId: string;
    attemptId: string;
    submissionId: string | null;
    headSha: string;
    baseSha: string | null;
    status: string;
    readyAt: string | null;
    failedAt: string | null;
  };
  submission: {
    eventCount: number;
    queuedAt: string;
    settledAt: string | null;
  } | null;
  events: ActivityEventRecord[];
}): PrReviewPerformanceProjection {
  const { events } = input;
  const taskStarts = new Map<string, ActivityEventRecord>();
  const tasks = new Map<string, ReviewTaskPerformance>();
  const taskWaveKeys = new Map<string, number>();
  const parentModels = new Set<string>();
  const childModels = new Set<string>();
  const parentThinking = new Set<string>();
  const childThinking = new Set<string>();
  const parentTools: Record<string, { calls: number; durationMs: number }> = {};
  const childTools: Record<string, { calls: number; durationMs: number }> = {};
  const parentUsage = emptyUsage();
  const childUsage = emptyUsage();
  const taskPromptHashes: string[] = [];
  const workspaceStarts: Array<{
    event: ActivityEventRecord;
    taskId: string | null;
    inputHash: string | null;
  }> = [];
  let parentTurns = 0;
  let childTurns = 0;

  for (const event of events) {
    const taskId = summaryString(event.summary, 'taskId');
    const isChild = taskId !== null;
    if (event.eventType === 'task_start') {
      const id = summaryString(event.summary, 'taskId');
      if (!id) continue;
      taskStarts.set(id, event);
      const promptHash = summaryString(event.summary, 'promptHash');
      if (promptHash) taskPromptHashes.push(promptHash);
      const waveKey = summaryString(event.summary, 'turnId');
      if (waveKey && !taskWaveKeys.has(waveKey))
        taskWaveKeys.set(waveKey, taskWaveKeys.size + 1);
      tasks.set(id, {
        taskId: id,
        wave: waveKey ? (taskWaveKeys.get(waveKey) ?? 0) : 0,
        thoroughness: summaryString(event.summary, 'thoroughness'),
        startedAt: event.createdAt,
        endedAt: null,
        durationMs: null,
        outcome: 'unknown',
        resultContract: null,
        stopReason: taskStopReason(event.summary),
      });
      continue;
    }
    if (event.eventType === 'task') {
      const id = summaryString(event.summary, 'taskId');
      const task = id ? tasks.get(id) : undefined;
      if (!task) continue;
      task.endedAt = event.createdAt;
      task.durationMs = event.durationMs;
      task.outcome = event.isError ? 'failed' : 'completed';
      task.resultContract = summaryBoolean(event.summary, 'resultContract');
      task.stopReason = taskStopReason(event.summary);
      continue;
    }
    if (event.eventType === 'turn') {
      const model =
        summaryString(event.summary, 'responseModel') ??
        summaryString(event.summary, 'requestedModel');
      const thinking = summaryString(event.summary, 'reasoningLevel');
      if (isChild) {
        childTurns += 1;
        if (model) childModels.add(model);
        if (thinking) childThinking.add(thinking);
        addUsage(childUsage, usageFromSummary(event.summary));
      } else {
        parentTurns += 1;
        if (model) parentModels.add(model);
        if (thinking) parentThinking.add(thinking);
        addUsage(parentUsage, usageFromSummary(event.summary));
      }
      continue;
    }
    if (
      event.eventType === 'tool' &&
      event.name?.startsWith(reviewWorkspaceToolPrefix)
    ) {
      addTool(
        isChild ? childTools : parentTools,
        event.name,
        event.durationMs ?? 0,
      );
      continue;
    }
    if (
      event.eventType === 'tool_start' &&
      event.name?.startsWith(reviewWorkspaceToolPrefix)
    ) {
      workspaceStarts.push({
        event,
        taskId,
        inputHash: summaryString(event.summary, 'inputHash'),
      });
    }
  }

  const taskList = [...tasks.values()].sort(
    (a, b) => dateMs(a.startedAt) - dateMs(b.startedAt),
  );
  const waves = new Map<number, ReviewTaskPerformance[]>();
  for (const task of taskList) {
    const key = task.wave || -(taskList.indexOf(task) + 1);
    const wave = waves.get(key) ?? [];
    wave.push(task);
    waves.set(key, wave);
  }
  const taskWaves = [...waves.values()].map((wave, index) => {
    const starts = wave
      .map((task) => dateMs(task.startedAt))
      .filter(Number.isFinite);
    const ends = wave
      .map((task) => dateMs(task.endedAt))
      .filter(Number.isFinite);
    const durations = wave.map((task) => task.durationMs ?? 0);
    const start = starts.length ? Math.min(...starts) : null;
    const end = ends.length ? Math.max(...ends) : null;
    const criticalPathMs =
      start !== null && end !== null ? Math.max(0, end - start) : null;
    const summedTaskDurationMs = durations.reduce(
      (sum, duration) => sum + duration,
      0,
    );
    return {
      wave: index + 1,
      taskCount: wave.length,
      taskIds: wave.map((task) => task.taskId),
      startedAt: start === null ? null : new Date(start).toISOString(),
      endedAt: end === null ? null : new Date(end).toISOString(),
      criticalPathMs,
      summedTaskDurationMs,
      concurrencyEfficiency:
        criticalPathMs && criticalPathMs > 0
          ? summedTaskDurationMs / criticalPathMs
          : null,
    };
  });

  const firstParentTurn = events.find(
    (event) =>
      event.eventType === 'turn_start' &&
      !summaryString(event.summary, 'taskId'),
  );
  const firstTask = taskList[0];
  const finalTask = taskList
    .filter((task) => task.endedAt)
    .sort((left, right) => dateMs(left.endedAt) - dateMs(right.endedAt))
    .at(-1);
  const submitStart = events.find(
    (event) =>
      event.eventType === 'tool_start' &&
      event.name === 'neondeck_submit_pr_review',
  );
  const taskHashCounts = countValues(taskPromptHashes);
  const childSuccessfulAt = Math.max(
    ...taskList
      .filter((task) => task.outcome === 'completed')
      .map((task) => dateMs(task.endedAt)),
    Number.NEGATIVE_INFINITY,
  );
  const childQueryHashes = new Set(
    workspaceStarts
      .filter((entry) => entry.taskId)
      .map((entry) => entry.inputHash)
      .filter(Boolean),
  );
  const parentReplaySignals = workspaceStarts.filter(
    (entry) =>
      !entry.taskId &&
      dateMs(entry.event.createdAt) >= childSuccessfulAt &&
      entry.inputHash &&
      childQueryHashes.has(entry.inputHash),
  ).length;
  const limitations: string[] = [];
  const observedEventCount = input.submission?.eventCount ?? null;
  const retainedObservationComplete =
    observedEventCount !== null && observedEventCount === events.length;
  const observedSubmissionQueued = events.some(
    (event) => event.eventType === 'submission_queued',
  );
  const metricsAvailable =
    retainedObservationComplete && observedSubmissionQueued;
  if (!input.review.submissionId)
    limitations.push('The admitted review has no Flue submission binding.');
  else if (!input.submission)
    limitations.push(
      'The bound Flue submission has no retained lifecycle projection.',
    );
  else if (!retainedObservationComplete)
    limitations.push(
      `Only ${events.length} of ${input.submission.eventCount} observed submission events remain; event-derived task, turn, tool, usage, and replay metrics are unavailable.`,
    );
  if (!observedSubmissionQueued)
    limitations.push(
      'The live observer did not retain the submission_queued anchor, so event-derived metrics are unavailable.',
    );
  if (taskList.some((task) => task.wave === 0))
    limitations.push(
      'Some task events lacked a parent turn correlation; they are shown as separate waves without inferred concurrency.',
    );
  const childActivityCorrelated = events.some(
    (event) =>
      (event.eventType === 'turn' || event.eventType === 'tool') &&
      summaryString(event.summary, 'taskId') !== null,
  );
  if (taskList.length > 0 && !childActivityCorrelated)
    limitations.push(
      'No child turn or tool rows carried task correlation, so child activity totals are unavailable.',
    );
  if (events.length === 0 && input.review.submissionId && !input.submission)
    limitations.push(
      'No retained activity rows are available for the bound submission.',
    );
  limitations.push(
    'Flue observe() is live-only; even anchored retained coverage is best-effort and cannot rule out an unobserved process gap.',
  );
  limitations.push(
    'The resolved workspace merge base and immutable prior-attempt bindings are not persisted, so exact-revision cross-attempt prompt comparison is unavailable.',
  );
  const settlementAt =
    input.review.readyAt ??
    input.review.failedAt ??
    input.submission?.settledAt ??
    null;
  const admissionAt =
    input.submission?.queuedAt ??
    events.find(
      (event) =>
        event.eventType === 'submission_queued' ||
        event.eventType === 'submission_running',
    )?.createdAt ??
    null;

  return {
    ok: true,
    action: 'pr_review_performance_read',
    review: {
      reviewId: input.review.reviewId,
      attemptId: input.review.attemptId,
      submissionId: input.review.submissionId,
      headSha: input.review.headSha,
      baseSha: input.review.baseSha,
      mergeBase: null,
      status: input.review.status,
    },
    correlation: {
      taskCorrelationAvailable:
        metricsAvailable && (taskList.length === 0 || childActivityCorrelated),
      waveCorrelationAvailable:
        metricsAvailable && taskList.every((task) => task.wave > 0),
      retainedObservationComplete,
      observedSubmissionQueued,
      metricsCoverage: metricsAvailable ? 'anchored-best-effort' : 'partial',
      retainedEventCount: events.length,
      observedEventCount,
      limitations,
    },
    models: {
      parent: metricsAvailable
        ? { models: [...parentModels], thinkingLevels: [...parentThinking] }
        : null,
      explore: metricsAvailable
        ? { models: [...childModels], thinkingLevels: [...childThinking] }
        : null,
    },
    timings: {
      admittedToFirstParentTurnMs: metricsAvailable
        ? elapsedMs(admissionAt, firstParentTurn?.createdAt ?? null)
        : null,
      firstParentTurnToFirstTaskWaveMs: metricsAvailable
        ? elapsedMs(
            firstParentTurn?.createdAt ?? null,
            firstTask?.startedAt ?? null,
          )
        : null,
      finalTaskToReviewSubmitMs: metricsAvailable
        ? elapsedMs(finalTask?.endedAt ?? null, submitStart?.createdAt ?? null)
        : null,
      admittedToSettlementMs: metricsAvailable
        ? elapsedMs(admissionAt, settlementAt)
        : null,
    },
    taskWaves: metricsAvailable ? taskWaves : null,
    tasks: metricsAvailable ? taskList : null,
    turns: {
      parent: metricsAvailable ? parentTurns : null,
      child: metricsAvailable ? childTurns : null,
    },
    workspaceTools: {
      parent: metricsAvailable ? parentTools : null,
      child: metricsAvailable ? childTools : null,
    },
    usage: {
      parent: metricsAvailable ? parentUsage.usage : null,
      child: metricsAvailable ? childUsage.usage : null,
    },
    taskBriefs: {
      allRequiredFieldsPresent: !metricsAvailable
        ? null
        : taskList.length &&
            taskList.every((task) => {
              const start = taskStarts.get(task.taskId);
              return (
                summaryNumber(
                  start?.summary ?? null,
                  'taskBriefSchemaVersion',
                ) === taskBriefSchemaVersion
              );
            })
          ? taskList.every((task) => {
              const start = taskStarts.get(task.taskId);
              return [
                'questionHash',
                'revisionHash',
                'scopeHash',
                'exclusionsHash',
                'knownFactsHash',
                'expectedEvidenceHash',
                'thoroughness',
              ].every(
                (key) => summaryString(start?.summary ?? null, key) !== null,
              );
            })
          : null,
    },
    repetition: {
      promptHashesWithinAttempt: metricsAvailable
        ? Object.entries(taskHashCounts)
            .filter(([, count]) => count > 1)
            .map(([hash]) => hash)
        : null,
      promptHashesAcrossExactRevision: null,
      repeatedWorkspaceQueries: metricsAvailable
        ? repeatedCount(workspaceStarts.map((entry) => entry.inputHash))
        : null,
      retainedOutputReuses: metricsAvailable
        ? workspaceStarts.filter(
            (entry) =>
              entry.event.name === `${reviewWorkspaceToolPrefix}output`,
          ).length
        : null,
      parentReplaySignals: metricsAvailable ? parentReplaySignals : null,
    },
  };
}

function summaryString(summary: JsonValue | null, key: string) {
  const value = objectRecord(summary)?.[key];
  return typeof value === 'string' ? value : null;
}

function summaryBoolean(summary: JsonValue | null, key: string) {
  const value = objectRecord(summary)?.[key];
  return typeof value === 'boolean' ? value : null;
}

function summaryNumber(summary: JsonValue | null, key: string) {
  const value = objectRecord(summary)?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function taskStopReason(summary: JsonValue | null) {
  const value = summaryString(summary, 'stopReason');
  return value === 'answered' ||
    value === 'insufficient evidence' ||
    value === 'blocked'
    ? value
    : null;
}

function dateMs(value: string | null) {
  if (!value) return Number.NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : Number.NaN;
}

function elapsedMs(start: string | null, end: string | null) {
  const startMs = dateMs(start);
  const endMs = dateMs(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : null;
}

function emptyUsage(): ActivityUsageAccumulator {
  return {
    turns: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cost: null,
      complete: true,
    },
  };
}

function usageFromSummary(summary: JsonValue | null): ActivityUsage {
  const usage = objectRecord(objectRecord(summary)?.usage);
  const cost = objectRecord(usage?.cost);
  const result: ActivityUsage = {
    inputTokens: numberOrNull(usage?.inputTokens),
    outputTokens: numberOrNull(usage?.outputTokens),
    cacheReadTokens: numberOrNull(usage?.cacheReadTokens),
    cacheWriteTokens: numberOrNull(usage?.cacheWriteTokens),
    totalTokens: numberOrNull(usage?.totalTokens),
    cost: cost
      ? {
          input: numberOrNull(cost.input),
          output: numberOrNull(cost.output),
          cacheRead: numberOrNull(cost.cacheRead),
          cacheWrite: numberOrNull(cost.cacheWrite),
          total: numberOrNull(cost.total),
        }
      : null,
    complete: false,
  };
  result.complete =
    result.inputTokens !== null &&
    result.outputTokens !== null &&
    result.cacheReadTokens !== null &&
    result.cacheWriteTokens !== null &&
    result.totalTokens !== null &&
    result.cost !== null &&
    Object.values(result.cost).every((value) => value !== null);
  return result;
}

function addUsage(target: ActivityUsageAccumulator, source: ActivityUsage) {
  const firstTurn = target.turns === 0;
  target.turns += 1;
  target.usage.inputTokens = addKnownNumbers(
    target.usage.inputTokens,
    source.inputTokens,
  );
  target.usage.outputTokens = addKnownNumbers(
    target.usage.outputTokens,
    source.outputTokens,
  );
  target.usage.cacheReadTokens = addKnownNumbers(
    target.usage.cacheReadTokens,
    source.cacheReadTokens,
  );
  target.usage.cacheWriteTokens = addKnownNumbers(
    target.usage.cacheWriteTokens,
    source.cacheWriteTokens,
  );
  target.usage.totalTokens = addKnownNumbers(
    target.usage.totalTokens,
    source.totalTokens,
  );
  if (firstTurn) target.usage.cost = source.cost ? { ...source.cost } : null;
  else if (!target.usage.cost || !source.cost) target.usage.cost = null;
  else {
    target.usage.cost.input = addKnownNumbers(
      target.usage.cost.input,
      source.cost.input,
    );
    target.usage.cost.output = addKnownNumbers(
      target.usage.cost.output,
      source.cost.output,
    );
    target.usage.cost.cacheRead = addKnownNumbers(
      target.usage.cost.cacheRead,
      source.cost.cacheRead,
    );
    target.usage.cost.cacheWrite = addKnownNumbers(
      target.usage.cost.cacheWrite,
      source.cost.cacheWrite,
    );
    target.usage.cost.total = addKnownNumbers(
      target.usage.cost.total,
      source.cost.total,
    );
  }
  target.usage.complete = target.usage.complete && source.complete;
}

function addKnownNumbers(left: number | null, right: number | null) {
  return left === null || right === null ? null : left + right;
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function addTool(
  target: Record<string, { calls: number; durationMs: number }>,
  toolName: string,
  durationMs: number,
) {
  const entry = target[toolName] ?? { calls: 0, durationMs: 0 };
  entry.calls += 1;
  entry.durationMs += durationMs;
  target[toolName] = entry;
}

function countValues(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function repeatedCount(values: Array<string | null>) {
  return Object.values(
    countValues(values.filter((value): value is string => value !== null)),
  )
    .filter((count) => count > 1)
    .reduce((total, count) => total + count - 1, 0);
}

function objectRecord(value: unknown): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : null;
}
