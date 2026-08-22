import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import * as v from 'valibot';

const deliveryRowSchema = v.strictObject({
  item_kind: v.picklist(['conversation-comment', 'review', 'review-comment']),
  item_id: v.pipe(v.string(), v.minLength(1)),
  item_fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
const pendingPayloadRowSchema = v.object({ payload_json: v.string() });
const pendingDeliveryPayloadSchema = v.object({
  target: v.object({
    repoFullName: v.string(),
    number: v.number(),
  }),
  result: v.object({
    review: v.object({ id: v.union([v.string(), v.number()]) }),
  }),
});

export type NeondeckPrDeliveries = {
  conversationCommentFingerprints: Map<string, string>;
  reviewFingerprints: Map<string, string>;
  reviewCommentFingerprints: Map<string, string>;
};

type NeondeckPrDeliveryInput = {
  repoFullName: string;
  prNumber: number;
  itemKind: 'conversation-comment' | 'review' | 'review-comment';
  itemId: string | number;
  itemFingerprint: string;
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
      .flatMap((row) => {
        const parsed = v.safeParse(deliveryRowSchema, row);
        return parsed.success ? [parsed.output] : [];
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
  input: NeondeckPrDeliveryInput,
  paths: RuntimePaths,
) {
  recordNeondeckPrDeliveries([input], paths);
}

export function recordNeondeckPrDeliveries(
  inputs: NeondeckPrDeliveryInput[],
  paths: RuntimePaths,
) {
  recordNeondeckPrDeliveriesTransaction(inputs, null, paths);
}

export function recordNeondeckPrDeliveriesAndCompleteFollowup(
  inputs: NeondeckPrDeliveryInput[],
  followupId: string,
  paths: RuntimePaths,
) {
  recordNeondeckPrDeliveriesTransaction(inputs, followupId, paths);
}

export function readPendingNeondeckPrReviewIds(
  repoFullName: string,
  prNumber: number,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT payload_json
         FROM pr_review_submission_followups
         WHERE kind = 'delivery' AND status IN ('pending', 'processing');`,
      )
      .all();
    const result = new Set<string>();
    for (const rawRow of rows) {
      const row = v.safeParse(pendingPayloadRowSchema, rawRow);
      if (!row.success) continue;
      try {
        const payload = v.parse(
          pendingDeliveryPayloadSchema,
          JSON.parse(row.output.payload_json),
        );
        if (
          payload.target.repoFullName.toLowerCase() ===
            repoFullName.toLowerCase() &&
          payload.target.number === prNumber
        ) {
          result.add(String(payload.result.review.id));
        }
      } catch {
        // Invalid rows are surfaced when the follow-up worker claims them.
      }
    }
    return result;
  } finally {
    database.close();
  }
}

function recordNeondeckPrDeliveriesTransaction(
  inputs: NeondeckPrDeliveryInput[],
  completedFollowupId: string | null,
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
      if (completedFollowupId) {
        const completed = database
          .prepare(
            `UPDATE pr_review_submission_followups
             SET status = 'completed', last_error = NULL,
                 updated_at = ?, next_attempt_at = ?, completed_at = ?
             WHERE id = ? AND status = 'processing';`,
          )
          .run(now, now, now, completedFollowupId);
        if (completed.changes !== 1) {
          throw new Error('Submitted-review delivery fence was not claimed.');
        }
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
