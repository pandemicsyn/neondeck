import { randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { asJsonValue } from '../../lib/action-result';
import { collectValidRowsInBatches, openDb, parseRow } from '../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import type { WorkflowSummaryRecord } from './types';
import * as v from 'valibot';
import {
  appStateJsonValueSchema,
  kiloTaskSummarySchema,
  workflowSummaryRowSchema,
} from './schemas';

export async function addWorkflowSummary(
  input: {
    id?: string;
    signal?: AbortSignal;
    workflow: string;
    runId?: string;
    status: string;
    summary?: unknown;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  input.signal?.throwIfAborted();
  const now = new Date().toISOString();
  const summary =
    input.summary === undefined ? null : asJsonValue(input.summary);
  if (input.id) {
    const existing = databaseWorkflowSummary(input.id, paths);
    if (existing) return existing;
  }
  const record: WorkflowSummaryRecord = {
    id: input.id ?? randomUUID(),
    workflow: input.workflow,
    runId: input.runId ?? null,
    status: input.status,
    summary,
    createdAt: now,
    updatedAt: now,
  };
  const database = openDb(paths.neondeckDatabase);

  try {
    input.signal?.throwIfAborted();
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

function databaseWorkflowSummary(id: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM workflow_summaries WHERE id = ? LIMIT 1;')
      .get(id.trim());
    return row ? readWorkflowSummaryRow(row) : null;
  } finally {
    database.close();
  }
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
    return collectValidRowsInBatches(
      100,
      (limit, offset) =>
        database
          .prepare(
            `SELECT *
             FROM workflow_summaries
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?;`,
          )
          .all(limit, offset),
      safeWorkflowSummaryRow,
    );
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
    const rows = collectValidRowsInBatches(
      200,
      (limit, offset) =>
        database
          .prepare(
            `SELECT *
             FROM workflow_summaries
             WHERE workflow = ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?;`,
          )
          .all(workflow, limit, offset),
      safeWorkflowSummaryRow,
    );
    return (
      rows.find((row) => {
        const summary = v.safeParse(kiloTaskSummarySchema, row.summary);
        return summary.success && summary.output.kiloTaskId === kiloTaskId;
      }) ?? null
    );
  } finally {
    database.close();
  }
}

function readWorkflowSummaryRow(
  row: Record<string, SQLOutputValue>,
): WorkflowSummaryRecord {
  const record = parseRow(
    row,
    workflowSummaryRowSchema,
    'Invalid workflow summary',
  );
  return {
    id: record.id,
    workflow: record.workflow,
    runId: record.run_id,
    status: record.status,
    summary:
      record.summary_json !== null
        ? v.parse(appStateJsonValueSchema, JSON.parse(record.summary_json))
        : null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function safeWorkflowSummaryRow(row: Record<string, SQLOutputValue>) {
  try {
    return [readWorkflowSummaryRow(row)];
  } catch {
    return [];
  }
}
