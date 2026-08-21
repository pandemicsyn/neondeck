import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../../lib/sqlite';
import * as v from 'valibot';

type EditableDraftIdentity = {
  draftId: string;
  expectedRevision: number;
  expectedHeadSha?: string;
};

const draftStateRowSchema = v.object({
  status: v.string(),
  head_sha: v.string(),
  revision: v.number(),
  updated_at: v.string(),
});

/**
 * Owns optimistic concurrency for local PR review drafts.
 *
 * Callers may mutate draft or comment columns inside `mutate`, but this
 * repository is the only place that validates and advances the draft
 * revision. `updated_at` is ordering/display metadata, never a write token.
 */
export class ReviewDraftRepository {
  constructor(private readonly database: DatabaseSync) {}

  withEditableMutation<T>(
    identity: EditableDraftIdentity,
    mutate: () => boolean,
    read: () => T,
    now = new Date().toISOString(),
  ): T {
    return withImmediateTransaction(this.database, () => {
      const state = this.requireEditable(identity);
      if (!mutate()) return read();

      const updatedAt = nextReviewDraftUpdatedAt(state.updated_at, now);
      const result = this.database
        .prepare(
          `UPDATE pr_review_drafts
           SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?;`,
        )
        .run(updatedAt, identity.draftId, identity.expectedRevision);
      if (result.changes !== 1) {
        throw new Error('Review draft changed before the mutation committed.');
      }
      return read();
    });
  }

  requireEditable(identity: EditableDraftIdentity) {
    const row = v.safeParse(
      draftStateRowSchema,
      this.database
        .prepare(
          `SELECT status, head_sha, revision, updated_at
         FROM pr_review_drafts
         WHERE id = ?;`,
        )
        .get(identity.draftId),
    );
    if (!row.success || row.output.status !== 'draft') {
      throw new Error('Review draft is not editable.');
    }
    if (row.output.revision !== identity.expectedRevision) {
      throw new Error('Review draft changed before the mutation.');
    }
    if (
      identity.expectedHeadSha &&
      row.output.head_sha !== identity.expectedHeadSha
    ) {
      throw new Error(
        'Review draft no longer matches the expected head revision.',
      );
    }
    return row.output;
  }
}

export function nextReviewDraftUpdatedAt(
  current: string | null,
  candidate: string,
) {
  if (!current) return candidate;
  const currentTime = Date.parse(current);
  const candidateTime = Date.parse(candidate);
  if (!Number.isFinite(currentTime) || candidateTime > currentTime) {
    return candidate;
  }
  return new Date(currentTime + 1).toISOString();
}
