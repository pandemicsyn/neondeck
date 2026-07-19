import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import * as v from 'valibot';

const deliveryRowSchema = v.strictObject({
  item_kind: v.picklist(['conversation-comment', 'review', 'review-comment']),
  item_id: v.pipe(v.string(), v.minLength(1)),
  item_fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

export type NeondeckPrDeliveries = {
  conversationCommentFingerprints: Map<string, string>;
  reviewFingerprints: Map<string, string>;
  reviewCommentFingerprints: Map<string, string>;
};

export function readNeondeckPrDeliveries(
  repoFullName: string,
  prNumber: number,
  paths: RuntimePaths,
): NeondeckPrDeliveries {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT item_kind, item_id, item_fingerprint
         FROM pr_neondeck_deliveries
         WHERE repo_full_name = ? AND pr_number = ?;`,
      )
      .all(repoFullName, prNumber)
      .map((row) => {
        const parsed = v.safeParse(deliveryRowSchema, row);
        if (!parsed.success) {
          throw new Error(
            `Invalid Neondeck PR delivery row: ${v.summarize(parsed.issues)}`,
          );
        }
        return parsed.output;
      });
    const fingerprints = (
      kind: 'conversation-comment' | 'review' | 'review-comment',
    ) =>
      new Map(
        rows
          .filter((row) => row.item_kind === kind)
          .map((row) => [row.item_id, row.item_fingerprint]),
      );
    return {
      conversationCommentFingerprints: fingerprints('conversation-comment'),
      reviewFingerprints: fingerprints('review'),
      reviewCommentFingerprints: fingerprints('review-comment'),
    };
  } finally {
    database.close();
  }
}

export function recordNeondeckPrDelivery(
  input: {
    repoFullName: string;
    prNumber: number;
    itemKind: 'conversation-comment' | 'review' | 'review-comment';
    itemId: string | number;
    itemFingerprint: string;
  },
  paths: RuntimePaths,
) {
  recordNeondeckPrDeliveries([input], paths);
}

export function recordNeondeckPrDeliveries(
  inputs: Array<{
    repoFullName: string;
    prNumber: number;
    itemKind: 'conversation-comment' | 'review' | 'review-comment';
    itemId: string | number;
    itemFingerprint: string;
  }>,
  paths: RuntimePaths,
) {
  if (inputs.length === 0) return;
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const insert = database.prepare(
        `INSERT INTO pr_neondeck_deliveries (
           repo_full_name, pr_number, item_kind, item_id,
           item_fingerprint, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_full_name, pr_number, item_kind, item_id) DO UPDATE SET
           item_fingerprint = excluded.item_fingerprint,
           delivered_at = excluded.delivered_at;`,
      );
      for (const input of inputs) {
        insert.run(
          input.repoFullName,
          input.prNumber,
          input.itemKind,
          String(input.itemId),
          input.itemFingerprint,
          now,
        );
      }
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    database.close();
  }
}
