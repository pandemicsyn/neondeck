import type { JsonValue } from '@flue/runtime';
import { openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { jsonValueSchema } from '../sessions';
import * as v from 'valibot';

const followupRowSchema = v.looseObject({
  id: v.string(),
  kind: v.picklist(['delivery', 'evidence']),
  payload_json: v.string(),
});
const followupIdRowSchema = v.looseObject({ id: v.string() });
const followupAttemptRowSchema = v.looseObject({ attempt_count: v.number() });
const errorSchema = v.instance(Error);
const followupExternalValueSchema = v.unknown();
type PrReviewFollowupExternalValue = v.InferInput<
  typeof followupExternalValueSchema
>;

export type PrReviewSubmissionFollowupKind = 'delivery' | 'evidence';

export type PrReviewSubmissionFollowup = {
  id: string;
  kind: PrReviewSubmissionFollowupKind;
  payload: PrReviewFollowupExternalValue;
};

type ClaimedPrReviewSubmissionFollowup = Omit<
  PrReviewSubmissionFollowup,
  'payload'
> & { payload: JsonValue };

export function enqueuePrReviewSubmissionFollowup(
  input: PrReviewSubmissionFollowup,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const payloadJson = v.parse(v.string(), JSON.stringify(input.payload));
    v.parse(jsonValueSchema, JSON.parse(payloadJson));
    database
      .prepare(
        `INSERT INTO pr_review_submission_followups (
           id, kind, payload_json, status, attempt_count,
           next_attempt_at, last_error, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL)
         ON CONFLICT(id) DO NOTHING;`,
      )
      .run(input.id, input.kind, payloadJson, now, now, now);
  } finally {
    database.close();
  }
}

export function schedulePrReviewSubmissionFollowup(
  input: PrReviewSubmissionFollowup,
  paths: RuntimePaths,
  onEnqueued: () => void,
) {
  let retryDelayMs = 1_000;
  const attempt = () => {
    try {
      enqueuePrReviewSubmissionFollowup(input, paths);
      onEnqueued();
    } catch (error) {
      console.error(
        `[neondeck] failed to persist ${input.kind} follow-up; retrying in ${retryDelayMs}ms`,
        error,
      );
      const timer = setTimeout(() => {
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
        attempt();
      }, retryDelayMs);
      timer.unref?.();
    }
  };
  attempt();
}

export function claimPrReviewSubmissionFollowup(
  kind: PrReviewSubmissionFollowupKind,
  paths: RuntimePaths,
  id?: string,
): ClaimedPrReviewSubmissionFollowup | null {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    const row = id
      ? database
          .prepare(
            `SELECT id, kind, payload_json
             FROM pr_review_submission_followups
             WHERE id = ? AND status = 'pending' AND kind = ?
               AND next_attempt_at <= ?
             LIMIT 1;`,
          )
          .get(id, kind, now)
      : database
          .prepare(
            `SELECT id, kind, payload_json
             FROM pr_review_submission_followups
             WHERE status = 'pending' AND kind = ?
               AND next_attempt_at <= ?
             ORDER BY created_at ASC
             LIMIT 1;`,
          )
          .get(kind, now);
    const parsedRow = v.safeParse(followupRowSchema, row);
    if (!parsedRow.success) {
      database.exec('COMMIT;');
      return null;
    }
    const payload = v.parse(
      jsonValueSchema,
      JSON.parse(parsedRow.output.payload_json),
    );
    const claimed = database
      .prepare(
        `UPDATE pr_review_submission_followups
         SET status = 'processing', attempt_count = attempt_count + 1,
             updated_at = ?
         WHERE id = ? AND status = 'pending';`,
      )
      .run(now, parsedRow.output.id);
    database.exec('COMMIT;');
    if (claimed.changes !== 1) return null;
    return {
      id: parsedRow.output.id,
      kind,
      payload,
    };
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the claim failure.
    }
    throw error;
  } finally {
    database.close();
  }
}

export function listPendingPrReviewSubmissionFollowupIds(
  kind: PrReviewSubmissionFollowupKind,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT id
           FROM pr_review_submission_followups
           WHERE status = 'pending' AND kind = ?
           ORDER BY created_at ASC;`,
      )
      .all(kind)
      .flatMap((row) => {
        const parsed = v.safeParse(followupIdRowSchema, row);
        return parsed.success ? [parsed.output.id] : [];
      });
  } finally {
    database.close();
  }
}

export function completePrReviewSubmissionFollowup(
  id: string,
  paths: RuntimePaths,
) {
  settleFollowup(id, 'completed', null, paths);
}

export function retryPrReviewSubmissionFollowup<TError>(
  id: string,
  error: TError,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date();
  try {
    const parsedRow = v.safeParse(
      followupAttemptRowSchema,
      database
        .prepare(
          `SELECT attempt_count
         FROM pr_review_submission_followups
         WHERE id = ? AND status = 'processing';`,
        )
        .get(id),
    );
    const attemptCount = parsedRow.success ? parsedRow.output.attempt_count : 1;
    const retryDelayMs = Math.min(
      1_000 * 2 ** Math.max(0, attemptCount - 1),
      30_000,
    );
    database
      .prepare(
        `UPDATE pr_review_submission_followups
         SET status = 'pending', last_error = ?, updated_at = ?,
             next_attempt_at = ?, completed_at = NULL
         WHERE id = ? AND status = 'processing';`,
      )
      .run(
        errorMessage(error),
        now.toISOString(),
        new Date(now.getTime() + retryDelayMs).toISOString(),
        id,
      );
    return retryDelayMs;
  } finally {
    database.close();
  }
}

function errorMessage<TError>(error: TError) {
  const parsed = v.safeParse(errorSchema, error);
  return parsed.success ? parsed.output.message : String(error);
}

export function recoverProcessingPrReviewSubmissionFollowups(
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `UPDATE pr_review_submission_followups
         SET status = 'pending', updated_at = ?, next_attempt_at = ?
         WHERE status IN ('pending', 'processing');`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
  } finally {
    database.close();
  }
}

function settleFollowup(
  id: string,
  status: 'pending' | 'completed',
  lastError: string | null,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `UPDATE pr_review_submission_followups
         SET status = ?, last_error = ?, updated_at = ?,
             next_attempt_at = ?,
             completed_at = CASE WHEN ? = 'completed' THEN ? ELSE NULL END
         WHERE id = ? AND status = 'processing';`,
      )
      .run(status, lastError, now, now, status, now, id);
  } finally {
    database.close();
  }
}
