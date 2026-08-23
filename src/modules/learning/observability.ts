import { type FlueObservation, type JsonValue } from '@flue/runtime';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';

export type ActivityEventRecord = {
  id: number;
  submissionId: string | null;
  eventType: string;
  eventIndex: number | null;
  level: string | null;
  message: string;
  name: string | null;
  operationKind: string | null;
  operationId: string | null;
  agentName: string | null;
  instanceId: string | null;
  conversationId: string | null;
  durationMs: number | null;
  isError: boolean;
  summary: JsonValue | null;
  createdAt: string;
  detailUrl: string | null;
};

export type ActivityObservabilitySnapshot = {
  ok: true;
  action: 'activity_observability_read';
  activeSubmissions: Array<{
    submissionId: string;
    kind: string;
    agentName: string | null;
    instanceId: string | null;
    status: 'queued' | 'running';
    queuedAt: string;
    startedAt: string | null;
    lastEventAt: string;
    lastMessage: string;
    eventCount: number;
    attemptCount: number;
    detailUrl: string;
  }>;
  recentFailures: ActivityEventRecord[];
  recentSettlements: ActivityEventRecord[];
  recentLogs: ActivityEventRecord[];
  recentTools: ActivityEventRecord[];
  recentOperations: ActivityEventRecord[];
  recentEvents: ActivityEventRecord[];
  fetchedAt: string;
};

export type ActivitySubmissionEventHistory = {
  events: ActivityEventRecord[];
  totalEventCount: number;
  retainedEventCount: number;
  isTruncated: boolean;
};

export type ActivityEventQuery = { afterEventId?: number };

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

type ActivityUsageAccumulator = {
  turns: number;
  usage: ActivityUsage;
};

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

const maxActivityEventRows = 5_000;
const maxActivityContentLength = 64_000;
const taskBriefSchemaVersion = 1;
const redacted = '[redacted]';
const persistedEventTypes = new Set<FlueObservation['type']>([
  'submission_queued',
  'submission_running',
  'submission_recovery',
  'submission_settled',
  'agent_start',
  'agent_end',
  'operation_start',
  'operation',
  'tool_start',
  'tool',
  'turn_start',
  'turn',
  'task_start',
  'task',
  'compaction_start',
  'compaction',
  'log',
]);

