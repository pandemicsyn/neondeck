import { type JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from './runtime-home';

export type NotificationLevel = 'info' | 'ready' | 'attention' | 'urgent';

export type NotificationRecord = {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  source: string | null;
  sourceId: string | null;
  data: JsonValue | null;
  readAt: string | null;
  resolvedAt: string | null;
  occurrenceCount: number;
  createdAt: string;
  updatedAt: string;
};

export type JobRecord = {
  id: string;
  type: string;
  blueprint: string | null;
  enabled: boolean;
  intervalSeconds: number;
  config: JsonValue | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastMessage: string | null;
  lastResult: JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowSummaryRecord = {
  id: string;
  workflow: string;
  runId: string | null;
  status: string;
  summary: JsonValue | null;
  createdAt: string;
  updatedAt: string;
};

export async function listNotifications(
  paths = runtimePaths(),
  options: { includeResolved?: boolean } = {},
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    return database
      .prepare(
        `
        SELECT *
        FROM notifications
        ${options.includeResolved ? '' : 'WHERE resolved_at IS NULL'}
        ORDER BY updated_at DESC, occurrence_count DESC, created_at DESC
        LIMIT 100;
      `,
      )
      .all()
      .map(readNotificationRow);
  } finally {
    database.close();
  }
}

export async function addNotification(
  input: {
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const source = input.source ?? null;
  const sourceId = input.sourceId ?? null;
  const notification: NotificationRecord = {
    id: randomUUID(),
    level: input.level,
    title: input.title,
    message: input.message,
    source,
    sourceId,
    data: input.data === undefined ? null : asJsonValue(input.data),
    readAt: null,
    resolvedAt: null,
    occurrenceCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const existing =
      source && sourceId
        ? database
            .prepare(
              `
              SELECT *
              FROM notifications
              WHERE source = ?
                AND source_id = ?
                AND resolved_at IS NULL
              ORDER BY created_at DESC
              LIMIT 1;
            `,
            )
            .get(source, sourceId)
        : undefined;

    if (existing) {
      const existingRecord = readNotificationRow(existing);
      database
        .prepare(
          `
          UPDATE notifications
          SET
            level = ?,
            title = ?,
            message = ?,
            data_json = ?,
            read_at = NULL,
            occurrence_count = occurrence_count + 1,
            updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(
          notification.level,
          notification.title,
          notification.message,
          notification.data === null ? null : JSON.stringify(notification.data),
          now,
          existingRecord.id,
        );

      return {
        ...notification,
        id: existingRecord.id,
        createdAt: existingRecord.createdAt,
        occurrenceCount: existingRecord.occurrenceCount + 1,
      };
    }

    database
      .prepare(
        `
        INSERT INTO notifications (
          id,
          level,
          title,
          message,
          source,
          source_id,
          data_json,
          read_at,
          resolved_at,
          occurrence_count,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        notification.id,
        notification.level,
        notification.title,
        notification.message,
        notification.source,
        notification.sourceId,
        notification.data === null ? null : JSON.stringify(notification.data),
        notification.readAt,
        notification.resolvedAt,
        notification.occurrenceCount,
        notification.createdAt,
        notification.updatedAt,
      );
  } finally {
    database.close();
  }

  return notification;
}

export async function markNotificationRead(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        UPDATE notifications
        SET read_at = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, now, id);
  } finally {
    database.close();
  }
}

export async function resolveNotification(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        UPDATE notifications
        SET resolved_at = ?, read_at = COALESCE(read_at, ?), updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, now, now, id);
  } finally {
    database.close();
  }
}

export async function listJobs(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    return database
      .prepare(
        `
        SELECT *
        FROM jobs
        ORDER BY next_run_at ASC, updated_at DESC;
      `,
      )
      .all()
      .map(readJobRow);
  } finally {
    database.close();
  }
}

export async function upsertJob(
  input: {
    id: string;
    type: string;
    blueprint?: string | null;
    enabled: boolean;
    intervalSeconds: number;
    config?: unknown;
    nextRunAt?: string | null;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const existing = readJob(paths, input.id);
  const job: JobRecord = {
    id: input.id,
    type: input.type,
    blueprint: input.blueprint ?? null,
    enabled: input.enabled,
    intervalSeconds: input.intervalSeconds,
    config: input.config === undefined ? null : asJsonValue(input.config),
    nextRunAt: input.nextRunAt ?? existing?.nextRunAt ?? now,
    lastRunAt: existing?.lastRunAt ?? null,
    lastOutcome: existing?.lastOutcome ?? null,
    lastMessage: existing?.lastMessage ?? null,
    lastResult: existing?.lastResult ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        INSERT INTO jobs (
          id,
          type,
          blueprint,
          enabled,
          interval_seconds,
          config_json,
          next_run_at,
          last_run_at,
          last_outcome,
          last_message,
          last_result_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          blueprint = excluded.blueprint,
          enabled = excluded.enabled,
          interval_seconds = excluded.interval_seconds,
          config_json = excluded.config_json,
          next_run_at = excluded.next_run_at,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        job.id,
        job.type,
        job.blueprint,
        job.enabled ? 1 : 0,
        job.intervalSeconds,
        job.config === null ? null : JSON.stringify(job.config),
        job.nextRunAt,
        job.lastRunAt,
        job.lastOutcome,
        job.lastMessage,
        job.lastResult === null ? null : JSON.stringify(job.lastResult),
        job.createdAt,
        job.updatedAt,
      );
  } finally {
    database.close();
  }

  return job;
}

export async function disableStaleScheduleJobs(
  activeJobIds: string[],
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    if (activeJobIds.length === 0) {
      database
        .prepare(
          `
          UPDATE jobs
          SET enabled = 0, updated_at = ?
          WHERE id LIKE 'schedule:%';
        `,
        )
        .run(now);
      return;
    }

    const placeholders = activeJobIds.map(() => '?').join(', ');
    database
      .prepare(
        `
        UPDATE jobs
        SET enabled = 0, updated_at = ?
        WHERE id LIKE 'schedule:%'
          AND id NOT IN (${placeholders});
      `,
      )
      .run(now, ...activeJobIds);
  } finally {
    database.close();
  }
}

