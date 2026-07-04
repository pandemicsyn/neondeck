import { type FlueObservation, type JsonValue } from '@flue/runtime';
import { DatabaseSync } from 'node:sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import { flueRunInspectionUrl, readLocalApiToken } from '../../local-api-auth';

export type WorkflowEventRecord = {
  id: number;
  runId: string | null;
  workflow: string | null;
  eventType: string;
  eventIndex: number | null;
  level: string | null;
  message: string;
  name: string | null;
  operationKind: string | null;
  operationId: string | null;
  durationMs: number | null;
  isError: boolean;
  summary: JsonValue | null;
  createdAt: string;
  runUrl: string | null;
};

export type WorkflowObservabilitySnapshot = {
  ok: true;
  action: 'workflow_observability_read';
  activeRuns: Array<{
    runId: string;
    workflow: string;
    startedAt: string;
    lastEventAt: string;
    lastMessage: string;
    eventCount: number;
    runUrl: string;
  }>;
  recentFailures: WorkflowEventRecord[];
  recentData: WorkflowEventRecord[];
  recentLogs: WorkflowEventRecord[];
  recentTools: WorkflowEventRecord[];
  recentOperations: WorkflowEventRecord[];
  recentEvents: WorkflowEventRecord[];
  fetchedAt: string;
};

const maxWorkflowEventRows = 5_000;
const redacted = '[redacted]';
const persistedEventTypes = new Set([
  'run_start',
  'run_resume',
  'run_end',
  'operation_start',
  'operation',
  'tool_start',
  'tool',
  'turn',
  'log',
]);

