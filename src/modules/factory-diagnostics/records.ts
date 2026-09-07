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
// Keep the legacy metadata projection, but never substitute column identities for JSON.
function planningProjection(alias: string) {
  return `${alias}.id AS columnId,${alias}.work_id AS columnWorkId,
    json_extract(${alias}.record,'$.id') AS id,
    json_extract(${alias}.record,'$.workId') AS workId,
    json_extract(${alias}.record,'$.createdAt') AS createdAt,
    json_extract(${alias}.record,'$.stage') AS stage,
    json_extract(${alias}.record,'$.submissionId') AS submissionId,
    json_extract(${alias}.record,'$.triageSubmissionId') AS triageSubmissionId`;
}
function parsePlanning(row: Record<string, unknown>, workId: string) {
  const { columnId, columnWorkId, ...metadata } = row;
  const intent = v.parse(planningSchema, metadata);
  if (
    intent.id !== columnId ||
    intent.workId !== columnWorkId ||
    intent.workId !== workId
  )
    throw new DiagnosticsError(503, 'Task record binding is inconsistent.');
  return intent;
}
function planningCandidates(db: DatabaseSync, workId: string) {
  return db
    .prepare(
      `SELECT ${planningProjection('i')} FROM factory_planning_intents i WHERE i.work_id=? ORDER BY i.rowid DESC LIMIT ?`,
    )
    .all(workId, sourceLimit + 1)
    .map((row) => parsePlanning(row, workId));
}
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
function parseRecord<T>(
  row: Record<string, unknown>,
  schema: v.GenericSchema<unknown, T>,
) {
  const text = v.parse(v.pipe(v.string(), v.maxLength(2_000_000)), row.record);
  const raw = v.parse(v.record(v.string(), v.unknown()), JSON.parse(text));
  const record = v.parse(schema, raw);
  // Additional selected columns are persisted keys, aliased to their JSON fields.
  for (const [key, value] of Object.entries(row)) {
    if (key !== 'record' && raw[key] !== value)
      throw new DiagnosticsError(503, 'Task record binding is inconsistent.');
  }
  return record;
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
    .map((row) => parseRecord(row, schema));
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
    "SELECT id,record FROM factory_writeback_records WHERE work_id=? AND kind='effect' ORDER BY rowid DESC LIMIT ?",
    writebackEffectSchema,
    workId,
  );
  const revisions = jsonRows(
    db,
    'SELECT version,record FROM factory_spec_revisions WHERE work_id=? ORDER BY rowid DESC LIMIT ?',
    revisionSchema,
    workId,
  );
  const releases = jsonRows(
    db,
    'SELECT id,record FROM factory_releases WHERE work_id=? ORDER BY rowid DESC LIMIT ?',
    releaseSchema,
    workId,
  );
  const runs = jsonRows(
    db,
    'SELECT run_id AS runId,record_json AS record FROM coding_runs WHERE work_item_id=? ORDER BY sequence DESC LIMIT ?',
    codingRunRecordSchema,
    workId,
  );
  const deliveries = jsonRows(
    db,
    'SELECT pipeline_id AS pipelineId,record_json AS record FROM factory_delivery_pipelines WHERE work_item_id=? ORDER BY sequence DESC LIMIT ?',
    deliveryPipelineSchema,
    workId,
  );
  const audit = db
    .prepare(
      'SELECT id,action,actor,created_at AS createdAt FROM factory_audit WHERE work_id=? ORDER BY id DESC LIMIT ?',
    )
    .all(workId, sourceLimit + 1)
    .map((r) => v.parse(auditSchema, r));
  const planning = planningCandidates(db, workId);
  const receipts = db
    .prepare(
      `SELECT e.id AS effectId,e.intent_id AS intentId,e.record AS effectRecord,${planningProjection('i')} FROM factory_planning_effects e JOIN factory_planning_intents i ON i.id=e.intent_id WHERE i.work_id=? ORDER BY e.rowid DESC LIMIT ?`,
    )
    .all(workId, sourceLimit + 1)
    .map(({ effectId, intentId, effectRecord, ...parent }) => {
      parsePlanning(parent, workId);
      return {
        id: v.parse(label, effectId),
        intentId: v.parse(label, intentId),
        effect: decodePlanningEffect(effectRecord),
      };
    });
  const events = db
    .prepare(
      `SELECT json_extract(r.record_json,'$.runId') AS parentRunId,json_extract(r.record_json,'$.snapshot.workItemId') AS parentWorkId,e.sequence,e.run_id AS runId,e.version,e.type,e.status,e.created_at AS createdAt FROM coding_run_events e JOIN coding_runs r ON e.run_id=r.run_id WHERE r.work_item_id=? ORDER BY e.sequence DESC LIMIT ?`,
    )
    .all(workId, sourceLimit + 1)
    .map(({ parentRunId, parentWorkId, ...r }) => {
      if (parentRunId !== r.runId || parentWorkId !== workId)
        throw new DiagnosticsError(503, 'Task record binding is inconsistent.');
      return v.parse(codingRunEventSchema, r);
    });
  if (
    writeback.some((r) => r.workId !== workId) ||
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
      .map((r) => parseRecord(r, schema));
  }
  const runCandidates = jsonRows(
    db,
    'SELECT run_id AS runId,record_json AS record FROM coding_runs WHERE work_item_id=? ORDER BY sequence DESC LIMIT ?',
    codingRunRecordSchema,
    workId,
  );
  const runs = runCandidates.slice(0, sourceLimit);
  const releaseCandidates =
    work.lifecycle === 'queued' && runs.length
      ? jsonRows(
          db,
          'SELECT id,record FROM factory_releases WHERE work_id=? ORDER BY rowid DESC LIMIT ?',
          releaseSchema,
          workId,
        )
      : [];
  const releases = releaseCandidates
    .slice(0, sourceLimit)
    .filter((r) => r.withdrawnAt === null);
  const revisions = releases.length
    ? db
        .prepare(
          'SELECT version,record FROM factory_spec_revisions WHERE work_id=? AND version=? LIMIT 1',
        )
        .all(workId, work.specVersion)
        .map((row) => parseRecord(row, revisionSchema))
    : [];
  // Validate a bounded candidate window before deciding which outcomes are terminal.
  // Older candidates outside this window make health partial, never silently healthy.
  const deliveryCandidates = jsonRows(
    db,
    'SELECT pipeline_id AS pipelineId,record_json AS record FROM factory_delivery_pipelines WHERE work_item_id=? ORDER BY sequence DESC LIMIT ?',
    deliveryPipelineSchema,
    workId,
  );
  const deliveries = deliveryCandidates
    .slice(0, sourceLimit)
    .filter((r) => r.outcome === null);
  const writeback = current(
    "SELECT id,record FROM factory_writeback_records WHERE work_id=? AND kind='effect' AND (json_extract(record,'$.state') IS NULL OR json_extract(record,'$.state') NOT IN ('sent','cancelled')) ORDER BY rowid DESC LIMIT 51",
    writebackEffectSchema,
  );
  const candidates = planningCandidates(db, workId);
  const planning = candidates
    .slice(0, sourceLimit)
    .filter((r) => r.stage === 'triage' || r.stage === 'planner');
  if (
    runCandidates.some((r) => r.snapshot.workItemId !== workId) ||
    releaseCandidates.some((r) => r.workId !== workId) ||
    revisions.some((r) => r.workId !== workId) ||
    deliveryCandidates.some((r) => r.workItemId !== workId) ||
    writeback.some((r) => r.workId !== workId)
  )
    throw new DiagnosticsError(503, 'Task record binding is inconsistent.');
  return {
    work,
    runs,
    deliveries,
    writeback: writeback.slice(0, 50),
    planning: planning.slice(0, 1),
    revisions,
    releases,
    audit: [],
    receipts: [],
    events: [],
    truncated:
      runCandidates.length > sourceLimit ||
      releaseCandidates.length > sourceLimit ||
      candidates.length > sourceLimit ||
      deliveryCandidates.length > sourceLimit ||
      writeback.length > 50 ||
      planning.length > 1,
  };
}
