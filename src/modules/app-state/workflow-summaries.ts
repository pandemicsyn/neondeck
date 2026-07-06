import { randomUUID } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import type { WorkflowSummaryRecord } from './types';

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
  const database = openDb(paths.neondeckDatabase);

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
  const database = openDb(paths.neondeckDatabase);

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

export async function updateWorkflowSummary(
  id: string,
  input: {
    status?: string;
    summary?: unknown;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        UPDATE workflow_summaries
        SET
          status = COALESCE(?, status),
          summary_json = COALESCE(?, summary_json),
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        input.status ?? null,
        input.summary === undefined
          ? null
          : JSON.stringify(asJsonValue(input.summary)),
        now,
        id,
      );
    const row = database
      .prepare('SELECT * FROM workflow_summaries WHERE id = ?;')
      .get(id);
    return row ? readWorkflowSummaryRow(row) : undefined;
  } finally {
    database.close();
  }
}

export async function listWorkflowSummaries(paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

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

export async function findWorkflowSummaryByKiloTaskId(
  workflow: string,
  kiloTaskId: string,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

  try {
    const rows = database
      .prepare(
        `
        SELECT *
        FROM workflow_summaries
        WHERE workflow = ?
        ORDER BY created_at DESC
        LIMIT 200;
      `,
      )
      .all(workflow)
      .map(readWorkflowSummaryRow);
    return (
      rows.find((row) => {
        const summary = objectField(row.summary);
        return summary.kiloTaskId === kiloTaskId;
      }) ?? null
    );
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
        ? JSON.parse(record.summary_json)
        : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
