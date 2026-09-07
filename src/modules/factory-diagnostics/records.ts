import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { writebackEffectSchema } from '../../../shared/factory-writeback';
import {
  workSchema,
  revisionSchema,
  releaseSchema,
} from '../../../shared/factory';
import {
  codingRunRecordSchema,
  codingRunEventSchema,
} from '../../../shared/coding-runs';
import { deliveryPipelineSchema } from '../../../shared/factory-delivery';
import { decodePlanningEffect } from '../factory';
import { openDb, withTransaction } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';

export const sourceLimit = 200;
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const time = v.pipe(v.string(), v.isoTimestamp());
// A read projection of persisted intent metadata; deliberately never loads prompts/context.
const planningSchema = v.strictObject({
  id: label,
  workId: label,
  createdAt: time,
  stage: v.picklist(['triage', 'planner', 'completed', 'failed']),
  submissionId: v.nullable(label),
  triageSubmissionId: v.nullable(label),
});
const auditSchema = v.strictObject({
  id: natural,
  action: label,
  actor: label,
  createdAt: time,
});
export class DiagnosticsError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}
export function diagnosticRead<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (v.isValiError(error) || error instanceof SyntaxError)
      throw new DiagnosticsError(
        503,
        'Retained diagnostic records are unavailable or invalid. Check the local database and refresh.',
      );
    throw error;
  }
}
export function withDiagnosticDatabase<T>(
  paths: Pick<RuntimePaths, 'neondeckDatabase'>,
  read: (db: DatabaseSync) => T,
) {
  // Opening read-only also prevents doctor from creating an empty database in a wrong home.
  const db = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return diagnosticRead(() => withTransaction(db, () => read(db)));
  } finally {
    db.close();
  }
}
function jsonRows<T>(
  db: DatabaseSync,
  sql: string,
  schema: v.GenericSchema<unknown, T>,
  workId: string,
) {
  return db
    .prepare(sql)
    .all(workId, sourceLimit + 1)
    .map((row) => {
      const text = v.parse(
        v.pipe(v.string(), v.maxLength(2_000_000)),
        row.record,
      );
      return v.parse(schema, JSON.parse(text));
    });
}
export function readTaskRecords(db: DatabaseSync, workId: string) {
  const row = db
    .prepare('SELECT record FROM factory_work_items WHERE id=?')
    .get(workId);
  if (!row) throw new DiagnosticsError(404, 'Task not found.');
  const work = v.parse(workSchema, JSON.parse(v.parse(v.string(), row.record)));
  if (work.id !== workId)
    throw new DiagnosticsError(503, 'Task identity is inconsistent.');
  const writeback = jsonRows(
    db,
    "SELECT record FROM factory_writeback_records WHERE work_id=? AND kind='effect' ORDER BY rowid DESC LIMIT ?",
    writebackEffectSchema,
    workId,
  );
  const revisions = jsonRows(
    db,
    'SELECT record FROM factory_spec_revisions WHERE work_id=? ORDER BY rowid DESC LIMIT ?',
    revisionSchema,
    workId,
  );
  const releases = jsonRows(
    db,
    'SELECT record FROM factory_releases WHERE work_id=? ORDER BY rowid DESC LIMIT ?',
    releaseSchema,
    workId,
  );
  const runs = jsonRows(
    db,
    'SELECT record_json AS record FROM coding_runs WHERE work_item_id=? ORDER BY sequence DESC LIMIT ?',
    codingRunRecordSchema,
    workId,
  );
  const deliveries = jsonRows(
    db,
    'SELECT record_json AS record FROM factory_delivery_pipelines WHERE work_item_id=? ORDER BY sequence DESC LIMIT ?',
    deliveryPipelineSchema,
    workId,
  );
  const audit = db
    .prepare(
      'SELECT id,action,actor,created_at AS createdAt FROM factory_audit WHERE work_id=? ORDER BY id DESC LIMIT ?',
    )
    .all(workId, sourceLimit + 1)
    .map((r) => v.parse(auditSchema, r));
  const planning = db
    .prepare(
      `SELECT id,work_id AS workId,json_extract(record,'$.createdAt') AS createdAt,json_extract(record,'$.stage') AS stage,json_extract(record,'$.submissionId') AS submissionId,json_extract(record,'$.triageSubmissionId') AS triageSubmissionId FROM factory_planning_intents WHERE work_id=? ORDER BY rowid DESC LIMIT ?`,
    )
    .all(workId, sourceLimit + 1)
    .map((r) => v.parse(planningSchema, r));
  const receipts = db
    .prepare(
      'SELECT e.id,e.intent_id AS intentId,e.record FROM factory_planning_effects e JOIN factory_planning_intents i ON i.id=e.intent_id WHERE i.work_id=? ORDER BY e.rowid DESC LIMIT ?',
    )
    .all(workId, sourceLimit + 1)
    .map((r) => ({
      id: v.parse(label, r.id),
      intentId: v.parse(label, r.intentId),
      effect: decodePlanningEffect(r.record),
    }));
  const events = db
    .prepare(
      'SELECT e.sequence,e.run_id AS runId,e.version,e.type,e.status,e.created_at AS createdAt FROM coding_run_events e JOIN coding_runs r ON e.run_id=r.run_id WHERE r.work_item_id=? ORDER BY e.sequence DESC LIMIT ?',
    )
    .all(workId, sourceLimit + 1)
    .map((r) => v.parse(codingRunEventSchema, r));
  if (
    revisions.some((r) => r.workId !== workId) ||
    releases.some((r) => r.workId !== workId) ||
    runs.some((r) => r.snapshot.workItemId !== workId) ||
    deliveries.some((r) => r.workItemId !== workId)
  )
    throw new DiagnosticsError(503, 'Task record binding is inconsistent.');
  const truncated = [
    writeback,
    revisions,
    releases,
    runs,
    deliveries,
    audit,
    planning,
    receipts,
    events,
  ].some((r) => r.length > sourceLimit);
  return {
    work,
    writeback: writeback.slice(0, sourceLimit),
    revisions: revisions.slice(0, sourceLimit),
    releases: releases.slice(0, sourceLimit),
    runs: runs.slice(0, sourceLimit),
    deliveries: deliveries.slice(0, sourceLimit),
    audit: audit.slice(0, sourceLimit),
    planning: planning.slice(0, sourceLimit),
    receipts: receipts.slice(0, sourceLimit),
    events: events.slice(0, sourceLimit),
    truncated,
  };
}
export type TaskRecords = ReturnType<typeof readTaskRecords>;
export function readTaskIds(db: DatabaseSync) {
  return db
    .prepare('SELECT id FROM factory_work_items ORDER BY rowid DESC LIMIT 51')
    .all()
    .map((r) => v.parse(label, r.id));
}

