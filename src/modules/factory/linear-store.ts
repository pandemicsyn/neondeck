import * as v from 'valibot';
import { linearRecordIdSchema } from '../../../shared/factory-linear';
import type { DatabaseSync } from 'node:sqlite';
import { runtimePaths } from '../../runtime-home';
import { dbRun, FactoryError } from './service';
const s = v.pipe(v.string(), v.maxLength(2000));
const key = v.pipe(s, v.minLength(1));
const common = {
  id: linearRecordIdSchema,
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
  sourceFingerprint: v.optional(key),
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
  state: v.picklist([
    'pending',
    'complete',
    'attention',
    'sending',
    'uncertain',
    'superseded',
  ]),
  kind: v.literal('writeback'),
  intentId: v.optional(key),
  workVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  sourceFingerprint: v.optional(key),
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
  id: linearRecordIdSchema,
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
  v.object({
    id: linearRecordIdSchema,
    kind: v.literal('writeback-target'),
    signature: key,
    generation: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(Number.MAX_SAFE_INTEGER),
    ),
  }),
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
    state?:
      | 'pending'
      | 'complete'
      | 'attention'
      | 'sending'
      | 'uncertain'
      | 'superseded';
    action?: 'create' | 'update' | 'remove' | 'retry';
    excludeAction?: 'remove';
    retryAtLte?: number;
    excludeConnectionIds?: string[];
    oldestFirst?: boolean;
    sourceBindingMismatch?: {
      sourceFingerprint: string;
      connectionFingerprint: string;
    };
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
  if (filter.state !== undefined) {
    clauses.push("json_extract(record,'$.state')=?");
    values.push(filter.state);
  }
  if (filter.action !== undefined) {
    clauses.push("COALESCE(json_extract(record,'$.action'),'retry')=?");
    values.push(filter.action);
  }
  if (filter.excludeAction !== undefined) {
    clauses.push("COALESCE(json_extract(record,'$.action'),'retry')<>?");
    values.push(filter.excludeAction);
  }
  if (filter.retryAtLte !== undefined) {
    clauses.push("json_extract(record,'$.retryAt')<=?");
    values.push(filter.retryAtLte);
  }
  if (filter.excludeConnectionIds?.length) {
    clauses.push(
      `json_extract(record,'$.connectionId') NOT IN (${filter.excludeConnectionIds.map(() => '?').join(',')})`,
    );
    values.push(...filter.excludeConnectionIds);
  }
  if (filter.sourceBindingMismatch) {
    clauses.push(
      "CASE WHEN json_extract(record,'$.sourceFingerprint') IS NULL THEN json_extract(record,'$.connectionFingerprint')<>? ELSE json_extract(record,'$.sourceFingerprint')<>? END",
    );
    values.push(
      filter.sourceBindingMismatch.connectionFingerprint,
      filter.sourceBindingMismatch.sourceFingerprint,
    );
  }
  const limit = filter.limit ?? -1;
  values.push(limit);
  const rows = db
    .prepare(
      `SELECT record FROM factory_linear_records WHERE ${clauses.join(' AND ')} ORDER BY rowid ${filter.oldestFirst ? 'ASC' : 'DESC'} LIMIT ?`,
    )
    .all(...values);
  return (filter.oldestFirst ? rows : rows.reverse())
    .map((r) => v.parse(linearRecordSchema, JSON.parse(String(r.record))))
    .filter((r): r is Extract<LinearRecord, { kind: K }> => r.kind === kind);
}
export function putLinearRecord(db: DatabaseSync, row: LinearRecord) {
  const value = v.parse(linearRecordSchema, row);
  // Signed removals carry local revocation authority and must remain admissible
  // even when provider-dependent reads exhaust their queue during an outage.
  if (
    value.kind === 'delivery' &&
    value.state === 'pending' &&
    value.action !== 'remove'
  ) {
    const existing = db
      .prepare(
        "SELECT json_extract(record,'$.state') AS state, json_extract(record,'$.action') AS action FROM factory_linear_records WHERE id=? AND kind='delivery'",
      )
      .get(value.id);
    // Replacing an already pending retry consumes no additional queue capacity.
    if (
      !(existing?.state === 'pending' && existing.action !== 'remove') &&
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM factory_linear_records WHERE kind='delivery' AND json_extract(record,'$.state')='pending' AND COALESCE(json_extract(record,'$.action'),'retry')!='remove'",
          )
          .get()!.count,
      ) >= 5000
    )
      throw new FactoryError(409, 'Linear delivery queue is full.');
  }
  // A provider await may retain an older legacy object while a config mutation
  // upgrades its binding. Do not erase that proven binding on retry/receipt.
  if (
    (value.kind === 'delivery' || value.kind === 'writeback') &&
    value.sourceFingerprint === undefined
  ) {
    const previous = linearRecords(db, value.kind, { id: value.id })[0];
    if (
      previous &&
      previous.connectionId === value.connectionId &&
      previous.connectionFingerprint === value.connectionFingerprint
    )
      value.sourceFingerprint = previous.sourceFingerprint;
  }
  db.prepare(
    'INSERT INTO factory_linear_records(id,kind,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
  ).run(value.id, value.kind, JSON.stringify(value));
  // Attention is review history, not active work. Retain its real outcome along
  // with recent completed deliveries without allowing either to fill admission.
  if (value.kind === 'delivery')
    db.prepare(
      "DELETE FROM factory_linear_records WHERE kind='delivery' AND id IN (SELECT id FROM factory_linear_records WHERE kind='delivery' AND json_extract(record,'$.state') IN ('complete','attention') ORDER BY rowid DESC LIMIT -1 OFFSET 10000)",
    ).run();
  // Keep recent terminal evidence per task; unresolved intents are never pruned.
  if (value.kind === 'writeback') {
    db.prepare(
      "DELETE FROM factory_linear_records WHERE id IN (SELECT id FROM factory_linear_records WHERE kind='writeback' AND json_extract(record,'$.workId')=? AND json_extract(record,'$.state') ='complete' ORDER BY rowid DESC LIMIT -1 OFFSET 20)",
    ).run(value.workId);
    db.prepare(
      "DELETE FROM factory_linear_records WHERE id IN (SELECT id FROM factory_linear_records WHERE kind='writeback' AND json_extract(record,'$.workId')=? AND json_extract(record,'$.state')='superseded' ORDER BY rowid DESC LIMIT -1 OFFSET 20)",
    ).run(value.workId);
  }
}
export function acceptLinearDelivery(
  input: {
    id: string;
    connectionId: string;
    connectionFingerprint: string;
    sourceFingerprint?: string;
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
    return { accepted: true, duplicate: false };
  });
}
