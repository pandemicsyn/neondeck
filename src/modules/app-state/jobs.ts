import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import type { JobRecord } from './types';

export async function listJobs(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

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
  const database = openDb(paths.neondeckDatabase);

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
  const database = openDb(paths.neondeckDatabase);

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
  const database = openDb(paths.neondeckDatabase);

  try {
    database.prepare('DELETE FROM jobs WHERE id = ?;').run(id);
  } finally {
    database.close();
  }
}

export async function setJobEnabled(
  id: string,
  enabled: boolean,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const existing = readJob(paths, id);
  if (!existing) return undefined;

  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        UPDATE jobs
        SET enabled = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(enabled ? 1 : 0, now, id);
  } finally {
    database.close();
  }

  return readJob(paths, id);
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
  const database = openDb(paths.neondeckDatabase);

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

function readJob(paths: RuntimePaths, id: string): JobRecord | undefined {
  const database = openDb(paths.neondeckDatabase);

  try {
    const row = database.prepare('SELECT * FROM jobs WHERE id = ?;').get(id);
    return row ? readJobRow(row) : undefined;
  } finally {
    database.close();
  }
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
        ? JSON.parse(record.config_json)
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
        ? JSON.parse(record.last_result_json)
        : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}
