import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { workSchema, sourceSchema } from '../../../shared/factory';
import { linearRecords, putLinearRecord } from './linear-store';
import { linearFingerprint } from './linear-config';

/** A renewed desired target owns a new effect; old receipts remain evidence. */
export function linearWritebackTarget(
  db: DatabaseSync,
  workId: string,
  workVersion: number,
  sourceVersion: number,
  stateId: string,
) {
  const row = db
    .prepare(
      'SELECT w.record AS work,s.record AS source FROM factory_work_items w JOIN factory_sources s ON s.id=w.source_id WHERE w.id=?',
    )
    .get(workId);
  if (!row) return null;
  const work = v.parse(workSchema, JSON.parse(String(row.work)));
  const source = v.parse(sourceSchema, JSON.parse(String(row.source)));
  if (
    work.version !== workVersion ||
    source.version !== sourceVersion ||
    source.attention ||
    source.status === 'closed'
  )
    return null;
  const id = `writeback-target:${workId}`;
  const signature = linearFingerprint({ workVersion, stateId });
  const previous = linearRecords(db, 'writeback-target', { id })[0];
  const generation =
    previous?.signature === signature
      ? previous.generation
      : (previous?.generation ?? 0) + 1;
  if (previous?.signature !== signature)
    putLinearRecord(db, {
      id,
      kind: 'writeback-target',
      signature,
      generation,
    });
  const legacyId = `${workId}:${workVersion}:${stateId}`;
  const legacy =
    generation === 1 &&
    linearRecords(db, 'writeback', { id: `writeback:${legacyId}` })[0];
  const effectId = legacy ? legacyId : `${legacyId}:generation:${generation}`;
  for (const effect of linearRecords(db, 'writeback', {
    workId,
    state: 'pending',
  })) {
    if (effect.id !== `writeback:${effectId}`)
      putLinearRecord(db, {
        ...effect,
        state: 'superseded',
        retryAt: 0,
        error:
          'Unsent Linear update retired because a newer desired target replaced it.',
        updatedAt: new Date().toISOString(),
      });
  }
  return effectId;
}