export async function deleteJob(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database.prepare('DELETE FROM jobs WHERE id = ?;').run(id);
  } finally {
    database.close();
  }
}

export async function deleteJobsByConfigField(
  field: string,
  value: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const jobs = await listJobs(paths);
  await Promise.all(
    jobs
      .filter(
        (job) =>
          job.config &&
          typeof job.config === 'object' &&
          !Array.isArray(job.config) &&
          (job.config as Record<string, unknown>)[field] === value,
      )
      .map((job) => deleteJob(job.id, paths)),
  );
}

export async function updateJobRun(
  id: string,
  input: {
    outcome: string;
    message: string;
    result?: unknown;
    nextRunAt: string | null;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const result = input.result === undefined ? null : asJsonValue(input.result);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        UPDATE jobs
        SET
          last_run_at = ?,
          last_outcome = ?,
          last_message = ?,
          last_result_json = ?,
          next_run_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        now,
        input.outcome,
        input.message,
        result === null ? null : JSON.stringify(result),
        input.nextRunAt,
        now,
        id,
      );
  } finally {
    database.close();
  }
}

export async function addWorkflowSummary(
  input: {
    workflow: string;
    runId?: string;
    status: string;
    summary?: unknown;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const summary =
    input.summary === undefined ? null : asJsonValue(input.summary);
  const record: WorkflowSummaryRecord = {
    id: randomUUID(),
    workflow: input.workflow,
    runId: input.runId ?? null,
    status: input.status,
    summary,
    createdAt: now,
    updatedAt: now,
  };
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        INSERT INTO workflow_summaries (
          id,
          workflow,
          run_id,
          status,
          summary_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        record.id,
        record.workflow,
        record.runId,
        record.status,
        record.summary === null ? null : JSON.stringify(record.summary),
        record.createdAt,
        record.updatedAt,
      );
  } finally {
    database.close();
  }

  return record;
}

export async function setWorkflowSummaryRunId(
  id: string,
  runId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        UPDATE workflow_summaries
        SET run_id = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(runId, now, id);
  } finally {
    database.close();
  }
}

export async function listWorkflowSummaries(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    return database
      .prepare(
        `
        SELECT *
        FROM workflow_summaries
        ORDER BY created_at DESC
        LIMIT 100;
      `,
      )
      .all()
      .map(readWorkflowSummaryRow);
  } finally {
    database.close();
  }
}

function readJob(paths: RuntimePaths, id: string): JobRecord | undefined {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const row = database.prepare('SELECT * FROM jobs WHERE id = ?;').get(id);
    return row ? readJobRow(row) : undefined;
  } finally {
    database.close();
  }
}

function readWorkflowSummaryRow(row: unknown): WorkflowSummaryRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    workflow: String(record.workflow),
    runId: typeof record.run_id === 'string' ? record.run_id : null,
    status: String(record.status),
    summary:
      typeof record.summary_json === 'string'
        ? (JSON.parse(record.summary_json) as JsonValue)
        : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function readNotificationRow(row: unknown): NotificationRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    level: String(record.level) as NotificationLevel,
    title: String(record.title),
    message: String(record.message),
    source: typeof record.source === 'string' ? record.source : null,
    sourceId: typeof record.source_id === 'string' ? record.source_id : null,
    data:
      typeof record.data_json === 'string'
        ? (JSON.parse(record.data_json) as JsonValue)
        : null,
    readAt: typeof record.read_at === 'string' ? record.read_at : null,
    resolvedAt:
      typeof record.resolved_at === 'string' ? record.resolved_at : null,
    occurrenceCount: Number(record.occurrence_count ?? 1),
    createdAt: String(record.created_at),
    updatedAt:
      typeof record.updated_at === 'string'
        ? record.updated_at
        : String(record.created_at),
  };
}

function readJobRow(row: unknown): JobRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    type: String(record.type),
    blueprint: typeof record.blueprint === 'string' ? record.blueprint : null,
    enabled: Boolean(record.enabled),
    intervalSeconds: Number(record.interval_seconds),
    config:
      typeof record.config_json === 'string'
        ? (JSON.parse(record.config_json) as JsonValue)
        : null,
    nextRunAt:
      typeof record.next_run_at === 'string' ? record.next_run_at : null,
    lastRunAt:
      typeof record.last_run_at === 'string' ? record.last_run_at : null,
    lastOutcome:
      typeof record.last_outcome === 'string' ? record.last_outcome : null,
    lastMessage:
      typeof record.last_message === 'string' ? record.last_message : null,
    lastResult:
      typeof record.last_result_json === 'string'
        ? (JSON.parse(record.last_result_json) as JsonValue)
        : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
