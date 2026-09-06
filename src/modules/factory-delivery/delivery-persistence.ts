import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import {
  deliveryPipelineSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import { assertRecord } from './delivery-aggregate';

export type Paths = Pick<RuntimePaths, 'neondeckDatabase'>;
export const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
export const integer = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const rowSchema = v.strictObject({
  sequence: integer,
  pipeline_id: label,
  release_id: label,
  initial_run_id: label,
  initial_attempt_id: label,
  work_item_id: label,
  repo_id: label,
  branch: label,
  pr_number: v.nullable(integer),
  record_json: v.string(),
});
export function database<T>(paths: Paths, fn: (db: DatabaseSync) => T): T {
  const db = openDb(
    v.parse(v.pipe(v.string(), v.minLength(1)), paths.neondeckDatabase),
  );
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
export function decode(input: unknown) {
  const row = v.parse(rowSchema, input);
  const record = v.parse(deliveryPipelineSchema, JSON.parse(row.record_json));
  if (
    row.pipeline_id !== record.pipelineId ||
    row.release_id !== record.initialRevision.releaseId ||
    row.initial_run_id !== record.initialRevision.runId ||
    row.initial_attempt_id !== record.initialRevision.attemptId ||
    row.work_item_id !== record.workItemId ||
    row.repo_id !== record.repoId ||
    row.branch !== record.branch ||
    row.pr_number !== (record.pr?.number ?? null)
  )
    throw new Error('Corrupt delivery identity');
  assertRecord(record);
  return { sequence: row.sequence, record };
}
export function get(db: DatabaseSync, id: string) {
  const row = db
    .prepare('SELECT * FROM factory_delivery_pipelines WHERE pipeline_id=?')
    .get(id);
  return row ? decode(row).record : null;
}
export function save(db: DatabaseSync, r: DeliveryPipeline) {
  r.version++;
  r.updatedAt = new Date().toISOString();
  const valid = v.parse(deliveryPipelineSchema, r);
  assertRecord(valid);
  db.prepare(
    'UPDATE factory_delivery_pipelines SET record_json=?,pr_number=? WHERE pipeline_id=?',
  ).run(JSON.stringify(valid), valid.pr?.number ?? null, valid.pipelineId);
  return valid;
}