export async function recordFlueObservation(
  event: FlueObservation,
  paths = runtimePaths(),
) {
  if (!persistedEventTypes.has(event.type)) return;
  await ensureRuntimeHome(paths);
  const summary = withCorrelationMetadata(event, summarizeObservation(event));
  const database = openDb(paths.neondeckDatabase);
  const createdAt = event.timestamp ?? new Date().toISOString();

  try {
    database
      .prepare(
        `
        INSERT INTO activity_events (
          submission_id, agent_name, instance_id, conversation_id,
          event_type, event_index, level, message, name,
          operation_kind, operation_id, duration_ms, is_error,
          summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        event.submissionId ?? null,
        boundedIdentifier(event.agentName ?? null),
        boundedIdentifier(event.instanceId ?? null),
        boundedIdentifier(event.conversationId ?? null),
        event.type,
        event.eventIndex,
        event.type === 'log' ? event.level : null,
        summary.message,
        summary.name,
        summary.operationKind,
        event.operationId ?? null,
        summary.durationMs,
        summary.isError ? 1 : 0,
        JSON.stringify(summary.summary),
        createdAt,
      );
    updateSubmissionProjection(database, event, summary.message, createdAt);
    pruneActivityEvents(database);
  } finally {
    database.close();
  }
}

export async function readActivityObservability(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });

  try {
    const recentEvents = database
      .prepare(
        `SELECT * FROM activity_events
         ORDER BY created_at DESC, id DESC LIMIT 120;`,
      )
      .all()
      .map(readActivityEventRow);
    const activeSubmissions = database
      .prepare(
        `SELECT * FROM activity_submissions
         WHERE status IN ('queued', 'running')
         ORDER BY last_event_at DESC LIMIT 10;`,
      )
      .all()
      .map(readActiveSubmissionRow);

    return {
      ok: true,
      action: 'activity_observability_read',
      activeSubmissions,
      recentFailures: recentEvents
        .filter(
          (event) => event.eventType === 'submission_settled' && event.isError,
        )
        .slice(0, 10),
      recentSettlements: recentEvents
        .filter((event) => event.eventType === 'submission_settled')
        .slice(0, 10),
      recentLogs: recentEvents
        .filter((event) => event.eventType === 'log')
        .slice(0, 10),
      recentTools: recentEvents
        .filter((event) => event.eventType === 'tool')
        .slice(0, 10),
      recentOperations: recentEvents
        .filter((event) => event.eventType === 'operation')
        .slice(0, 10),
      recentEvents: recentEvents.slice(0, 20),
      fetchedAt: new Date().toISOString(),
    } satisfies ActivityObservabilitySnapshot;
  } finally {
    database.close();
  }
}

export async function readActivitySubmissionEvents(
  submissionId: string,
  paths = runtimePaths(),
  query: ActivityEventQuery = {},
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  database.exec('BEGIN;');

  try {
    const eventRows =
      query.afterEventId === undefined
        ? database
            .prepare(
              `SELECT * FROM activity_events
               WHERE submission_id = ? ORDER BY id ASC;`,
            )
            .all(submissionId)
        : database
            .prepare(
              `SELECT * FROM activity_events
               WHERE submission_id = ? AND id > ? ORDER BY id ASC;`,
            )
            .all(submissionId, query.afterEventId);
    const events = eventRows
      .map(readActivityEventRow)
      .sort(compareActivityEvents);
    const projection = database
      .prepare(
        `SELECT event_count FROM activity_submissions
         WHERE submission_id = ?;`,
      )
      .get(submissionId) as { event_count?: unknown } | undefined;
    const retained = database
      .prepare(
        `SELECT COUNT(*) AS retained_event_count FROM activity_events
         WHERE submission_id = ?;`,
      )
      .get(submissionId) as { retained_event_count?: unknown } | undefined;
    const retainedEventCount =
      typeof retained?.retained_event_count === 'number'
        ? retained.retained_event_count
        : events.length;
    const observedEventCount =
      typeof projection?.event_count === 'number'
        ? projection.event_count
        : retainedEventCount;
    const history = {
      events,
      totalEventCount: Math.max(observedEventCount, retainedEventCount),
      retainedEventCount,
      isTruncated: observedEventCount > retainedEventCount,
    } satisfies ActivitySubmissionEventHistory;
    database.exec('COMMIT;');
    return history;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export async function readActivitySubmission(
  submissionId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(`SELECT * FROM activity_submissions WHERE submission_id = ?;`)
      .get(submissionId);
    return row ? readSubmissionRow(row) : null;
  } finally {
    database.close();
  }
}

/**
 * Derives a content-free PR-review performance report from retained activity.
 * It deliberately uses terminal turn events for usage: Flue operation usage is
 * a roll-up of those same leaf events and must not be added again.
 */
export async function readPrReviewPerformance(
  reviewId: string,
  paths = runtimePaths(),
): Promise<PrReviewPerformanceProjection | null> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const review = database
      .prepare(
        `SELECT id, attempt_id, run_id, head_sha, base_sha, status,
                ready_at, failed_at FROM pr_reviews WHERE id = ? LIMIT 1;`,
      )
      .get(reviewId.trim()) as Record<string, unknown> | undefined;
    if (!review) return null;

    const submissionId = stringOrNull(review.run_id);
    const submission = submissionId
      ? (database
          .prepare(
            `SELECT event_count, queued_at, settled_at
             FROM activity_submissions WHERE submission_id = ? LIMIT 1;`,
          )
          .get(submissionId) as Record<string, unknown> | undefined)
      : undefined;
    const events = submissionId
      ? database
          .prepare(
            `SELECT * FROM activity_events WHERE submission_id = ? ORDER BY id ASC;`,
          )
          .all(submissionId)
          .map(readActivityEventRow)
          .sort(compareActivityEvents)
      : [];
    return projectPrReviewPerformance({
      review: {
        reviewId: String(review.id),
        attemptId: String(review.attempt_id),
        submissionId,
        headSha: String(review.head_sha),
        baseSha: stringOrNull(review.base_sha),
        status: String(review.status),
        readyAt: stringOrNull(review.ready_at),
        failedAt: stringOrNull(review.failed_at),
      },
      submission: submission
        ? {
            eventCount: Number(submission.event_count),
            queuedAt: String(submission.queued_at),
            settledAt: stringOrNull(submission.settled_at),
          }
        : null,
      events,
    });
  } finally {
    database.close();
  }
}

function projectPrReviewPerformance(input: {
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

  // A task call batch shares its parent model turn. If Flue correlation was not
  // retained, each task remains visible but no concurrency claim is made.
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
        ? {
            models: [...parentModels],
            thinkingLevels: [...parentThinking],
          }
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
  if (firstTurn) {
    target.usage.cost = source.cost ? { ...source.cost } : null;
  } else if (!target.usage.cost || !source.cost) {
    target.usage.cost = null;
  } else {
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

function summarizeObservation(event: FlueObservation): {
  message: string;
  name: string | null;
  operationKind: string | null;
  durationMs: number | null;
  isError: boolean;
  summary: JsonValue;
} {
  switch (event.type) {
    case 'submission_queued':
      return activitySummary(
        `Submission queued for ${event.agentName ?? 'agent'}.`,
        event.agentName ?? null,
        false,
        { kind: event.kind },
      );
    case 'submission_running':
      return activitySummary(
        `Submission attempt ${event.attemptCount} started.`,
        event.agentName ?? null,
        false,
        {
          kind: event.kind,
          attemptCount: event.attemptCount,
          maxAttempts: event.maxAttempts,
        },
      );
    case 'submission_recovery':
      return activitySummary(
        `Submission recovery ${event.operation}: ${event.outcome}.`,
        event.agentName ?? null,
        event.outcome === 'terminated',
        {
          operation: event.operation,
          outcome: event.outcome,
          attemptCount: event.attemptCount ?? null,
          maxAttempts: event.maxAttempts ?? null,
          error: event.error ? summarizeError(event.error) : null,
        },
      );
    case 'submission_settled':
      return activitySummary(
        `Submission ${event.outcome}.`,
        event.agentName ?? null,
        event.outcome !== 'completed',
        {
          outcome: event.outcome,
          error: event.error ? summarizeError(event.error) : null,
        },
      );
    case 'log':
      return activitySummary(
        sanitizeMessage(event.message),
        null,
        event.level === 'error',
        {
          level: event.level,
          attributes: sanitizeRecord(event.attributes),
        },
      );
    case 'operation_start':
      return activitySummary(
        `${event.operationKind} operation started.`,
        null,
        false,
        {
          operationKind: event.operationKind,
        },
        event.operationKind,
      );
    case 'operation':
      return activitySummary(
        `${event.operationKind} operation ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        null,
        event.isError,
        {
          operationKind: event.operationKind,
          usage: summarizeUsage(event.usage),
          error: event.isError ? summarizeError(event.error) : null,
        },
        event.operationKind,
        event.durationMs,
      );
    case 'tool_start':
      return summarizeToolStart(event);
    case 'tool':
      return summarizeToolCompletion(event);
    case 'turn_start':
      return activitySummary(
        `Model turn started (${event.purpose}).`,
        null,
        false,
        {
          purpose: event.purpose,
          turnId: event.turnId,
        },
      );
    case 'turn':
      return activitySummary(
        `Model turn ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        event.request.requestedModel,
        event.isError,
        {
          providerId: event.request.providerId,
          requestedModel: event.request.requestedModel,
          reasoningLevel: event.request.reasoningLevel ?? null,
          responseModel: event.response.responseModel ?? null,
          finishReason: event.response.finishReason ?? null,
          usage: summarizeUsage(event.response.usage),
        },
        null,
        event.durationMs,
      );
    case 'task_start':
      return activitySummary(
        `Task ${event.taskId} started.`,
        event.agent ?? null,
        false,
        {
          taskId: event.taskId,
          agent: event.agent ?? null,
          prompt: sanitizeActivityContent(event.prompt),
          promptTruncated: event.prompt.length > maxActivityContentLength,
          ...taskPromptMetadata(event.prompt),
        },
      );
    case 'task':
      return activitySummary(
        `Task ${event.taskId} ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        event.agent ?? null,
        event.isError,
        compactJsonRecord({
          taskId: event.taskId,
          agent: event.agent ?? null,
          resultHash:
            event.result === undefined ? null : privacyHash(event.result),
          resultBytes: jsonByteLength(event.result),
          result:
            typeof event.result === 'string'
              ? sanitizeActivityContent(event.result)
              : undefined,
          resultTruncated:
            typeof event.result === 'string'
              ? event.result.length > maxActivityContentLength
              : undefined,
          ...taskResultMetadata(event.result),
        }),
        null,
        event.durationMs,
      );
    case 'compaction_start':
      return activitySummary('Context compaction started.', null, false, {
        reason: event.reason,
        estimatedTokens: event.estimatedTokens,
      });
    case 'compaction':
      return activitySummary(
        `Context compaction ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        null,
        event.isError,
        {
          messagesBefore: event.messagesBefore,
          messagesAfter: event.messagesAfter,
          usage: summarizeUsage(event.usage),
        },
        null,
        event.durationMs,
      );
    case 'agent_start':
      return activitySummary(
        `Agent ${event.agentName ?? 'instance'} started.`,
        event.agentName ?? null,
        false,
        null,
      );
    case 'agent_end':
      return activitySummary(
        `Agent ${event.agentName ?? 'instance'} finished.`,
        event.agentName ?? null,
        false,
        {
          messageCount: event.messages.length,
        },
      );
    default:
      return activitySummary(`${event.type} observed.`, null, false, {
        type: event.type,
      });
  }
}

function activitySummary(
  message: string,
  name: string | null,
  isError: boolean,
  summary: JsonValue,
  operationKind: string | null = null,
  durationMs: number | null = null,
) {
  return { message, name, operationKind, durationMs, isError, summary };
}

function withCorrelationMetadata(
  event: FlueObservation,
  activity: ReturnType<typeof activitySummary>,
) {
  const summary = objectRecord(activity.summary);
  if (!summary) return activity;
  return {
    ...activity,
    summary: compactJsonRecord({
      ...summary,
      taskId: event.taskId ?? undefined,
      turnId: event.turnId ?? undefined,
    }),
  };
}

function taskPromptMetadata(prompt: string): Record<string, JsonValue> {
  const question = taskPromptField(prompt, 'Question');
  const revision = taskPromptField(prompt, 'Revision');
  const scope = taskPromptField(prompt, 'Scope');
  const exclusions = taskPromptField(prompt, 'Exclusions');
  const knownFacts = taskPromptField(prompt, 'Known facts');
  const expectedEvidence = taskPromptField(prompt, 'Expected evidence');
  const thoroughness = taskPromptField(prompt, 'Thoroughness')?.toLowerCase();
  return compactJsonRecord({
    taskBriefSchemaVersion,
    promptHash: privacyHash(prompt),
    promptLength: prompt.length,
    questionHash: question ? privacyHash(question) : undefined,
    revisionHash: revision ? privacyHash(revision) : undefined,
    scopeHash: scope ? privacyHash(scope) : undefined,
    scopeItemCount: scope ? scopeItemCount(scope) : undefined,
    exclusionsHash: exclusions ? privacyHash(exclusions) : undefined,
    exclusionItemCount: exclusions ? scopeItemCount(exclusions) : undefined,
    knownFactsHash: knownFacts ? privacyHash(knownFacts) : undefined,
    expectedEvidenceHash: expectedEvidence
      ? privacyHash(expectedEvidence)
      : undefined,
    thoroughness: safeEnum(thoroughness, ['quick', 'medium', 'very thorough']),
  });
}

function taskResultMetadata(result: unknown): Record<string, JsonValue> {
  if (typeof result !== 'string') return {};
  const requiredFields = ['Answer', 'Evidence', 'Unresolved', 'Inspected'];
  const allRequiredFields = requiredFields.every((field) =>
    resultContractSectionHasContent(result, field),
  );
  const stopReason = taskPromptField(result, 'Stop reason')?.toLowerCase();
  return compactJsonRecord({
    resultContract:
      allRequiredFields &&
      safeEnum(stopReason, ['answered', 'insufficient evidence', 'blocked']) !==
        undefined,
    stopReason: safeEnum(stopReason, [
      'answered',
      'insufficient evidence',
      'blocked',
    ]),
  });
}

function resultContractSectionHasContent(result: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^${escaped}:[ \\t]*(.*)$`, 'im').exec(result);
  if (!header) return false;
  if (header[1]?.trim()) return true;
  const tail = result.slice((header.index ?? 0) + header[0].length);
  const nextHeader = tail.search(
    /^(?:Answer|Evidence|Unresolved|Inspected|Stop reason):/im,
  );
  return (
    tail.slice(0, nextHeader < 0 ? undefined : nextHeader).trim().length > 0
  );
}

function taskPromptField(prompt: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'im')
    .exec(prompt)?.[1]
    ?.trim();
}

