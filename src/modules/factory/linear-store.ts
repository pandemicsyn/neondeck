import * as v from 'valibot';
import type { DatabaseSync } from 'node:sqlite';
import { runtimePaths } from '../../runtime-home';
import { dbRun, FactoryError } from './service';
const s = v.pipe(v.string(), v.maxLength(2000));
const key = v.pipe(s, v.minLength(1));
const common = {
  id: key,
  connectionId: key,
  connectionFingerprint: key,
  state: v.picklist([
    'pending',
    'complete',
    'attention',
    'sending',
    'uncertain',
  ]),
  error: v.nullable(s),
  retryAt: v.pipe(v.number(), v.minValue(0)),
  attempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
};
const deliverySchema = v.object({
  ...common,
  kind: v.literal('delivery'),
  issueId: key,
  action: v.optional(
    v.picklist(['create', 'update', 'remove', 'retry']),
    'retry',
  ),
  digest: v.optional(s, ''),
  createdAt: v.optional(s, ''),
});
export const linearSyncSchema = v.object({
  ...common,
  kind: v.literal('sync'),
  cursor: v.optional(v.nullable(s), null),
  offset: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
    0,
  ),
});
export const linearEffectSchema = v.object({
  ...common,
  kind: v.literal('writeback'),
  issueId: key,
  workId: key,
  stateId: key,
  sourceVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  baseline: key,
  createdAt: v.optional(s, ''),
  updatedAt: v.optional(s, ''),
});
const removalSchema = v.object({
  ...common,
  kind: v.literal('removal'),
  issueId: key,
  createdAt: key,
});
export const linearScheduleSchema = v.object({
  id: key,
  kind: v.literal('schedule'),
  offset: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  ),
});
export const linearReadFailureSchema = v.object({
  ...common,
  kind: v.literal('read-failure'),
  issueId: key,
});
export const linearRecordSchema = v.variant('kind', [
  deliverySchema,
  linearSyncSchema,
  linearEffectSchema,
  removalSchema,
  linearScheduleSchema,
  linearReadFailureSchema,
]);
export type LinearRecord = v.InferOutput<typeof linearRecordSchema>;
export function linearRecords<K extends LinearRecord['kind']>(
  db: DatabaseSync,
  kind: K,
  filter: {
    id?: string;
    issueId?: string;
    connectionId?: string;
    workId?: string;
    limit?: number;
  } = {},
): Extract<LinearRecord, { kind: K }>[] {
  const clauses = ['kind=?'];
  const values: (string | number)[] = [kind];
  for (const field of ['id', 'issueId', 'connectionId', 'workId'] as const) {
    if (filter[field] !== undefined) {
      clauses.push(
        field === 'id' ? 'id=?' : `json_extract(record,'$.${field}')=?`,
      );
      values.push(filter[field]!);
    }
  }
  const limit = filter.limit ?? -1;
  values.push(limit);
  return db
    .prepare(
      `SELECT record FROM factory_linear_records WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...values)
    .reverse()
    .map((r) => v.parse(linearRecordSchema, JSON.parse(String(r.record))))
    .filter((r): r is Extract<LinearRecord, { kind: K }> => r.kind === kind);
}
export function putLinearRecord(db: DatabaseSync, row: LinearRecord) {
  const value = v.parse(linearRecordSchema, row);
  db.prepare(
    'INSERT INTO factory_linear_records(id,kind,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
  ).run(value.id, value.kind, JSON.stringify(value));
  // Keep recent terminal evidence per task; unresolved intents are never pruned.
  if (value.kind === 'writeback')
    db.prepare(
      "DELETE FROM factory_linear_records WHERE id IN (SELECT id FROM factory_linear_records WHERE kind='writeback' AND json_extract(record,'$.workId')=? AND json_extract(record,'$.state') ='complete' ORDER BY rowid DESC LIMIT -1 OFFSET 20)",
    ).run(value.workId);
}
export function acceptLinearDelivery(
  input: {
    id: string;
    connectionId: string;
    connectionFingerprint: string;
    issueId: string;
    action: 'create' | 'update' | 'remove';
    digest: string;
    createdAt: string;
  },
  paths = runtimePaths(),
) {
  return dbRun(paths, (db) => {
    const id = `delivery:${input.id}`;
    const old = linearRecords(db, 'delivery', { id }).find((r) => r.id === id);
    if (old) {
      if (
        old.digest !== input.digest ||
        old.connectionId !== input.connectionId
      )
        throw new FactoryError(409, 'Linear delivery identity conflict.');
      return { accepted: true, duplicate: true };
    }
    if (
      linearRecords(db, 'delivery').filter((r) => r.state !== 'complete')
        .length >= 5000
    )
      throw new FactoryError(409, 'Linear delivery queue is full.');
    putLinearRecord(
      db,
      v.parse(linearRecordSchema, {
        ...input,
        id,
        kind: 'delivery',
        state: 'pending',
        error: null,
        retryAt: 0,
        attempts: 0,
      }),
    );
    db.prepare(
      "DELETE FROM factory_linear_records WHERE kind='delivery' AND id IN (SELECT id FROM factory_linear_records WHERE kind='delivery' AND json_extract(record,'$.state')='complete' ORDER BY rowid DESC LIMIT -1 OFFSET 10000)",
    ).run();
    return { accepted: true, duplicate: false };
  });
}