/** Health never reconstructs history. It reads only current coordination records. */
export function readTaskHealthRecords(
  db: DatabaseSync,
  workId: string,
): TaskRecords {
  const row = db
    .prepare('SELECT record FROM factory_work_items WHERE id=?')
    .get(workId);
  if (!row) throw new DiagnosticsError(404, 'Task not found.');
  const work = v.parse(workSchema, JSON.parse(v.parse(v.string(), row.record)));
  if (work.id !== workId)
    throw new DiagnosticsError(503, 'Task identity is inconsistent.');
  function current<T>(sql: string, schema: v.GenericSchema<unknown, T>) {
    return db
      .prepare(sql)
      .all(workId)
      .map((r) =>
        v.parse(
          schema,
          JSON.parse(
            v.parse(v.pipe(v.string(), v.maxLength(2_000_000)), r.record),
          ),
        ),
      );
  }
  const runs = current(
    'SELECT record_json AS record FROM coding_runs WHERE work_item_id=? ORDER BY sequence DESC LIMIT 1',
    codingRunRecordSchema,
  );
  const deliveries = current(
    "SELECT record_json AS record FROM factory_delivery_pipelines WHERE work_item_id=? AND json_extract(record_json,'$.outcome') IS NULL ORDER BY sequence DESC LIMIT 2",
    deliveryPipelineSchema,
  );
  const writeback = current(
    "SELECT record FROM factory_writeback_records WHERE work_id=? AND kind='effect' AND json_extract(record,'$.state') NOT IN ('sent','cancelled') ORDER BY rowid DESC LIMIT 51",
    writebackEffectSchema,
  );
  const planning = db
    .prepare(
      `SELECT id,work_id AS workId,json_extract(record,'$.createdAt') AS createdAt,json_extract(record,'$.stage') AS stage,json_extract(record,'$.submissionId') AS submissionId,json_extract(record,'$.triageSubmissionId') AS triageSubmissionId FROM factory_planning_intents WHERE work_id=? AND json_extract(record,'$.stage') IN ('triage','planner') ORDER BY rowid DESC LIMIT 2`,
    )
    .all(workId)
    .map((r) => v.parse(planningSchema, r));
  if (
    runs.some((r) => r.snapshot.workItemId !== workId) ||
    deliveries.some((r) => r.workItemId !== workId) ||
    writeback.some((r) => r.workId !== workId)
  )
    throw new DiagnosticsError(503, 'Task record binding is inconsistent.');
  return {
    work,
    runs,
    deliveries: deliveries.slice(0, 1),
    writeback: writeback.slice(0, 50),
    planning: planning.slice(0, 1),
    revisions: [],
    releases: [],
    audit: [],
    receipts: [],
    events: [],
    truncated:
      deliveries.length > 1 || writeback.length > 50 || planning.length > 1,
  };
}
