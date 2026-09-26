import { type FlueObservation, type JsonValue } from '@flue/runtime';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { redactSensitiveText } from '../../lib/redaction';
import { openDb } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import type { ActivityEventRecord } from './activity-types';
import {
  projectPrReviewPerformance,
  type PrReviewPerformanceProjection,
} from './pr-review-performance';

export type { ActivityEventRecord } from './activity-types';
export type { PrReviewPerformanceProjection } from './pr-review-performance';

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

const maxActivityEventRows = 5_000;
const maxActivityContentBytesPerEvent = 64 * 1_024;
const maxActivityContentBytesPerSubmission = 512 * 1_024;
const maxActivityContentBytesGlobally = 16 * 1_024 * 1_024;
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
  const database = openDb(paths.neondeckDatabase);
  const createdAt = event.timestamp ?? new Date().toISOString();
  let transactionOpen = false;

  try {
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;
    // Make the row that this event will occupy available before calculating
    // content budgets, so content removed at the retention boundary can fund
    // the incoming task detail in the same transaction.
    if (activityEventWillBeRetained(database, createdAt)) {
      pruneActivityEvents(database, createdAt, maxActivityEventRows - 1);
    }
    const contentBudget = remainingActivityContentBytes(database, event);
    const summary = withCorrelationMetadata(
      event,
      summarizeObservation(event, contentBudget),
    );
    const contentBytes = activitySummaryContentBytes(event, summary.summary);
    database
      .prepare(
        `
        INSERT INTO activity_events (
          submission_id, agent_name, instance_id, conversation_id,
          event_type, event_index, level, message, name,
          operation_kind, operation_id, duration_ms, is_error,
          summary_json, content_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
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
        contentBytes,
        createdAt,
      );
    updateSubmissionProjection(database, event, summary.message, createdAt);
    incrementActivityContentCounters(
      database,
      event.submissionId,
      contentBytes,
      createdAt,
    );
    pruneActivityEvents(database, createdAt);
    database.exec('COMMIT;');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

function remainingActivityContentBytes(
  database: DatabaseSync,
  event: FlueObservation,
) {
  const hasInspectableContent =
    event.type === 'task_start' ||
    (event.type === 'task' && typeof event.result === 'string');
  if (!hasInspectableContent) return maxActivityContentBytesPerEvent;

  const globalRemaining =
    maxActivityContentBytesGlobally -
    retainedActivityContentBytes(database, 'global');
  const submissionRemaining = event.submissionId
    ? maxActivityContentBytesPerSubmission -
      retainedActivityContentBytes(
        database,
        activitySubmissionContentScope(event.submissionId),
      )
    : maxActivityContentBytesPerSubmission;
  return Math.max(
    0,
    Math.min(
      maxActivityContentBytesPerEvent,
      globalRemaining,
      submissionRemaining,
    ),
  );
}

function retainedActivityContentBytes(database: DatabaseSync, scope: string) {
  const row = database
    .prepare(
      `SELECT content_bytes FROM activity_content_counters WHERE scope = ?;`,
    )
    .get(scope) as { content_bytes?: unknown } | undefined;
  return typeof row?.content_bytes === 'number' ? row.content_bytes : 0;
}

function activityEventWillBeRetained(
  database: DatabaseSync,
  createdAt: string,
) {
  const cutoff = database
    .prepare(
      `SELECT created_at FROM activity_events
       ORDER BY created_at DESC, id DESC
       LIMIT 1 OFFSET ?;`,
    )
    .get(maxActivityEventRows - 1) as { created_at?: unknown } | undefined;
  return (
    typeof cutoff?.created_at !== 'string' || createdAt >= cutoff.created_at
  );
}

function activitySummaryContentBytes(
  event: FlueObservation,
  summary: JsonValue,
) {
  const record = objectRecord(summary);
  const content =
    event.type === 'task_start'
      ? record?.prompt
      : event.type === 'task'
        ? record?.result
        : undefined;
  return typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : 0;
}

function activitySubmissionContentScope(submissionId: string) {
  return `submission:${submissionId}`;
}

function incrementActivityContentCounters(
  database: DatabaseSync,
  submissionId: string | undefined,
  contentBytes: number,
  updatedAt: string,
) {
  if (contentBytes <= 0) return;
  adjustActivityContentCounter(database, 'global', contentBytes, updatedAt);
  if (submissionId) {
    adjustActivityContentCounter(
      database,
      activitySubmissionContentScope(submissionId),
      contentBytes,
      updatedAt,
    );
  }
}

function adjustActivityContentCounter(
  database: DatabaseSync,
  scope: string,
  delta: number,
  updatedAt: string,
) {
  database
    .prepare(
      `INSERT INTO activity_content_counters (scope, content_bytes, updated_at)
       VALUES (?, MAX(0, ?), ?)
       ON CONFLICT(scope) DO UPDATE SET
         content_bytes = MAX(0, activity_content_counters.content_bytes + ?),
         updated_at = MAX(activity_content_counters.updated_at, excluded.updated_at);`,
    )
    .run(scope, delta, updatedAt, delta);
}

export async function readActivityObservability(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });

  try {
    const recentEvents = database
      .prepare(
        `SELECT id, submission_id, agent_name, instance_id, conversation_id,
                event_type, event_index, level, message, name, operation_kind,
                operation_id, duration_ms, is_error,
                CASE WHEN event_type IN ('task_start', 'task')
                       AND json_valid(summary_json)
                  THEN json_remove(summary_json, '$.prompt', '$.result')
                  ELSE summary_json
                END AS summary_json,
                created_at
         FROM activity_events
         ORDER BY created_at DESC, id DESC LIMIT 120;`,
      )
      .all()
      .map(readActivityEventRow)
      .map(withoutActivityEventContent);
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

function summarizeObservation(
  event: FlueObservation,
  contentBudget = maxActivityContentBytesPerEvent,
): {
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
    case 'task_start': {
      const prompt = sanitizeActivityContent(event.prompt, contentBudget);
      return activitySummary(
        `Task ${event.taskId} started.`,
        event.agent ?? null,
        false,
        compactJsonRecord({
          taskId: event.taskId,
          agent: event.agent ?? null,
          prompt: prompt.value,
          promptTruncated: prompt.truncated,
          promptOmittedReason: prompt.omittedReason,
          ...taskPromptMetadata(event.prompt),
        }),
      );
    }
    case 'task': {
      const result =
        typeof event.result === 'string'
          ? sanitizeActivityContent(event.result, contentBudget)
          : null;
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
          result: result?.value,
          resultTruncated: result?.truncated,
          resultOmittedReason: result?.omittedReason,
          ...taskResultMetadata(event.result),
        }),
        null,
        event.durationMs,
      );
    }
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

function sanitizeActivityContent(value: string, maxBytes: number) {
  const sanitized = redactSensitiveText(value);
  if (Buffer.byteLength(sanitized, 'utf8') <= maxBytes) {
    return { value: sanitized, truncated: false } as const;
  }
  const suffix = '\n\n[truncated]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (maxBytes <= suffixBytes) {
    return {
      value: undefined,
      truncated: true,
      omittedReason: 'retention_limit',
    } as const;
  }
  return {
    value: `${utf8Prefix(sanitized, maxBytes - suffixBytes)}${suffix}`,
    truncated: true,
  } as const;
}

function utf8Prefix(value: string, maxBytes: number) {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end =
      middle > 0 && isHighSurrogate(value.charCodeAt(middle - 1))
        ? middle - 1
        : middle;
    if (Buffer.byteLength(value.slice(0, end), 'utf8') <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const end =
    low > 0 && isHighSurrogate(value.charCodeAt(low - 1)) ? low - 1 : low;
  return value.slice(0, end);
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
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

function withoutActivityEventContent(event: ActivityEventRecord) {
  const summary = objectRecord(event.summary);
  if (!summary || (!('prompt' in summary) && !('result' in summary))) {
    return event;
  }
  const { prompt: _prompt, result: _result, ...metadata } = summary;
  return { ...event, summary: metadata as JsonValue };
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

function pruneActivityEvents(
  database: DatabaseSync,
  updatedAt: string,
  retainedRows = maxActivityEventRows,
) {
  const pruned = database
    .prepare(
      `DELETE FROM activity_events WHERE id NOT IN (
         SELECT id FROM activity_events
         ORDER BY created_at DESC, id DESC LIMIT ?
       ) RETURNING submission_id, content_bytes;`,
    )
    .all(retainedRows) as Array<Record<string, unknown>>;
  let globalBytes = 0;
  const submissionBytes = new Map<string, number>();
  for (const row of pruned) {
    const contentBytes = Number(row.content_bytes);
    if (!Number.isFinite(contentBytes) || contentBytes <= 0) continue;
    globalBytes += contentBytes;
    if (typeof row.submission_id === 'string') {
      submissionBytes.set(
        row.submission_id,
        (submissionBytes.get(row.submission_id) ?? 0) + contentBytes,
      );
    }
  }
  if (globalBytes > 0) {
    adjustActivityContentCounter(database, 'global', -globalBytes, updatedAt);
  }
  for (const [submissionId, contentBytes] of submissionBytes) {
    adjustActivityContentCounter(
      database,
      activitySubmissionContentScope(submissionId),
      -contentBytes,
      updatedAt,
    );
  }
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
