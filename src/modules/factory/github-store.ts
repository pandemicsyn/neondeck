import * as v from 'valibot';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { dbRun, FactoryError } from './service';
export const githubDigest = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const str = v.string();
export const deliverySchema = v.object({
  id: str,
  connectionId: str,
  connectionFingerprint: str,
  repositoryId: str,
  issueNumber: v.number(),
  issueId: str,
  event: str,
  action: str,
  digest: str,
  state: v.picklist(['pending', 'complete', 'attention']),
  error: v.nullable(str),
  attempts: v.number(),
  retryAt: v.number(),
  createdAt: str,
});
export type GitHubDelivery = v.InferOutput<typeof deliverySchema>;
export const syncSchema = v.object({
  id: str,
  connectionFingerprint: str,
  since: str,
  page: v.number(),
  offset: v.number(),
  sweepStartedAt: str,
  commentPage: v.optional(v.number(), 1),
  commentScan: v.optional(str, ''),
  commentMissingOffset: v.optional(v.number(), 0),
  pendingIssues: v.optional(
    v.nullable(
      v.pipe(
        v.array(
          v.object({ number: v.number(), issueId: str, eligible: v.boolean() }),
        ),
        v.maxLength(25),
      ),
    ),
    null,
  ),
  pageHasNext: v.optional(v.boolean(), false),
  admittedOffset: v.number(),
  error: v.nullable(str),
  retryAt: v.number(),
  attempts: v.number(),
});
export type GitHubSync = v.InferOutput<typeof syncSchema>;
export const commentRecordSchema = v.object({
  id: str,
  workId: str,
  remoteId: str,
  body: str,
  author: str,
  remoteUpdatedAt: str,
  fingerprint: str,
  version: v.number(),
  deleted: v.boolean(),
  seenScan: str,
  intentId: v.nullable(str),
});
export type CommentRecord = v.InferOutput<typeof commentRecordSchema>;
export function readGitHubRecords<T>(
  db: DatabaseSync,
  table:
    | 'factory_github_deliveries'
    | 'factory_github_sync'
    | 'factory_github_comments',
  schema: v.GenericSchema<unknown, T>,
) {
  return db
    .prepare(`SELECT record FROM ${table} ORDER BY rowid`)
    .all()
    .map((row) => v.parse(schema, JSON.parse(String(row.record))));
}
export function putDelivery(db: DatabaseSync, row: GitHubDelivery) {
  v.parse(deliverySchema, row);
  db.prepare(
    'INSERT INTO factory_github_deliveries(id,connection_id,issue_number,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
  ).run(row.id, row.connectionId, row.issueNumber, JSON.stringify(row));
}
export function acceptGitHubDelivery(row: GitHubDelivery, paths: RuntimePaths) {
  return dbRun(paths, (db) => {
    const old = db
      .prepare('SELECT record FROM factory_github_deliveries WHERE id=?')
      .get(row.id);
    if (old) {
      const prior = v.parse(deliverySchema, JSON.parse(String(old.record)));
      if (prior.digest !== row.digest || prior.event !== row.event)
        throw new FactoryError(
          409,
          'Delivery ID conflicts with retained content.',
        );
      return { duplicate: true };
    }
    putDelivery(db, row);
    return { duplicate: false };
  });
}
export function putSync(db: DatabaseSync, row: GitHubSync) {
  v.parse(syncSchema, row);
  db.prepare(
    'INSERT INTO factory_github_sync(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
  ).run(row.id, JSON.stringify(row));
}
export function putComment(db: DatabaseSync, row: CommentRecord) {
  v.parse(commentRecordSchema, row);
  db.prepare(
    'INSERT INTO factory_github_comments(id,work_id,record) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
  ).run(row.id, row.workId, JSON.stringify(row));
}