function scopeItemCount(value: string) {
  return value
    .split(/[,;]+/)
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function privacyHash(value: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalHashValue(value)) ?? 'null';
  } catch {
    serialized = String(value);
  }
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function canonicalHashValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalHashValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalHashValue(entry)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  return value;
}

const reviewWorkspaceToolPrefix = 'neondeck_review_workspace_';

function summarizeToolStart(
  event: Extract<FlueObservation, { type: 'tool_start' }>,
) {
  const reviewOperation = reviewWorkspaceOperation(event.toolName);
  if (!reviewOperation) {
    return activitySummary(
      `Tool ${event.toolName} started.`,
      event.toolName,
      false,
      {
        toolName: event.toolName,
        origin: event.origin ?? null,
        args: summarizeUnknown(event.args),
      },
    );
  }
  const args = reviewWorkspaceArgs(event.args);
  const target = typeof args.path === 'string' ? ` for ${args.path}` : '';
  return activitySummary(
    `Review workspace ${reviewOperation} started${target}.`,
    event.toolName,
    false,
    {
      category: 'review-workspace',
      operation: reviewOperation,
      phase: 'started',
      origin: event.origin ?? null,
      inputHash: privacyHash(event.args),
      ...args,
    },
  );
}

function summarizeToolCompletion(
  event: Extract<FlueObservation, { type: 'tool' }>,
) {
  const reviewOperation = reviewWorkspaceOperation(event.toolName);
  if (!reviewOperation) {
    return activitySummary(
      `Tool ${event.toolName} ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
      event.toolName,
      event.isError,
      {
        toolName: event.toolName,
        error: event.errorInfo?.message
          ? summarizeError(event.errorInfo)
          : null,
        result: summarizeUnknown(event.effectiveResult ?? event.result),
      },
      null,
      event.durationMs,
    );
  }
  const result = reviewWorkspaceResult(
    reviewOperation,
    event.effectiveResult ?? event.result,
  );
  const target = typeof result.path === 'string' ? ` for ${result.path}` : '';
  return activitySummary(
    `Review workspace ${reviewOperation} ${event.isError ? 'failed' : 'completed'}${target} in ${formatDuration(event.durationMs)}.`,
    event.toolName,
    event.isError,
    {
      category: 'review-workspace',
      operation: reviewOperation,
      phase: event.isError ? 'failed' : 'completed',
      resultHash: privacyHash(
        stableReviewWorkspaceResult(event.effectiveResult ?? event.result),
      ),
      ...result,
      error: event.errorInfo?.message ? summarizeError(event.errorInfo) : null,
    },
    null,
    event.durationMs,
  );
}

function reviewWorkspaceOperation(toolName: string) {
  return toolName.startsWith(reviewWorkspaceToolPrefix)
    ? toolName.slice(reviewWorkspaceToolPrefix.length)
    : null;
}

function reviewWorkspaceArgs(value: unknown): Record<string, JsonValue> {
  const record = objectRecord(value);
  if (!record) return {};
  return compactJsonRecord({
    path: safeActivityPath(record.path),
    queryLength:
      typeof record.query === 'string' ? record.query.length : undefined,
    queryHash:
      typeof record.query === 'string' ? privacyHash(record.query) : undefined,
    revision: safeEnum(record.revision, ['head', 'base']),
    startLine: optionalNumber(record.startLine),
    endLine: optionalNumber(record.endLine),
    rightLine: optionalNumber(record.rightLine),
    contextLines: optionalNumber(record.contextLines),
    cursor: optionalNumber(record.cursor),
    limit: optionalNumber(record.limit),
  });
}

function reviewWorkspaceResult(
  operation: string,
  value: unknown,
): Record<string, JsonValue> {
  const record = objectRecord(value);
  if (!record) return { result: summarizeUnknown(value) };
  const matches = Array.isArray(record.matches) ? record.matches : null;
  const paths = Array.isArray(record.paths) ? record.paths : null;
  const files = Array.isArray(record.files) ? record.files : null;
  const hunks = Array.isArray(record.hunks) ? record.hunks : null;
  const lines = Array.isArray(record.lines) ? record.lines : null;
  const commits = Array.isArray(record.commits) ? record.commits : null;
  const summary = objectRecord(record.summary);
  return compactJsonRecord({
    path: safeActivityPath(record.path),
    queryLength:
      typeof record.query === 'string' ? record.query.length : undefined,
    queryHash:
      typeof record.query === 'string' ? privacyHash(record.query) : undefined,
    revisionKind: safeEnum(record.revisionKind, ['head', 'base']),
    scope: safeEnum(record.scope, ['file', 'pull-request']),
    available:
      typeof record.available === 'boolean' ? record.available : undefined,
    reason: safeActivityString(record.reason, 500),
    startLine: optionalNumber(record.startLine),
    endLine: optionalNumber(record.endLine),
    totalLines: optionalNumber(record.totalLines),
    rightLine: optionalNumber(record.rightLine),
    targetChanged:
      typeof record.targetChanged === 'boolean'
        ? record.targetChanged
        : undefined,
    resultBytes: jsonByteLength(value),
    returnedPaths: paths?.length,
    returnedFiles: files?.length,
    returnedMatches: matches?.length,
    returnedHunks: hunks?.length,
    returnedLines: lines?.length,
    returnedCommits: commits?.length,
    totalHunks: optionalNumber(record.totalHunks),
    totalMatches: optionalNumber(record.totalMatches),
    outputRetained:
      typeof record.outputRetained === 'boolean'
        ? record.outputRetained
        : undefined,
    outputBytes: optionalNumber(record.outputBytes),
    outputLines: optionalNumber(record.outputLines),
    totalFiles: optionalNumber(summary?.files),
    additions: optionalNumber(summary?.additions),
    deletions: optionalNumber(summary?.deletions),
    cursor: optionalNumber(record.cursor),
    nextCursor: optionalNumber(record.nextCursor),
    truncated:
      typeof record.truncated === 'boolean' ? record.truncated : undefined,
    workspaceToolCallsRemaining: optionalNumber(
      record.workspaceToolCallsRemaining,
    ),
    workspaceToolCallLimit: optionalNumber(record.workspaceToolCallLimit),
    operation,
  });
}

function stableReviewWorkspaceResult(value: unknown) {
  const record = objectRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) =>
        key !== 'workspaceToolCallsRemaining' &&
        key !== 'outputRef' &&
        key !== 'outputHint',
    ),
  );
}

function objectRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compactJsonRecord(
  value: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );
}

function safeActivityString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return undefined;
  if (looksSensitive(value)) return redacted;
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

/**
 * Activity is a trusted local operator surface, so task instructions and
 * results remain inspectable. Redact credential-shaped values surgically
 * instead of replacing the whole prompt, and cap unusually large payloads so
 * one event cannot dominate the retained activity database.
 */
function sanitizeActivityContent(value: string) {
  const sanitized = value
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gi,
      '[redacted private key]',
    )
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|credential)\b(\s*[:=]\s*)(["'])[^\r\n]*?\3/gi,
      '$1$2$3[redacted]$3',
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|credential)\b(\s*[:=]\s*)[^\s,"';}\]]+/gi,
      '$1$2[redacted]',
    )
    .replace(
      /\b(?:gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{20,})\b/gi,
      '[redacted credential]',
    );
  return sanitized.length > maxActivityContentLength
    ? `${sanitized.slice(0, maxActivityContentLength)}\n\n[truncated]`
    : sanitized;
}

function safeActivityPath(value: unknown) {
  if (typeof value !== 'string') return undefined;
  if (
    value.includes('\u0000') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return '[invalid path]';
  }
  return value.length > 1_000 ? `${value.slice(0, 997)}...` : value;
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function jsonByteLength(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? undefined
      : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return undefined;
  }
}

function safeEnum(value: unknown, values: readonly string[]) {
  return typeof value === 'string' && values.includes(value)
    ? value
    : undefined;
}

function updateSubmissionProjection(
  database: DatabaseSync,
  event: FlueObservation,
  message: string,
  createdAt: string,
) {
  if (!event.submissionId) return;
  const agentName = boundedIdentifier(event.agentName ?? null);
  const instanceId = boundedIdentifier(event.instanceId ?? null);

  if (event.type === 'submission_queued') {
    database
      .prepare(
        `INSERT INTO activity_submissions (
           submission_id, kind, agent_name, instance_id, status, queued_at,
           last_event_at, last_message, event_count, attempt_count,
           is_error, updated_at
         ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 1, 0, 0, ?)
         ON CONFLICT(submission_id) DO UPDATE SET
           kind = excluded.kind,
           agent_name = COALESCE(excluded.agent_name, activity_submissions.agent_name),
           instance_id = COALESCE(excluded.instance_id, activity_submissions.instance_id),
           last_event_at = MAX(activity_submissions.last_event_at, excluded.last_event_at),
           last_message = CASE
             WHEN excluded.last_event_at >= activity_submissions.last_event_at
               THEN excluded.last_message
             ELSE activity_submissions.last_message
           END,
           event_count = activity_submissions.event_count + 1,
           updated_at = MAX(activity_submissions.updated_at, excluded.updated_at);`,
      )
      .run(
        event.submissionId,
        event.kind,
        agentName,
        instanceId,
        createdAt,
        createdAt,
        message,
        createdAt,
      );
    return;
  }

  if (event.type === 'submission_running') {
    database
      .prepare(
        `INSERT INTO activity_submissions (
           submission_id, kind, agent_name, instance_id, status, queued_at,
           started_at, last_event_at, last_message, event_count,
           attempt_count, is_error, updated_at
         ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 1, ?, 0, ?)
         ON CONFLICT(submission_id) DO UPDATE SET
           kind = excluded.kind,
           agent_name = COALESCE(excluded.agent_name, activity_submissions.agent_name),
           instance_id = COALESCE(excluded.instance_id, activity_submissions.instance_id),
           status = CASE
             WHEN activity_submissions.status IN ('completed', 'failed', 'aborted')
               THEN activity_submissions.status
             ELSE 'running'
           END,
           started_at = COALESCE(activity_submissions.started_at, excluded.started_at),
           last_event_at = MAX(activity_submissions.last_event_at, excluded.last_event_at),
           last_message = CASE
             WHEN excluded.last_event_at >= activity_submissions.last_event_at
               THEN excluded.last_message
             ELSE activity_submissions.last_message
           END,
           event_count = activity_submissions.event_count + 1,
           attempt_count = MAX(activity_submissions.attempt_count, excluded.attempt_count),
           updated_at = MAX(activity_submissions.updated_at, excluded.updated_at);`,
      )
      .run(
        event.submissionId,
        event.kind,
        agentName,
        instanceId,
        createdAt,
        createdAt,
        createdAt,
        message,
        event.attemptCount,
        createdAt,
      );
    return;
  }

  if (event.type === 'submission_settled') {
    database
      .prepare(
        `INSERT INTO activity_submissions (
           submission_id, kind, agent_name, instance_id, status, queued_at,
           settled_at, last_event_at, last_message, event_count,
           attempt_count, is_error, updated_at
         ) VALUES (?, 'unknown', ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)
         ON CONFLICT(submission_id) DO UPDATE SET
           agent_name = COALESCE(excluded.agent_name, activity_submissions.agent_name),
           instance_id = COALESCE(excluded.instance_id, activity_submissions.instance_id),
           status = excluded.status,
           settled_at = COALESCE(activity_submissions.settled_at, excluded.settled_at),
           last_event_at = MAX(activity_submissions.last_event_at, excluded.last_event_at),
           last_message = CASE
             WHEN excluded.last_event_at >= activity_submissions.last_event_at
               THEN excluded.last_message
             ELSE activity_submissions.last_message
           END,
           event_count = activity_submissions.event_count + 1,
           is_error = excluded.is_error,
           updated_at = MAX(activity_submissions.updated_at, excluded.updated_at);`,
      )
      .run(
        event.submissionId,
        agentName,
        instanceId,
        event.outcome,
        createdAt,
        createdAt,
        createdAt,
        message,
        event.outcome === 'completed' ? 0 : 1,
        createdAt,
      );
    return;
  }

  database
    .prepare(
      `UPDATE activity_submissions SET
         agent_name = COALESCE(?, agent_name),
         instance_id = COALESCE(?, instance_id),
         last_event_at = MAX(last_event_at, ?),
         last_message = CASE WHEN ? >= last_event_at THEN ? ELSE last_message END,
         event_count = event_count + 1, updated_at = MAX(updated_at, ?)
       WHERE submission_id = ?;`,
    )
    .run(
      agentName,
      instanceId,
      createdAt,
      createdAt,
      message,
      createdAt,
      event.submissionId,
    );
}

function readActivityEventRow(row: unknown): ActivityEventRecord {
  const record = row as Record<string, unknown>;
  const submissionId = stringOrNull(record.submission_id);
  return {
    id: Number(record.id),
    submissionId,
    eventType: String(record.event_type),
    eventIndex:
      typeof record.event_index === 'number' ? record.event_index : null,
    level: stringOrNull(record.level),
    message: String(record.message),
    name: stringOrNull(record.name),
    operationKind: stringOrNull(record.operation_kind),
    operationId: stringOrNull(record.operation_id),
    agentName: stringOrNull(record.agent_name),
    instanceId: stringOrNull(record.instance_id),
    conversationId: stringOrNull(record.conversation_id),
    durationMs:
      typeof record.duration_ms === 'number' ? record.duration_ms : null,
    isError: Boolean(record.is_error),
    summary:
      typeof record.summary_json === 'string'
        ? parseJson(record.summary_json)
        : null,
    createdAt: String(record.created_at),
    detailUrl: activityDetailUrl(submissionId),
  };
}

function readActiveSubmissionRow(row: unknown) {
  const submission = readSubmissionRow(row);
  return {
    submissionId: submission.submissionId,
    kind: submission.kind,
    agentName: submission.agentName,
    instanceId: submission.instanceId,
    status: submission.status as 'queued' | 'running',
    queuedAt: submission.queuedAt,
    startedAt: submission.startedAt,
    lastEventAt: submission.lastEventAt,
    lastMessage: submission.lastMessage,
    eventCount: submission.eventCount,
    attemptCount: submission.attemptCount,
    detailUrl: activityDetailUrl(submission.submissionId)!,
  };
}

function readSubmissionRow(row: unknown) {
  const record = row as Record<string, unknown>;
  return {
    submissionId: String(record.submission_id),
    kind: String(record.kind),
    agentName: stringOrNull(record.agent_name),
    instanceId: stringOrNull(record.instance_id),
    status: String(record.status),
    queuedAt: String(record.queued_at),
    startedAt: stringOrNull(record.started_at),
    settledAt: stringOrNull(record.settled_at),
    lastEventAt: String(record.last_event_at),
    lastMessage: String(record.last_message),
    eventCount: Number(record.event_count),
    attemptCount: Number(record.attempt_count),
    isError: Boolean(record.is_error),
    detailUrl: activityDetailUrl(String(record.submission_id)),
  };
}

function compareActivityEvents(
  left: ActivityEventRecord,
  right: ActivityEventRecord,
) {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id - right.id
  );
}

function activityDetailUrl(submissionId: string | null) {
  return submissionId
    ? `/activity?submissionId=${encodeURIComponent(submissionId)}`
    : null;
}

function pruneActivityEvents(database: DatabaseSync) {
  database
    .prepare(
      `DELETE FROM activity_events WHERE id NOT IN (
         SELECT id FROM activity_events
         ORDER BY created_at DESC, id DESC LIMIT ?
       );`,
    )
    .run(maxActivityEventRows);
}

function sanitizeRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .filter(([, entry]) => isSafeScalar(entry))
      .map(([key, entry]) => [key, summarizeScalar(entry)])
      .slice(0, 12),
  ) as JsonValue;
}

function summarizeUnknown(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (isSafeScalar(value)) return summarizeScalar(value);
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value)
        .filter((key) => !isSensitiveKey(key))
        .slice(0, 12),
    };
  }
  return { type: typeof value };
}

function summarizeUsage(usage: unknown): JsonValue {
  if (!usage || typeof usage !== 'object') return null;
  const record = usage as Record<string, unknown>;
  return {
    totalTokens: readNumber(record.totalTokens),
    inputTokens: readNumber(record.input ?? record.inputTokens),
    outputTokens: readNumber(record.output ?? record.outputTokens),
    cacheReadTokens: readNumber(record.cacheRead),
    cacheWriteTokens: readNumber(record.cacheWrite),
    cost: summarizeCost(record.cost),
  };
}

function summarizeCost(cost: unknown): JsonValue {
  if (!cost || typeof cost !== 'object') return null;
  const record = cost as Record<string, unknown>;
  return {
    input: readNumber(record.input),
    output: readNumber(record.output),
    cacheRead: readNumber(record.cacheRead),
    cacheWrite: readNumber(record.cacheWrite),
    total: readNumber(record.total),
  };
}

function summarizeError(error: unknown): JsonValue {
  return {
    type:
      error && typeof error === 'object' && 'name' in error
        ? String((error as { name?: unknown }).name)
        : 'Error',
    message: sanitizeMessage(errorMessage(error)),
  };
}

function parseJson(value: string): JsonValue | null {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return { type: 'parse-error' };
  }
}

function sanitizeMessage(value: string) {
  if (looksSensitive(value)) return redacted;
  return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}

function summarizeScalar(value: string | number | boolean | null): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (looksSensitive(value)) return redacted;
  return {
    type: 'string',
    length: value.length,
    preview: value.length > 80 ? `${value.slice(0, 77)}...` : value,
  };
}

function isSafeScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isSensitiveKey(key: string) {
  return /token|secret|password|api[_-]?key|authorization|credential|cookie/i.test(
    key,
  );
}

function looksSensitive(value: string) {
  return (
    /bearer\s+[a-z0-9._-]+/i.test(value) ||
    /(api[_-]?key|token|secret|password)=/i.test(value) ||
    /[a-z0-9+/=]{40,}/i.test(value)
  );
}

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedIdentifier(value: string | null) {
  return value ? value.slice(0, 200) : null;
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function formatDuration(ms: number) {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}
