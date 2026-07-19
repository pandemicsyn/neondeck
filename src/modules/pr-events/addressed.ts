import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';

export type AddressedPrFeedback = {
  reviewThreadFingerprints: Map<string, string>;
  reviewCommentFingerprints: Map<string, string>;
};

export function readAddressedPrFeedback(
  repoFullName: string,
  prNumber: number,
  paths: RuntimePaths,
): AddressedPrFeedback {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT item_kind, item_id, item_fingerprint
         FROM pr_feedback_addressing
         WHERE repo_full_name = ? AND pr_number = ?;`,
      )
      .all(repoFullName, prNumber) as Array<{
      item_kind: unknown;
      item_id: unknown;
      item_fingerprint: unknown;
    }>;
    return {
      reviewThreadFingerprints: new Map(
        rows
          .filter((row) => row.item_kind === 'review-thread')
          .map((row) => [String(row.item_id), String(row.item_fingerprint)]),
      ),
      reviewCommentFingerprints: new Map(
        rows
          .filter((row) => row.item_kind === 'review-comment')
          .map((row) => [String(row.item_id), String(row.item_fingerprint)]),
      ),
    };
  } finally {
    database.close();
  }
}

export function recordAddressedPrFeedback(
  input: {
    repoFullName: string;
    prNumber: number;
    reviewThreadFingerprints: Record<string, string>;
    reviewCommentFingerprints: Record<string, string>;
    deliveryCommentId?: string | number | null;
  },
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const statement = database.prepare(
        `INSERT INTO pr_feedback_addressing (
           repo_full_name, pr_number, item_kind, item_id, item_fingerprint,
           delivery_comment_id, addressed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_full_name, pr_number, item_kind, item_id) DO UPDATE SET
           item_fingerprint = excluded.item_fingerprint,
           delivery_comment_id = COALESCE(excluded.delivery_comment_id, delivery_comment_id),
           addressed_at = excluded.addressed_at;`,
      );
      const deliveryCommentId =
        input.deliveryCommentId === undefined ||
        input.deliveryCommentId === null
          ? null
          : String(input.deliveryCommentId);
      for (const [itemId, fingerprint] of Object.entries(
        input.reviewThreadFingerprints,
      )) {
        statement.run(
          input.repoFullName,
          input.prNumber,
          'review-thread',
          itemId,
          fingerprint,
          deliveryCommentId,
          now,
        );
      }
      for (const [itemId, fingerprint] of Object.entries(
        input.reviewCommentFingerprints,
      )) {
        statement.run(
          input.repoFullName,
          input.prNumber,
          'review-comment',
          itemId,
          fingerprint,
          deliveryCommentId,
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