export async function recordFlueObservation(
  event: FlueObservation,
  paths = runtimePaths(),
) {
  if (!persistedEventTypes.has(event.type)) return;
  await ensureRuntimeHome(paths);
  const summary = summarizeObservation(event);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const runId = readString(event, 'runId');
    const createdAt = event.timestamp ?? new Date().toISOString();
    database
      .prepare(
        `
        INSERT INTO workflow_events (
          run_id,
          workflow,
          event_type,
          event_index,
          level,
          message,
          name,
          operation_kind,
          operation_id,
          duration_ms,
          is_error,
          summary_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        runId,
        workflowName(event),
        event.type,
        typeof event.eventIndex === 'number' ? event.eventIndex : null,
        readString(event, 'level'),
        summary.message,
        summary.name,
        summary.operationKind,
        summary.operationId,
        summary.durationMs,
        summary.isError ? 1 : 0,
        JSON.stringify(summary.summary),
        createdAt,
      );
    updateRunProjection(database, event, summary.message, createdAt);
    pruneWorkflowEvents(database);
  } finally {
    database.close();
  }
}

export async function readWorkflowObservability(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const localApiToken = await readLocalApiToken(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

  try {
    const recentEvents = database
      .prepare(
        `
        SELECT *
        FROM workflow_events
        ORDER BY created_at DESC, id DESC
        LIMIT 120;
      `,
      )
      .all()
      .map((row) => readWorkflowEventRow(row, localApiToken));

    const activeRuns = database
      .prepare(
        `
        SELECT *
        FROM workflow_run_observations
        WHERE status = 'active'
        ORDER BY last_event_at DESC
        LIMIT 10;
      `,
      )
      .all()
      .map((row) => readActiveRunRow(row, localApiToken));

    return {
      ok: true,
      action: 'workflow_observability_read',
      activeRuns,
      recentFailures: recentEvents
        .filter((event) => event.eventType === 'run_end' && event.isError)
        .slice(0, 10),
      recentData: recentEvents
        .filter((event) => event.eventType === 'run_end' && !event.isError)
        .slice(0, 10),
      recentLogs: recentEvents
        .filter((event) => event.eventType === 'log')
        .slice(0, 10),
      recentTools: recentEvents
        .filter(
          (event) =>
            event.eventType === 'tool' || event.eventType === 'tool_start',
        )
        .slice(0, 10),
      recentOperations: recentEvents
        .filter(
          (event) =>
            event.eventType === 'operation' ||
            event.eventType === 'operation_start',
        )
        .slice(0, 10),
      recentEvents: recentEvents.slice(0, 20),
      fetchedAt: new Date().toISOString(),
    } satisfies WorkflowObservabilitySnapshot;
  } finally {
    database.close();
  }
}

function summarizeObservation(event: FlueObservation) {
  switch (event.type) {
    case 'run_start':
      return {
        message: `Started workflow ${event.workflowName}.`,
        name: event.workflowName,
        operationKind: null,
        operationId: null,
        durationMs: null,
        isError: false,
        summary: {
          workflowName: event.workflowName,
          input: summarizeUnknown(event.input),
        },
      };
    case 'run_resume':
      return {
        message: `Resumed workflow ${event.workflowName}.`,
        name: event.workflowName,
        operationKind: null,
        operationId: null,
        durationMs: null,
        isError: false,
        summary: { workflowName: event.workflowName },
      };
    case 'run_end':
      return {
        message: event.isError
          ? `Workflow failed after ${formatDuration(event.durationMs)}.`
          : `Workflow completed in ${formatDuration(event.durationMs)}.`,
        name: workflowName(event),
        operationKind: null,
        operationId: null,
        durationMs: event.durationMs,
        isError: event.isError,
        summary: {
          durationMs: event.durationMs,
          error: event.isError ? summarizeError(event.error) : null,
          result: summarizeUnknown(event.result),
        },
      };
    case 'log':
      return {
        message: sanitizeMessage(event.message),
        name: null,
        operationKind: null,
        operationId: readString(event, 'operationId'),
        durationMs: null,
        isError: event.level === 'error',
        summary: {
          level: event.level,
          attributes: sanitizeRecord(event.attributes),
        },
      };
    case 'operation_start':
      return {
        message: `${event.operationKind} operation started.`,
        name: null,
        operationKind: event.operationKind,
        operationId: event.operationId,
        durationMs: null,
        isError: false,
        summary: { operationKind: event.operationKind },
      };
    case 'operation':
      return {
        message: `${event.operationKind} operation ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        name: null,
        operationKind: event.operationKind,
        operationId: event.operationId,
        durationMs: event.durationMs,
        isError: event.isError,
        summary: {
          operationKind: event.operationKind,
          usage: summarizeUsage(event.usage),
          error: event.isError ? summarizeError(event.error) : null,
        },
      };
    case 'tool_start':
      return {
        message: `Tool ${event.toolName} started.`,
        name: event.toolName,
        operationKind: null,
        operationId: readString(event, 'operationId'),
        durationMs: null,
        isError: false,
        summary: {
          toolName: event.toolName,
          origin: event.origin ?? null,
          toolType: event.toolType ?? null,
          args: summarizeUnknown(event.args),
        },
      };
    case 'tool':
      return {
        message: `Tool ${event.toolName} ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        name: event.toolName,
        operationKind: null,
        operationId: readString(event, 'operationId'),
        durationMs: event.durationMs,
        isError: event.isError,
        summary: {
          toolName: event.toolName,
          error: event.errorInfo?.message
            ? summarizeError(event.errorInfo)
            : null,
          result: summarizeUnknown(event.effectiveResult ?? event.result),
        },
      };
    case 'turn':
      return {
        message: `Model turn ${event.isError ? 'failed' : 'completed'} in ${formatDuration(event.durationMs)}.`,
        name: event.request.requestedModel,
        operationKind: null,
        operationId: readString(event, 'operationId'),
        durationMs: event.durationMs,
        isError: event.isError,
        summary: {
          providerId: event.request.providerId,
          requestedModel: event.request.requestedModel,
          responseModel: event.response.responseModel ?? null,
          finishReason: event.response.finishReason ?? null,
          usage: summarizeUsage(event.response.usage),
        },
      };
    default:
      return {
        message: `${event.type} observed.`,
        name: null,
        operationKind: null,
        operationId: readString(event, 'operationId'),
        durationMs: null,
        isError: false,
        summary: { type: event.type },
      };
  }
}

function readWorkflowEventRow(
  row: unknown,
  localApiToken: string | null,
): WorkflowEventRecord {
  const record = row as Record<string, unknown>;
  const runId = typeof record.run_id === 'string' ? record.run_id : null;
  return {
    id: Number(record.id),
    runId,
    workflow: typeof record.workflow === 'string' ? record.workflow : null,
    eventType: String(record.event_type),
    eventIndex:
      typeof record.event_index === 'number' ? record.event_index : null,
    level: typeof record.level === 'string' ? record.level : null,
    message: String(record.message),
    name: typeof record.name === 'string' ? record.name : null,
    operationKind:
      typeof record.operation_kind === 'string' ? record.operation_kind : null,
    operationId:
      typeof record.operation_id === 'string' ? record.operation_id : null,
    durationMs:
      typeof record.duration_ms === 'number' ? record.duration_ms : null,
    isError: Boolean(record.is_error),
    summary:
      typeof record.summary_json === 'string'
        ? parseJson(record.summary_json)
        : null,
    createdAt: String(record.created_at),
    runUrl: runId ? flueRunInspectionUrl(runId, localApiToken) : null,
  };
}

function readActiveRunRow(row: unknown, localApiToken: string | null) {
  const record = row as Record<string, unknown>;
  const runId = String(record.run_id);
  return {
    runId,
    workflow: String(record.workflow),
    startedAt: String(record.started_at),
    lastEventAt: String(record.last_event_at),
    lastMessage: String(record.last_message),
    eventCount: Number(record.event_count),
    runUrl: flueRunInspectionUrl(runId, localApiToken),
  };
}

function updateRunProjection(
  database: DatabaseSync,
  event: FlueObservation,
  message: string,
  createdAt: string,
) {
  const runId = readString(event, 'runId');
  if (!runId) return;
  const workflow = workflowName(event) ?? 'workflow';

  if (event.type === 'run_start' || event.type === 'run_resume') {
    database
      .prepare(
        `
        INSERT INTO workflow_run_observations (
          run_id,
          workflow,
          status,
          started_at,
          last_event_at,
          last_message,
          event_count,
          is_error,
          updated_at
        )
        VALUES (?, ?, 'active', ?, ?, ?, 1, 0, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          workflow = excluded.workflow,
          status = 'active',
          last_event_at = excluded.last_event_at,
          last_message = excluded.last_message,
          event_count = workflow_run_observations.event_count + 1,
          updated_at = excluded.updated_at;
      `,
      )
      .run(runId, workflow, createdAt, createdAt, message, createdAt);
    return;
  }

  if (event.type === 'run_end') {
    database
      .prepare(
        `
        INSERT INTO workflow_run_observations (
          run_id,
          workflow,
          status,
          started_at,
          ended_at,
          last_event_at,
          last_message,
          event_count,
          duration_ms,
          is_error,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          ended_at = excluded.ended_at,
          last_event_at = excluded.last_event_at,
          last_message = excluded.last_message,
          event_count = workflow_run_observations.event_count + 1,
          duration_ms = excluded.duration_ms,
          is_error = excluded.is_error,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        runId,
        workflow,
        event.isError ? 'failed' : 'completed',
        readString(event, 'startedAt') ?? createdAt,
        createdAt,
        createdAt,
        message,
        event.durationMs,
        event.isError ? 1 : 0,
        createdAt,
      );
    return;
  }

  database
    .prepare(
      `
      UPDATE workflow_run_observations
      SET
        last_event_at = ?,
        last_message = ?,
        event_count = event_count + 1,
        updated_at = ?
      WHERE run_id = ?;
    `,
    )
    .run(createdAt, message, createdAt, runId);
}

function pruneWorkflowEvents(database: DatabaseSync) {
  database
    .prepare(
      `
      DELETE FROM workflow_events
      WHERE id NOT IN (
        SELECT id
        FROM workflow_events
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      );
    `,
    )
    .run(maxWorkflowEventRows);
}

function workflowName(event: FlueObservation) {
  if ('workflowName' in event && typeof event.workflowName === 'string') {
    return event.workflowName;
  }
  if ('workflow' in event && typeof event.workflow === 'string') {
    return event.workflow;
  }
  return null;
}

function readString(event: FlueObservation, key: string) {
  const value = (event as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
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
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
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

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function formatDuration(ms: number) {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
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

function summarizeError(error: unknown): JsonValue {
  const message = errorMessage(error);
  return {
    type:
      error && typeof error === 'object' && 'name' in error
        ? String((error as { name?: unknown }).name)
        : 'Error',
    message: sanitizeMessage(message),
  };
}

function parseJson(value: string): JsonValue | null {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return {
      type: 'parse-error',
      message: 'Stored event summary could not be parsed.',
    };
  }
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
