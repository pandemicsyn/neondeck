import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import {
  deliveryOwnershipSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import {
  database,
  decode,
  label,
  integer,
  type Paths,
} from './delivery-persistence';

// Cross-table ownership checks run in the same transaction as competing claims.
export function getFactoryDeliveryOwnership(input: unknown, paths: Paths) {
  const q = v.parse(deliveryOwnershipSchema, input);
  return database(paths, (db) => {
    const clauses = ['repo_id=?'];
    const args: (string | number)[] = [q.repoId];
    if (q.branch !== undefined) {
      clauses.push('branch=?');
      args.push(q.branch);
    }
    if (q.prNumber !== undefined) {
      clauses.push('pr_number=?');
      args.push(q.prNumber);
    }
    const row = db
      .prepare(
        `SELECT * FROM factory_delivery_pipelines WHERE ${clauses.join(' AND ')}`,
      )
      .get(...args);
    return row ? decode(row).record : null;
  });
}
/** The pre-PR repo fence lasts only while creation may be occurring. A queued plan owns no other PR. */
export function isFactoryOwnedWatchInTransaction(
  db: DatabaseSync,
  watchId: unknown,
): boolean {
  const id = v.parse(label, watchId);
  const row = db
    .prepare(
      'SELECT repo_id,github_owner,github_name,pr_number FROM pr_watches WHERE id=?',
    )
    .get(id);
  if (!row) return false;
  const watch = v.parse(
    v.strictObject({
      repo_id: label,
      github_owner: label,
      github_name: label,
      pr_number: integer,
    }),
    row,
  );
  const rows = db
    .prepare(
      `SELECT * FROM factory_delivery_pipelines WHERE repo_id=? OR (lower(json_extract(record_json,'$.authorization.target.owner'))=lower(?) AND lower(json_extract(record_json,'$.authorization.target.name'))=lower(?))`,
    )
    .all(watch.repo_id, watch.github_owner, watch.github_name);
  return rows.some((row) => {
    const r = decode(row).record;
    return (
      r.pr?.number === watch.pr_number ||
      (r.pr === null &&
        r.effects.some(
          (e) =>
            e.kind === 'create-pr' &&
            ['in-flight', 'uncertain'].includes(e.state),
        ))
    );
  });
}
export function isFactoryOwnedWatch(watchId: unknown, paths: Paths): boolean {
  return database(paths, (db) => isFactoryOwnedWatchInTransaction(db, watchId));
}
export function assertNoLegacyOwnerInTransaction(
  db: DatabaseSync,
  r: DeliveryPipeline,
) {
  const row = db
    .prepare(
      `SELECT w.id FROM pr_watches w WHERE (w.repo_id=? OR (lower(w.github_owner)=lower(?) AND lower(w.github_name)=lower(?))) AND (w.owner_instance_id IS NOT NULL OR w.worktree_id IS NOT NULL OR w.autopilot_status IN ('working','waiting') OR EXISTS(SELECT 1 FROM autopilot_owner_turns t WHERE t.watch_id=w.id AND t.status IN ('reserved','admitted','settling'))) LIMIT 1`,
    )
    .get(r.repoId, r.authorization.target.owner, r.authorization.target.name);
  if (row) {
    v.parse(v.strictObject({ id: label }), row);
    throw new Error('Legacy owner already holds publication repository');
  }
}
