import * as v from 'valibot';
import type { DatabaseSync } from 'node:sqlite';
import { runtimePaths } from '../../runtime-home';
import { dbRun } from './service';
import { commentRecordSchema, deliverySchema } from './github-store';
import { intentSchema } from './planning-store';

export const githubRetentionDays = 30;
export const githubRetentionBatch = 100;
const settledField = '$.retentionSettledAt';
const settledSchema = v.object({
  retentionSettledAt: v.pipe(v.string(), v.isoTimestamp()),
});
const completedDelivery = "json_extract(record,'$.state')='complete'";
const completedContext =
  "json_extract(record,'$.externalContext')=1 AND json_extract(record,'$.stage')='completed'";

/** Observe settlement instead of aging from admission: an old request may only
 * just have completed. Legacy rows receive the same full grace period. */
function observeSettled(
  db: DatabaseSync,
  table: 'factory_github_deliveries' | 'factory_planning_intents',
  condition: string,
  now: string,
) {
  db.prepare(
    `UPDATE ${table} SET record=json_set(record,?,?) WHERE id IN (
      SELECT id FROM ${table} WHERE ${condition}
      AND json_extract(record,?) IS NULL ORDER BY rowid LIMIT ?
    )`,
  ).run(settledField, now, settledField, githubRetentionBatch);
}

/** Only operational records expire. Sources, comments (including tombstones),
 * human planning, effects, specs, audit and Flue receipts remain authoritative. */
export function retainFactoryGitHubHistory(
  paths = runtimePaths(),
  now = Date.now(),
) {
  const observedAt = new Date(now).toISOString();
  const cutoff = new Date(now - githubRetentionDays * 86400000).toISOString();
  return dbRun(paths, (db) => {
    observeSettled(
      db,
      'factory_github_deliveries',
      completedDelivery,
      observedAt,
    );
    observeSettled(
      db,
      'factory_planning_intents',
      completedContext,
      observedAt,
    );
    const deliveries = db
      .prepare(
        `SELECT id,record FROM factory_github_deliveries WHERE ${completedDelivery}
       AND json_extract(record,?) < ? ORDER BY rowid LIMIT ?`,
      )
      .all(settledField, cutoff, githubRetentionBatch);
    for (const raw of deliveries) {
      const decoded: unknown = JSON.parse(v.parse(v.string(), raw.record));
      v.parse(settledSchema, decoded);
      const row = v.parse(deliverySchema, decoded);
      if (row.id !== raw.id)
        throw new Error('Delivery retention identity mismatch.');
      db.prepare('DELETE FROM factory_github_deliveries WHERE id=?').run(
        row.id,
      );
    }
    // Preserve the latest task state, every current comment anchor, all effects,
    // and all history while any request for that work is active. A superseded
    // comment revision cannot be emitted again: reconciliation uses the retained
    // comment's monotonic version and current intentId, never delivery payloads.
    const intents = db
      .prepare(
        `SELECT i.id,i.work_id,i.request_key,i.record,c.id AS comment_id,c.record AS comment FROM factory_planning_intents i
       JOIN factory_github_comments c ON c.work_id=i.work_id
         AND i.request_key LIKE 'github-comment:' || c.id || ':%'
       WHERE json_extract(i.record,'$.externalContext')=1
         AND json_extract(i.record,'$.stage')='completed'
         AND json_extract(i.record,?) < ?
         AND json_extract(c.record,'$.intentId') IS NOT NULL
         AND json_extract(c.record,'$.intentId') <> i.id
         AND EXISTS (SELECT 1 FROM factory_planning_intents newer
                     WHERE newer.work_id=i.work_id AND newer.rowid>i.rowid)
         AND NOT EXISTS (SELECT 1 FROM factory_planning_intents active
                     WHERE active.work_id=i.work_id
                     AND json_extract(active.record,'$.stage') IN ('triage','planner'))
         AND NOT EXISTS (SELECT 1 FROM factory_planning_effects e WHERE e.intent_id=i.id)
       ORDER BY i.rowid LIMIT ?`,
      )
      .all(settledField, cutoff, githubRetentionBatch);
    let removedIntents = 0;
    for (const raw of intents) {
      const decoded: unknown = JSON.parse(v.parse(v.string(), raw.record));
      v.parse(settledSchema, decoded);
      const intent = v.parse(intentSchema, decoded);
      const comment = v.parse(
        commentRecordSchema,
        JSON.parse(v.parse(v.string(), raw.comment)),
      );
      const prefix = `github-comment:${comment.id}:`;
      const revision = intent.requestKey.slice(prefix.length);
      if (
        intent.id !== raw.id ||
        intent.workId !== raw.work_id ||
        intent.requestKey !== raw.request_key ||
        comment.id !== raw.comment_id ||
        comment.workId !== intent.workId
      )
        throw new Error('Context retention identity mismatch.');
      if (
        !intent.requestKey.startsWith(prefix) ||
        !/^[1-9]\d*$/.test(revision) ||
        !Number.isSafeInteger(Number(revision)) ||
        Number(revision) >= comment.version
      )
        continue;
      db.prepare('DELETE FROM factory_planning_intents WHERE id=?').run(
        intent.id,
      );
      removedIntents++;
    }
    return { deliveries: deliveries.length, intents: removedIntents };
  });
}
