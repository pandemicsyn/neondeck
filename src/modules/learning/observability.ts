import { type FlueObservation, type JsonValue } from '@flue/runtime';
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

const maxActivityEventRows = 5_000;
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
  const summary = summarizeObservation(event);
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
    case 'tool':
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
        },
      );
    case 'task':
      return activitySummary(
        `Task ${event.taskId} ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        event.agent ?? null,
        event.isError,
        { taskId: event.taskId, agent: event.agent ?? null },
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
    inputTokens: readNumber(record.inputTokens),
    outputTokens: readNumber(record.outputTokens),
    cost: summarizeUnknown(record.cost),
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
