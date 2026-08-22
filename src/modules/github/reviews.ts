import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { prefixBotComment } from '../../../shared/bot-comments';
import { isUniqueConstraintError, openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { addWorkflowSummary } from '../app-state';
import { encodePathSegment, githubFetch, githubGraphqlFetch } from './client';
import { fetchPullRequestReviewThread } from './comments';
import { GitHubApiError, errorMessage } from './errors';
import { fetchPullRequestDetail } from './pull-requests';
import {
  ReviewDraftRepository,
  nextReviewDraftUpdatedAt,
} from './review-draft-repository';
import { githubPullRequestReviewCreatedApiResponseSchema } from './schemas';
import type {
  GitHubPullRequestReviewThread,
  GitHubSubmittedPullRequestReview,
} from './schemas';

export type GitHubPrReviewVerdict = 'comment' | 'approve' | 'request-changes';

export type GitHubPrReviewDraftStatus =
  'draft' | 'submitting' | 'submitted' | 'discarded';

export type GitHubPrReviewDraftCommentSide = 'RIGHT' | 'LEFT';

export type GitHubPrReviewDraftCommentOrigin = 'human' | 'neon';

export type GitHubPrReviewDraftComment = {
  id: string;
  draftId: string;
  path: string;
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  startLine: number | null;
  startSide: GitHubPrReviewDraftCommentSide | null;
  body: string;
  origin: GitHubPrReviewDraftCommentOrigin;
  sourceFindingId: string | null;
  neonSeverity?: GitHubPrReviewNeonSeedSeverity | null;
  neonSummary?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GitHubPrReviewNeonSeedSeverity =
  'critical' | 'major' | 'minor' | 'nit';

export type GitHubPrReviewNeonSeedOutcome = 'submitted' | 'skipped' | 'deleted';

export type GitHubPrReviewNeonSeededComment = {
  commentId: string;
  draftId: string;
  repo: string;
  prNumber: number;
  headSha: string;
  path: string;
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  startLine: number | null;
  startSide: GitHubPrReviewDraftCommentSide | null;
  severity: GitHubPrReviewNeonSeedSeverity;
  summary: string;
  source: string;
  outcome: GitHubPrReviewNeonSeedOutcome | null;
  outcomeAt: string | null;
  seededAt: string;
};

export type GitHubPrReviewDraft = {
  id: string;
  repo: string;
  prNumber: number;
  headSha: string;
  verdict: GitHubPrReviewVerdict | null;
  body: string | null;
  status: GitHubPrReviewDraftStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  comments: GitHubPrReviewDraftComment[];
};

export type GitHubPrReviewSubmitFailure = {
  code:
    | 'invalid-review'
    | 'draft-not-found'
    | 'stale-draft'
    | 'insufficient-scope'
    | 'submission-uncertain'
    | 'github-review-submit-failed';
  message: string;
  failingCommentIds?: string[];
  requires?: string[];
};

export class GitHubPrReviewSubmitError extends Error {
  constructor(readonly failure: GitHubPrReviewSubmitFailure) {
    super(failure.message);
    this.name = 'GitHubPrReviewSubmitError';
  }
}

const reviewVerdictSchema = v.picklist([
  'comment',
  'approve',
  'request-changes',
]);
const reviewCommentSideSchema = v.picklist(['RIGHT', 'LEFT']);
const reviewCommentOriginSchema = v.picklist(['human', 'neon']);
const reviewNeonSeedSeveritySchema = v.picklist([
  'critical',
  'major',
  'minor',
  'nit',
]);
const reviewNeonSeedOutcomeSchema = v.picklist([
  'submitted',
  'skipped',
  'deleted',
]);
const draftStatusSchema = v.picklist([
  'draft',
  'submitting',
  'submitted',
  'discarded',
]);

const draftRowSchema = v.object({
  id: v.string(),
  repo: v.string(),
  pr_number: v.number(),
  head_sha: v.string(),
  verdict: v.nullable(reviewVerdictSchema),
  body: v.nullable(v.string()),
  status: draftStatusSchema,
  revision: v.number(),
  created_at: v.string(),
  updated_at: v.string(),
  submitted_at: v.nullable(v.string()),
});

const draftCommentRowSchema = v.object({
  id: v.string(),
  draft_id: v.string(),
  path: v.string(),
  side: reviewCommentSideSchema,
  line: v.number(),
  start_line: v.nullable(v.number()),
  start_side: v.nullable(reviewCommentSideSchema),
  body: v.string(),
  origin: reviewCommentOriginSchema,
  source_finding_id: v.nullable(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
});

const neonSeedRowSchema = v.object({
  comment_id: v.string(),
  draft_id: v.string(),
  repo: v.string(),
  pr_number: v.number(),
  head_sha: v.string(),
  path: v.string(),
  side: reviewCommentSideSchema,
  line: v.number(),
  start_line: v.nullable(v.number()),
  start_side: v.nullable(reviewCommentSideSchema),
  severity: reviewNeonSeedSeveritySchema,
  summary: v.string(),
  source: v.string(),
  outcome: v.nullable(reviewNeonSeedOutcomeSchema),
  outcome_at: v.nullable(v.string()),
  seeded_at: v.string(),
});

const replyReviewThreadMutation = `
  mutation NeondeckReplyPullRequestReviewThread($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment {
        id
      }
    }
  }
`;

const resolveReviewThreadMutation = `
  mutation NeondeckResolvePullRequestReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
      }
    }
  }
`;

const unresolveReviewThreadMutation = `
  mutation NeondeckUnresolvePullRequestReviewThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
      }
    }
  }
`;

export function readLivePrReviewDraft(options: {
  databasePath: string;
  repo: string;
  prNumber: number;
}): GitHubPrReviewDraft | null {
  const database = openDb(options.databasePath);
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM pr_review_drafts
        WHERE repo = ? COLLATE NOCASE
          AND pr_number = ?
          AND status = 'draft'
        ORDER BY updated_at DESC
        LIMIT 1;
      `,
      )
      .get(options.repo, options.prNumber);
    return row ? readDraftWithComments(database, row) : null;
  } finally {
    database.close();
  }
}

export function readPrReviewDraft(options: {
  databasePath: string;
  draftId: string;
}): GitHubPrReviewDraft | null {
  const database = openDb(options.databasePath);
  try {
    const row = database
      .prepare('SELECT * FROM pr_review_drafts WHERE id = ?;')
      .get(options.draftId);
    return row ? readDraftWithComments(database, row) : null;
  } finally {
    database.close();
  }
}

export function readPrReviewDraftForComment(options: {
  databasePath: string;
  commentId: string;
}): GitHubPrReviewDraft | null {
  const database = openDb(options.databasePath);
  try {
    const row = database
      .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
      .get(options.commentId) as { draft_id?: unknown } | undefined;
    const draftId = typeof row?.draft_id === 'string' ? row.draft_id : null;
    return draftId ? readDraftWithCommentsById(database, draftId) : null;
  } finally {
    database.close();
  }
}

type PrReviewDraftWriteBase = {
  databasePath: string;
  repo: string;
  prNumber: number;
  headSha: string;
  verdict?: GitHubPrReviewVerdict | null;
  body?: string | null;
  reanchorHeadSha?: boolean;
};

export type UpsertPrReviewDraftOptions = PrReviewDraftWriteBase &
  (
    | {
        draftId: string;
        expectedRevision: number;
        expectedAbsent?: false;
      }
    | {
        draftId?: never;
        expectedRevision?: never;
        expectedAbsent: true;
      }
  );

export function upsertPrReviewDraft(
  options: UpsertPrReviewDraftOptions,
): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  const body = normalizeNullableBody(options.body);
  try {
    const hasCreateIdentity =
      options.expectedAbsent === true && !options.draftId;
    const hasUpdateIdentity =
      Boolean(options.draftId) && options.expectedRevision !== undefined;
    if (!hasCreateIdentity && !hasUpdateIdentity) {
      throw new Error(
        'Saving a review draft requires an exact create or update identity.',
      );
    }
    if (options.draftId) {
      if (options.expectedAbsent) {
        throw new Error('Review draft identity is contradictory.');
      }
      const existing = database
        .prepare(
          `
          SELECT *
          FROM pr_review_drafts
          WHERE id = ?
            AND repo = ? COLLATE NOCASE
            AND pr_number = ?
          LIMIT 1;
        `,
        )
        .get(options.draftId, options.repo, options.prNumber);
      if (!existing) {
        throw new Error('Review draft does not belong to this pull request.');
      }
      if (readDraftRow(existing).status !== 'draft') {
        throw new Error('Review draft is not editable.');
      }
      return updateExistingReviewDraft(database, existing, options, now);
    }

    const existing = database
      .prepare(
        `
        SELECT *
        FROM pr_review_drafts
        WHERE repo = ? COLLATE NOCASE
          AND pr_number = ?
          AND status IN ('draft', 'submitting')
        LIMIT 1;
      `,
      )
      .get(options.repo, options.prNumber);

    if (existing) {
      if (readDraftRow(existing).status === 'submitting') {
        throw new Error('Review draft is being submitted and is not editable.');
      }
      throw new Error('A review draft appeared before creation.');
    }

    const latest = database
      .prepare(
        `
        SELECT updated_at
        FROM pr_review_drafts
        WHERE repo = ? COLLATE NOCASE
          AND pr_number = ?
        ORDER BY updated_at DESC
        LIMIT 1;
      `,
      )
      .get(options.repo, options.prNumber) as
      { updated_at?: unknown } | undefined;
    const createdAt = nextReviewDraftUpdatedAt(
      typeof latest?.updated_at === 'string' ? latest.updated_at : null,
      now,
    );
    const id = randomUUID();
    const canonicalRepo = options.repo.toLowerCase();
    try {
      database
        .prepare(
          `
          INSERT INTO pr_review_drafts (
            id,
            repo,
            pr_number,
            head_sha,
            verdict,
            body,
            status,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?);
        `,
        )
        .run(
          id,
          canonicalRepo,
          options.prNumber,
          options.headSha,
          options.verdict ?? null,
          body,
          createdAt,
          createdAt,
        );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      throw new Error('A review draft appeared before creation.');
    }
    return readDraftWithCommentsById(database, id);
  } finally {
    database.close();
  }
}

export function reanchorPrReviewDraft(options: {
  databasePath: string;
  repo: string;
  prNumber: number;
  draftId: string;
  expectedRevision: number;
  expectedHeadSha: string;
  headSha: string;
}): GitHubPrReviewDraft | null {
  const database = openDb(options.databasePath);
  try {
    const repository = new ReviewDraftRepository(database);
    return repository.withEditableMutation(
      {
        draftId: options.draftId,
        expectedRevision: options.expectedRevision,
        expectedHeadSha: options.expectedHeadSha,
      },
      () => {
        const result = database
          .prepare(
            `UPDATE pr_review_drafts
             SET head_sha = ?
             WHERE id = ?
               AND repo = ? COLLATE NOCASE
               AND pr_number = ?;`,
          )
          .run(
            options.headSha,
            options.draftId,
            options.repo,
            options.prNumber,
          );
        if (result.changes !== 1) {
          throw new Error('Review draft does not belong to this pull request.');
        }
        return true;
      },
      () => readDraftWithCommentsById(database, options.draftId),
    );
  } catch (error) {
    if (errorMessage(error).startsWith('Review draft')) return null;
    throw error;
  } finally {
    database.close();
  }
}

export function discardPrReviewDraft(options: {
  databasePath: string;
  draftId: string;
  expectedRevision: number;
  repo: string;
  prNumber: number;
}): GitHubPrReviewDraft | null {
  const database = openDb(options.databasePath);
  try {
    const repository = new ReviewDraftRepository(database);
    return repository.withEditableMutation(
      {
        draftId: options.draftId,
        expectedRevision: options.expectedRevision,
      },
      () => {
        const result = database
          .prepare(
            `UPDATE pr_review_drafts
             SET status = 'discarded'
             WHERE id = ?
               AND repo = ? COLLATE NOCASE
               AND pr_number = ?;`,
          )
          .run(options.draftId, options.repo, options.prNumber);
        if (result.changes !== 1) {
          throw new Error('Review draft does not belong to this pull request.');
        }
        return true;
      },
      () => readDraftWithCommentsById(database, options.draftId),
    );
  } catch (error) {
    if (errorMessage(error).startsWith('Review draft')) return null;
    throw error;
  } finally {
    database.close();
  }
}

export function addPrReviewDraftComment(options: {
  id?: string;
  databasePath: string;
  draftId: string;
  expectedDraftRevision: number;
  expectedHeadSha?: string;
  path: string;
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  startLine?: number | null;
  startSide?: GitHubPrReviewDraftCommentSide | null;
  body: string;
  origin?: GitHubPrReviewDraftCommentOrigin;
  sourceFindingId?: string | null;
  neonSeed?: {
    severity: GitHubPrReviewNeonSeedSeverity;
    summary: string;
    source: string;
  };
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  const origin = options.origin ?? 'human';
  const body =
    origin === 'neon'
      ? prefixBotComment(unbrandedGeneratedCommentBody(options.body))
      : options.body.trim();
  if (options.neonSeed && origin !== 'neon') {
    throw new Error('Only Neon draft comments can record a seed ledger row.');
  }
  try {
    const repository = new ReviewDraftRepository(database);
    return repository.withEditableMutation(
      {
        draftId: options.draftId,
        expectedRevision: options.expectedDraftRevision,
        expectedHeadSha: options.expectedHeadSha,
      },
      () => {
        assertValidReviewCommentAnchor(options);
        const id = options.id?.trim() || randomUUID();
        const existing = database
          .prepare(
            'SELECT draft_id FROM pr_review_draft_comments WHERE id = ? LIMIT 1;',
          )
          .get(id) as { draft_id?: unknown } | undefined;
        let added = false;
        if (existing) {
          if (existing.draft_id !== options.draftId) {
            throw new Error(
              'Review draft comment id belongs to another draft.',
            );
          }
        } else {
          database
            .prepare(
              `
              INSERT INTO pr_review_draft_comments (
                id,
                draft_id,
                path,
                side,
                line,
                start_line,
                start_side,
                body,
                origin,
                source_finding_id,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            `,
            )
            .run(
              id,
              options.draftId,
              options.path,
              options.side,
              options.line,
              options.startLine ?? null,
              options.startSide ?? null,
              body,
              origin,
              options.sourceFindingId ?? null,
              now,
              now,
            );
          added = true;
        }
        if (options.neonSeed) {
          const seededDraft = readDraftWithCommentsById(
            database,
            options.draftId,
          );
          const seededComment = seededDraft.comments.find(
            (comment) => comment.id === id && comment.origin === 'neon',
          );
          if (!seededComment) {
            throw new Error('Neon review seed comment was not recorded.');
          }
          recordPrReviewNeonSeedInDatabase(
            database,
            {
              draft: seededDraft,
              comment: seededComment,
              ...options.neonSeed,
            },
            now,
          );
        }
        return added;
      },
      () => readDraftWithCommentsById(database, options.draftId),
      now,
    );
  } finally {
    database.close();
  }
}

export function updatePrReviewDraftComment(options: {
  databasePath: string;
  commentId: string;
  body: string;
  expectedDraftId: string;
  expectedDraftRevision: number;
  expectedHeadSha?: string;
  origin?: GitHubPrReviewDraftCommentOrigin;
  path?: string;
  side?: GitHubPrReviewDraftCommentSide;
  line?: number;
  startLine?: number | null;
  startSide?: GitHubPrReviewDraftCommentSide | null;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  const origin = options.origin ?? 'human';
  const body =
    origin === 'neon'
      ? prefixBotComment(unbrandedGeneratedCommentBody(options.body))
      : options.body.trim();
  try {
    const row = database
      .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
      .get(options.commentId) as { draft_id?: unknown } | undefined;
    const draftId = typeof row?.draft_id === 'string' ? row.draft_id : null;
    if (!draftId) throw new Error('Review draft comment not found.');
    if (draftId !== options.expectedDraftId) {
      throw new Error(
        'Review draft changed before the comment could be updated.',
      );
    }
    const repository = new ReviewDraftRepository(database);
    return repository.withEditableMutation(
      {
        draftId,
        expectedRevision: options.expectedDraftRevision,
        expectedHeadSha: options.expectedHeadSha,
      },
      () => {
        const existing = database
          .prepare(
            `
            SELECT path, side, line, start_line, start_side
            FROM pr_review_draft_comments
            WHERE id = ?;
          `,
          )
          .get(options.commentId) as
          | {
              path: string;
              side: GitHubPrReviewDraftCommentSide;
              line: number;
              start_line: number | null;
              start_side: GitHubPrReviewDraftCommentSide | null;
            }
          | undefined;
        if (!existing) throw new Error('Review draft comment not found.');
        const nextAnchor = {
          path: options.path ?? existing.path,
          side: options.side ?? existing.side,
          line: options.line ?? existing.line,
          startLine:
            'startLine' in options
              ? (options.startLine ?? null)
              : existing.start_line,
          startSide:
            'startSide' in options
              ? (options.startSide ?? null)
              : existing.start_side,
        };
        assertValidReviewCommentAnchor(nextAnchor);
        const result = database
          .prepare(
            `
            UPDATE pr_review_draft_comments
            SET path = ?,
                side = ?,
                line = ?,
                start_line = ?,
                start_side = ?,
                body = ?,
                origin = ?,
                updated_at = ?
            WHERE id = ?;
          `,
          )
          .run(
            nextAnchor.path,
            nextAnchor.side,
            nextAnchor.line,
            nextAnchor.startLine,
            nextAnchor.startSide,
            body,
            origin,
            now,
            options.commentId,
          );
        if (result.changes !== 1) {
          throw new Error('Review draft comment not found.');
        }
        return true;
      },
      () => readDraftWithCommentsById(database, draftId),
      now,
    );
  } finally {
    database.close();
  }
}

export function clearPrReviewNeonDraftComments(options: {
  databasePath: string;
  draftId: string;
  expectedDraftRevision: number;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    const repository = new ReviewDraftRepository(database);
    return repository.withEditableMutation(
      {
        draftId: options.draftId,
        expectedRevision: options.expectedDraftRevision,
      },
      () => {
        const result = database
          .prepare(
            `
            DELETE FROM pr_review_draft_comments
            WHERE draft_id = ?
              AND origin = 'neon';
          `,
          )
          .run(options.draftId);
        return result.changes > 0;
      },
      () => readDraftWithCommentsById(database, options.draftId),
      now,
    );
  } finally {
    database.close();
  }
}

export function deletePrReviewDraftComment(options: {
  databasePath: string;
  commentId: string;
  expectedDraftId: string;
  expectedDraftRevision: number;
  expectedHeadSha?: string;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    const row = database
      .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
      .get(options.commentId) as { draft_id?: unknown } | undefined;
    const draftId = typeof row?.draft_id === 'string' ? row.draft_id : null;
    if (!draftId) throw new Error('Review draft comment not found.');
    if (draftId !== options.expectedDraftId) {
      throw new Error(
        'Review draft changed before the comment could be deleted.',
      );
    }
    const repository = new ReviewDraftRepository(database);
    return repository.withEditableMutation(
      {
        draftId,
        expectedRevision: options.expectedDraftRevision,
        expectedHeadSha: options.expectedHeadSha,
      },
      () => {
        const result = database
          .prepare('DELETE FROM pr_review_draft_comments WHERE id = ?;')
          .run(options.commentId);
        if (result.changes !== 1) {
          throw new Error('Review draft comment not found.');
        }
        return true;
      },
      () => readDraftWithCommentsById(database, draftId),
      now,
    );
  } finally {
    database.close();
  }
}

export function recordPrReviewNeonSeed(options: {
  databasePath: string;
  draft: GitHubPrReviewDraft;
  comment: GitHubPrReviewDraftComment;
  severity: GitHubPrReviewNeonSeedSeverity;
  summary: string;
  source: string;
}): GitHubPrReviewNeonSeededComment {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    return recordPrReviewNeonSeedInDatabase(database, options, now);
  } finally {
    database.close();
  }
}

function recordPrReviewNeonSeedInDatabase(
  database: ReturnType<typeof openDb>,
  options: {
    draft: GitHubPrReviewDraft;
    comment: GitHubPrReviewDraftComment;
    severity: GitHubPrReviewNeonSeedSeverity;
    summary: string;
    source: string;
  },
  seededAt: string,
) {
  database
    .prepare(
      `
      INSERT OR IGNORE INTO pr_review_neon_seeded_comments (
        comment_id,
        draft_id,
        repo,
        pr_number,
        head_sha,
        path,
        side,
        line,
        start_line,
        start_side,
        severity,
        summary,
        source,
        seeded_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
    )
    .run(
      options.comment.id,
      options.draft.id,
      options.draft.repo,
      options.draft.prNumber,
      options.draft.headSha,
      options.comment.path,
      options.comment.side,
      options.comment.line,
      options.comment.startLine,
      options.comment.startSide,
      options.severity,
      truncateSeedSummary(options.summary),
      options.source,
      seededAt,
    );
  return readNeonSeedByCommentId(database, options.comment.id);
}

export function deletePrReviewNeonSeedsForComments(options: {
  databasePath: string;
  commentIds: string[];
}) {
  const commentIds = [...new Set(options.commentIds.filter(Boolean))];
  if (commentIds.length === 0) return 0;
  const database = openDb(options.databasePath);
  try {
    const placeholders = commentIds.map(() => '?').join(', ');
    const result = database
      .prepare(
        `
        DELETE FROM pr_review_neon_seeded_comments
        WHERE comment_id IN (${placeholders});
      `,
      )
      .run(...commentIds);
    return Number(result.changes);
  } finally {
    database.close();
  }
}

export async function submitPullRequestReview(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  databasePath: string;
  paths: RuntimePaths;
  draftId: string;
  headSha: string;
  expectedDraftRevision: number;
  commentIds?: string[];
  fetchHeadSha?: (options: {
    token: string;
    owner: string;
    repo: string;
    number: number;
  }) => Promise<string | null | undefined>;
}): Promise<{
  draft: GitHubPrReviewDraft;
  review: GitHubSubmittedPullRequestReview;
}> {
  const expectedRepo = `${options.owner}/${options.repo}`;
  const draft = leaseDraftForSubmission({
    databasePath: options.databasePath,
    draftId: options.draftId,
    expectedRepo,
    expectedPrNumber: options.number,
    expectedRevision: options.expectedDraftRevision,
  });
  let githubRequestStarted = false;
  let attemptedComments = draft.comments;
  try {
    const currentHeadSha = await readCurrentPullRequestHeadSha(options);
    if (
      draft.headSha !== currentHeadSha ||
      options.headSha !== currentHeadSha
    ) {
      throw new GitHubPrReviewSubmitError({
        code: 'stale-draft',
        message: 'PR changed since this review draft was anchored.',
        failingCommentIds: draft.comments.map((comment) => comment.id),
      });
    }

    const selectedCommentIds = options.commentIds
      ? new Set(options.commentIds)
      : null;
    const comments =
      selectedCommentIds === null
        ? draft.comments
        : draft.comments.filter((comment) =>
            selectedCommentIds.has(comment.id),
          );
    attemptedComments = comments;
    const missingCommentIds = options.commentIds
      ? options.commentIds.filter(
          (id) => !draft.comments.some((comment) => comment.id === id),
        )
      : [];
    if (missingCommentIds.length > 0) {
      throw new GitHubPrReviewSubmitError({
        code: 'invalid-review',
        message: 'Review draft comment ids do not belong to this draft.',
        failingCommentIds: missingCommentIds,
      });
    }

    const verdict = draft.verdict ?? 'comment';
    const body = draft.body?.trim() ?? '';
    if (verdict !== 'approve' && body.length === 0 && comments.length === 0) {
      throw new GitHubPrReviewSubmitError({
        code: 'invalid-review',
        message: 'Review body or inline comments are required.',
      });
    }

    githubRequestStarted = true;
    const review = await createPullRequestReview({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      number: options.number,
      headSha: currentHeadSha,
      verdict,
      body,
      comments,
    });

    const deliveryFollowupId = `pr-review-delivery:${draft.repo.toLowerCase()}#${draft.prNumber}:${review.id}`;
    const submitted = markDraftSubmitted({
      databasePath: options.databasePath,
      draftId: draft.id,
      deliveryFollowupId,
      deliveryPayload: (submittedDraft) => ({
        target: {
          repoFullName: draft.repo,
          owner: options.owner,
          repo: options.repo,
          number: options.number,
        },
        result: { draft: submittedDraft, review },
        commentIds: comments.map((comment) => comment.id),
      }),
    });
    let neonDraftOutcome: ReturnType<typeof markNeonDraftSeedOutcomes> | null =
      null;
    try {
      neonDraftOutcome = markNeonDraftSeedOutcomes(
        options.databasePath,
        draft,
        comments,
      );
    } catch (error) {
      console.error(
        '[neondeck] failed to record submitted Neon draft outcomes',
        error,
      );
    }
    try {
      await addWorkflowSummary(
        {
          workflow: 'github_pr_review',
          runId: `github-pr-review:${draft.repo}#${draft.prNumber}:${review.id}`,
          status: 'submitted',
          summary: {
            repo: draft.repo,
            prNumber: draft.prNumber,
            verdict,
            commentCount: comments.length,
            skippedCommentCount: draft.comments.length - comments.length,
            neonDraftOutcome,
            reviewUrl: review.url,
            headSha: currentHeadSha,
          },
        },
        options.paths,
      );
    } catch (error) {
      console.error(
        '[neondeck] failed to record submitted review workflow summary',
        error,
      );
    }

    return { draft: submitted, review };
  } catch (error) {
    const definitelyRejected =
      error instanceof GitHubApiError &&
      githubReviewSubmissionWasDefinitelyRejected(error);
    if (!githubRequestStarted || definitelyRejected) {
      releaseDraftSubmissionLease(options.databasePath, draft.id);
    }
    if (error instanceof GitHubPrReviewSubmitError) throw error;
    const message = errorMessage(error);
    if (isLikelyInsufficientScopeError(error, message)) {
      throw new GitHubPrReviewSubmitError({
        code: 'insufficient-scope',
        message:
          'GitHub token needs pull request write access to submit reviews.',
        requires: ['pull_requests:write'],
      });
    }
    if (
      !(error instanceof GitHubApiError) ||
      !githubReviewSubmissionWasDefinitelyRejected(error)
    ) {
      throw new GitHubPrReviewSubmitError({
        code: 'submission-uncertain',
        message:
          'GitHub review submission could not be confirmed. Reconcile before retrying.',
        requires: ['submissionReconciliation'],
      });
    }
    throw new GitHubPrReviewSubmitError({
      code: 'github-review-submit-failed',
      message,
      failingCommentIds: failingReviewCommentIdsFromGitHubError(
        error,
        attemptedComments,
      ),
    });
  }
}

function markNeonDraftSeedOutcomes(
  databasePath: string,
  draft: GitHubPrReviewDraft,
  submittedComments: GitHubPrReviewDraftComment[],
) {
  const database = openDb(databasePath);
  try {
    return summarizeAndPersistNeonDraftOutcome(
      database,
      draft,
      submittedComments,
    );
  } finally {
    database.close();
  }
}

function summarizeAndPersistNeonDraftOutcome(
  database: ReturnType<typeof openDb>,
  draft: GitHubPrReviewDraft,
  submittedComments: GitHubPrReviewDraftComment[],
) {
  const seeds = readNeonSeedsForDraft(database, draft.id);
  const survivingCommentsById = new Map(
    draft.comments.map((comment) => [comment.id, comment]),
  );
  const submittedCommentsById = new Map(
    submittedComments.map((comment) => [comment.id, comment]),
  );
  const now = new Date().toISOString();
  const submittedSeeds = [];
  const skippedSeeds = [];
  const deletedSeeds = [];
  const severityCounts: Record<
    string,
    {
      seeded: number;
      submitted: number;
      skipped: number;
      deleted: number;
      editedSubmitted: number;
    }
  > = {};

  for (const seed of seeds) {
    const severity = severityCounts[seed.severity] ?? {
      seeded: 0,
      submitted: 0,
      skipped: 0,
      deleted: 0,
      editedSubmitted: 0,
    };
    severity.seeded += 1;
    severityCounts[seed.severity] = severity;

    const submittedComment = submittedCommentsById.get(seed.commentId);
    const outcome: GitHubPrReviewNeonSeedOutcome = submittedComment
      ? 'submitted'
      : survivingCommentsById.has(seed.commentId)
        ? 'skipped'
        : 'deleted';
    database
      .prepare(
        `
        UPDATE pr_review_neon_seeded_comments
        SET outcome = ?,
            outcome_at = ?
        WHERE comment_id = ?;
      `,
      )
      .run(outcome, now, seed.commentId);

    if (outcome === 'submitted') {
      if (!submittedComment) continue;
      submittedSeeds.push(seed);
      severity.submitted += 1;
      if (submittedComment.updatedAt !== submittedComment.createdAt) {
        severity.editedSubmitted += 1;
      }
      continue;
    }
    if (outcome === 'skipped') {
      skippedSeeds.push(seed);
      severity.skipped += 1;
      continue;
    }
    deletedSeeds.push(seed);
    severity.deleted += 1;
  }

  const editedSubmitted = submittedSeeds.filter((seed) => {
    const comment = submittedCommentsById.get(seed.commentId);
    return Boolean(comment && comment.updatedAt !== comment.createdAt);
  });

  return {
    seededNeonCommentCount: seeds.length,
    survivingNeonCommentCount: seeds.filter((seed) =>
      survivingCommentsById.has(seed.commentId),
    ).length,
    submittedNeonCommentCount: submittedSeeds.length,
    skippedNeonCommentCount: skippedSeeds.length,
    deletedNeonCommentCount: deletedSeeds.length,
    skippedOrDeletedNeonCommentCount: skippedSeeds.length + deletedSeeds.length,
    editedSubmittedNeonCommentCount: editedSubmitted.length,
    submittedNeonCommentIds: submittedSeeds.map((seed) => seed.commentId),
    skippedNeonCommentIds: skippedSeeds.map((seed) => seed.commentId),
    deletedNeonCommentIds: deletedSeeds.map((seed) => seed.commentId),
    bySeverity: severityCounts,
  };
}

function readNeonSeedByCommentId(
  database: ReturnType<typeof openDb>,
  commentId: string,
) {
  const row = database
    .prepare(
      `
      SELECT *
      FROM pr_review_neon_seeded_comments
      WHERE comment_id = ?
      LIMIT 1;
    `,
    )
    .get(commentId);
  if (!row) throw new Error('Neon review seed ledger row was not recorded.');
  return readNeonSeedRow(row);
}

function readNeonSeedsForDraft(
  database: ReturnType<typeof openDb>,
  draftId: string,
) {
  return database
    .prepare(
      `
      SELECT *
      FROM pr_review_neon_seeded_comments
      WHERE draft_id = ?
      ORDER BY seeded_at ASC;
    `,
    )
    .all(draftId)
    .map(readNeonSeedRow);
}

function readNeonSeedRow(row: unknown): GitHubPrReviewNeonSeededComment {
  const parsed = v.parse(neonSeedRowSchema, row);
  return {
    commentId: parsed.comment_id,
    draftId: parsed.draft_id,
    repo: parsed.repo,
    prNumber: parsed.pr_number,
    headSha: parsed.head_sha,
    path: parsed.path,
    side: parsed.side,
    line: parsed.line,
    startLine: parsed.start_line,
    startSide: parsed.start_side,
    severity: parsed.severity,
    summary: parsed.summary,
    source: parsed.source,
    outcome: parsed.outcome,
    outcomeAt: parsed.outcome_at,
    seededAt: parsed.seeded_at,
  };
}

function truncateSeedSummary(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 1_000 ? `${trimmed.slice(0, 1_000)}...` : trimmed;
}

export async function replyToPullRequestReviewThread(options: {
  token: string;
  threadId: string;
  body: string;
}): Promise<GitHubPullRequestReviewThread> {
  try {
    await githubGraphqlFetch(options.token, replyReviewThreadMutation, {
      threadId: options.threadId,
      body: options.body,
    });
  } catch (error) {
    throw rewriteThreadMutationError(error);
  }

  return fetchPullRequestReviewThread({
    token: options.token,
    threadId: options.threadId,
  });
}

export async function resolvePullRequestReviewThread(options: {
  token: string;
  threadId: string;
}): Promise<GitHubPullRequestReviewThread> {
  try {
    await githubGraphqlFetch(options.token, resolveReviewThreadMutation, {
      threadId: options.threadId,
    });
  } catch (error) {
    throw rewriteThreadMutationError(error);
  }

  return fetchPullRequestReviewThread({
    token: options.token,
    threadId: options.threadId,
  });
}

export async function unresolvePullRequestReviewThread(options: {
  token: string;
  threadId: string;
}): Promise<GitHubPullRequestReviewThread> {
  try {
    await githubGraphqlFetch(options.token, unresolveReviewThreadMutation, {
      threadId: options.threadId,
    });
  } catch (error) {
    throw rewriteThreadMutationError(error);
  }

  return fetchPullRequestReviewThread({
    token: options.token,
    threadId: options.threadId,
  });
}

function readDraftWithComments(
  database: ReturnType<typeof openDb>,
  row: unknown,
) {
  const draft = readDraftRow(row);
  return {
    ...draft,
    comments: readDraftComments(database, draft.id),
  };
}

function updateExistingReviewDraft(
  database: ReturnType<typeof openDb>,
  row: unknown,
  options: {
    headSha?: string;
    verdict?: GitHubPrReviewVerdict | null;
    body?: string | null;
    reanchorHeadSha?: boolean;
    expectedRevision?: number;
  },
  updatedAt: string,
) {
  const draft = readDraftRow(row);
  if (options.expectedRevision === undefined) {
    throw new Error('Review draft revision is required.');
  }
  const nextVerdict =
    'verdict' in options ? (options.verdict ?? null) : draft.verdict;
  const nextBody =
    'body' in options ? normalizeNullableBody(options.body) : draft.body;
  const repository = new ReviewDraftRepository(database);
  return repository.withEditableMutation(
    {
      draftId: draft.id,
      expectedRevision: options.expectedRevision,
    },
    () => {
      const result = database
        .prepare(
          `UPDATE pr_review_drafts
           SET head_sha = ?, verdict = ?, body = ?
           WHERE id = ?;`,
        )
        .run(
          options.reanchorHeadSha
            ? (options.headSha ?? draft.headSha)
            : draft.headSha,
          nextVerdict,
          nextBody,
          draft.id,
        );
      if (result.changes !== 1) {
        throw new Error('Review draft is not editable.');
      }
      return true;
    },
    () => readDraftWithCommentsById(database, draft.id),
    updatedAt,
  );
}

function readDraftWithCommentsById(
  database: ReturnType<typeof openDb>,
  draftId: string,
) {
  const row = database
    .prepare('SELECT * FROM pr_review_drafts WHERE id = ?;')
    .get(draftId);
  if (!row) throw new Error('Review draft not found.');
  return readDraftWithComments(database, row);
}

function readDraftRow(row: unknown): Omit<GitHubPrReviewDraft, 'comments'> {
  const parsed = v.parse(draftRowSchema, row);
  return {
    id: parsed.id,
    repo: parsed.repo,
    prNumber: parsed.pr_number,
    headSha: parsed.head_sha,
    verdict: parsed.verdict,
    body: parsed.body,
    status: parsed.status,
    revision: parsed.revision,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    submittedAt: parsed.submitted_at,
  };
}

function readDraftComments(
  database: ReturnType<typeof openDb>,
  draftId: string,
): GitHubPrReviewDraftComment[] {
  return database
    .prepare(
      `
      SELECT
        comments.*,
        seeds.severity AS neon_severity,
        seeds.summary AS neon_summary
      FROM pr_review_draft_comments AS comments
      LEFT JOIN pr_review_neon_seeded_comments AS seeds
        ON seeds.comment_id = comments.id
      WHERE comments.draft_id = ?
      ORDER BY comments.created_at ASC;
    `,
    )
    .all(draftId)
    .map((row) => {
      const parsed = v.parse(draftCommentRowSchema, row);
      const seed = v.parse(
        v.object({
          neon_severity: v.nullable(reviewNeonSeedSeveritySchema),
          neon_summary: v.nullable(v.string()),
        }),
        row,
      );
      return {
        id: parsed.id,
        draftId: parsed.draft_id,
        path: parsed.path,
        side: parsed.side,
        line: parsed.line,
        startLine: parsed.start_line,
        startSide: parsed.start_side,
        body:
          parsed.origin === 'neon'
            ? prefixBotComment(unbrandedGeneratedCommentBody(parsed.body))
            : parsed.body,
        origin: parsed.origin,
        sourceFindingId: parsed.source_finding_id,
        neonSeverity: seed.neon_severity,
        neonSummary: seed.neon_summary,
        createdAt: parsed.created_at,
        updatedAt: parsed.updated_at,
      };
    });
}

function unbrandedGeneratedCommentBody(body: string) {
  return body
    .replace(/^Neon review finding \([^)\n]+\): /, '')
    .replace(
      /\n\nGenerated by Neon\. Edit or delete before submitting the review\.$/,
      '',
    )
    .replace(
      /\n\nManually anchored from a report-only finding\. Edit or delete before submitting the review\.$/,
      '',
    );
}

function markDraftSubmitted(options: {
  databasePath: string;
  draftId: string;
  deliveryFollowupId: string;
  deliveryPayload: (draft: GitHubPrReviewDraft) => unknown;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    const current = database
      .prepare('SELECT updated_at FROM pr_review_drafts WHERE id = ?;')
      .get(options.draftId) as { updated_at?: unknown } | undefined;
    const submittedAt = nextReviewDraftUpdatedAt(
      typeof current?.updated_at === 'string' ? current.updated_at : null,
      now,
    );
    const updated = database
      .prepare(
        `
        UPDATE pr_review_drafts
        SET status = 'submitted',
            submitted_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'submitting';
      `,
      )
      .run(submittedAt, submittedAt, options.draftId);
    if (updated.changes !== 1) {
      throw new Error('Review draft submission lease was lost.');
    }
    const submitted = readDraftWithCommentsById(database, options.draftId);
    database
      .prepare(
        `INSERT INTO pr_review_submission_followups (
           id, kind, payload_json, status, attempt_count,
           next_attempt_at, last_error, created_at, updated_at, completed_at
         ) VALUES (?, 'delivery', ?, 'pending', 0, ?, NULL, ?, ?, NULL)
         ON CONFLICT(id) DO NOTHING;`,
      )
      .run(
        options.deliveryFollowupId,
        JSON.stringify(options.deliveryPayload(submitted)),
        submittedAt,
        submittedAt,
        submittedAt,
      );
    database.exec('COMMIT;');
    return submitted;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the submission settlement failure.
    }
    throw error;
  } finally {
    database.close();
  }
}

function leaseDraftForSubmission(options: {
  databasePath: string;
  draftId: string;
  expectedRepo: string;
  expectedPrNumber: number;
  expectedRevision: number;
}) {
  const database = openDb(options.databasePath);
  try {
    database.exec('BEGIN IMMEDIATE;');
    const row = database
      .prepare(
        `
        SELECT *
        FROM pr_review_drafts
        WHERE id = ?
          AND repo = ? COLLATE NOCASE
          AND pr_number = ?
          AND status = 'draft'
          AND revision = ?
        LIMIT 1;
      `,
      )
      .get(
        options.draftId,
        options.expectedRepo,
        options.expectedPrNumber,
        options.expectedRevision,
      );
    if (!row) {
      throw new GitHubPrReviewSubmitError({
        code: 'draft-not-found',
        message: 'Review draft changed or is no longer editable.',
      });
    }
    const updated = database
      .prepare(
        `
        UPDATE pr_review_drafts
        SET status = 'submitting'
        WHERE id = ?
          AND status = 'draft'
          AND revision = ?;
      `,
      )
      .run(options.draftId, options.expectedRevision);
    if (updated.changes !== 1) {
      throw new GitHubPrReviewSubmitError({
        code: 'draft-not-found',
        message: 'Review draft changed before submission could start.',
      });
    }
    const draft = readDraftWithCommentsById(database, options.draftId);
    database.exec('COMMIT;');
    return draft;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the lease failure if SQLite already ended the transaction.
    }
    throw error;
  } finally {
    database.close();
  }
}

function releaseDraftSubmissionLease(databasePath: string, draftId: string) {
  const database = openDb(databasePath);
  try {
    database
      .prepare(
        `
        UPDATE pr_review_drafts
        SET status = 'draft'
        WHERE id = ?
          AND status = 'submitting';
      `,
      )
      .run(draftId);
  } finally {
    database.close();
  }
}

export function settlePrReviewDraftSubmission(options: {
  databasePath: string;
  draftId: string;
  expectedRevision: number;
  submitted: boolean;
}) {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    database.exec('BEGIN IMMEDIATE;');
    const current = database
      .prepare(
        `SELECT status, revision, updated_at
         FROM pr_review_drafts
         WHERE id = ?;`,
      )
      .get(options.draftId) as
      | { status?: unknown; revision?: unknown; updated_at?: unknown }
      | undefined;
    const desiredStatus = options.submitted ? 'submitted' : 'draft';
    if (current?.status === desiredStatus) {
      database.exec('COMMIT;');
      return true;
    }
    if (
      current?.status !== 'submitting' ||
      current.revision !== options.expectedRevision
    ) {
      database.exec('COMMIT;');
      return false;
    }
    const settledAt = nextReviewDraftUpdatedAt(
      typeof current.updated_at === 'string' ? current.updated_at : null,
      now,
    );
    const result = database
      .prepare(
        `
        UPDATE pr_review_drafts
        SET status = ?,
            submitted_at = CASE WHEN ? = 'submitted' THEN ? ELSE NULL END,
            updated_at = ?
        WHERE id = ?
          AND status = 'submitting'
          AND revision = ?;
      `,
      )
      .run(
        desiredStatus,
        desiredStatus,
        settledAt,
        settledAt,
        options.draftId,
        options.expectedRevision,
      );
    database.exec('COMMIT;');
    return result.changes === 1;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the settlement failure if SQLite ended the transaction.
    }
    throw error;
  } finally {
    database.close();
  }
}

function githubReviewSubmissionWasDefinitelyRejected(error: GitHubApiError) {
  if (/rate limit|secondary rate|abuse detection/i.test(error.message)) {
    return false;
  }
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 409 &&
    error.status !== 425 &&
    error.status !== 429
  );
}

async function readCurrentPullRequestHeadSha(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  fetchHeadSha?: (options: {
    token: string;
    owner: string;
    repo: string;
    number: number;
  }) => Promise<string | null | undefined>;
}) {
  const fetchHeadSha =
    options.fetchHeadSha ??
    (async (input: {
      token: string;
      owner: string;
      repo: string;
      number: number;
    }) => (await fetchPullRequestDetail(input)).headSha);
  const headSha = await fetchHeadSha({
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    number: options.number,
  });
  if (!headSha) {
    throw new GitHubPrReviewSubmitError({
      code: 'stale-draft',
      message: 'Current PR head SHA is unavailable.',
    });
  }
  return headSha;
}

async function createPullRequestReview(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  verdict: GitHubPrReviewVerdict;
  body: string;
  comments: GitHubPrReviewDraftComment[];
}): Promise<GitHubSubmittedPullRequestReview> {
  const response = await githubFetch(
    options.token,
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/reviews`,
    {
      method: 'POST',
      body: JSON.stringify({
        commit_id: options.headSha,
        event: reviewEvent(options.verdict),
        body: options.body,
        comments: options.comments.map(reviewCommentPayload),
      }),
    },
  );
  const review = v.parse(
    githubPullRequestReviewCreatedApiResponseSchema,
    await response.json(),
  );

  return {
    id: review.id,
    nodeId: review.node_id ?? null,
    state: review.state,
    authorLogin: review.user?.login ?? null,
    authorType: review.user?.type ?? null,
    authorIsBot:
      review.user?.type === undefined ? undefined : review.user.type === 'Bot',
    submittedAt: review.submitted_at ?? null,
    commitId: review.commit_id ?? null,
    url: review.html_url ?? null,
    body:
      'body' in review && typeof review.body === 'string' ? review.body : null,
  };
}

function reviewEvent(verdict: GitHubPrReviewVerdict) {
  if (verdict === 'approve') return 'APPROVE';
  if (verdict === 'request-changes') return 'REQUEST_CHANGES';
  return 'COMMENT';
}

function reviewCommentPayload(comment: GitHubPrReviewDraftComment) {
  return {
    path: comment.path,
    side: comment.side,
    line: comment.line,
    ...(comment.startLine ? { start_line: comment.startLine } : {}),
    ...(comment.startSide ? { start_side: comment.startSide } : {}),
    body: comment.body,
  };
}

function assertValidReviewCommentAnchor(options: {
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  startLine?: number | null;
  startSide?: GitHubPrReviewDraftCommentSide | null;
}) {
  if (options.line < 1 || !Number.isInteger(options.line)) {
    throw new Error('Review comment line must be a positive integer.');
  }
  if (options.startLine == null) return;
  if (options.startLine < 1 || !Number.isInteger(options.startLine)) {
    throw new Error('Review comment start line must be a positive integer.');
  }
  const startSide = options.startSide ?? options.side;
  if (startSide === options.side && options.startLine > options.line) {
    throw new Error('Review comment range start must not follow the end line.');
  }
  if (startSide === 'RIGHT' && options.side === 'LEFT') {
    throw new Error('Review comment cross-side range must start on LEFT.');
  }
}

function normalizeNullableBody(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isLikelyInsufficientScopeError(error: unknown, message: string) {
  if (
    error instanceof GitHubApiError &&
    error.status === 403 &&
    !/rate limit|secondary rate|abuse detection/i.test(message)
  ) {
    return true;
  }
  return /Resource not accessible by integration|pull request write access/i.test(
    message,
  );
}

function failingReviewCommentIdsFromGitHubError(
  error: unknown,
  comments: GitHubPrReviewDraftComment[],
) {
  if (!(error instanceof GitHubApiError)) {
    return comments.map((comment) => comment.id);
  }
  const indexed = failingReviewCommentIndexes(error.data);
  if (indexed.size > 0) {
    return comments
      .filter((_comment, index) => indexed.has(index))
      .map((comment) => comment.id);
  }
  const matched = comments.filter((comment) =>
    githubErrorDataMentionsComment(error.data, comment),
  );
  return matched.length > 0
    ? matched.map((comment) => comment.id)
    : comments.map((comment) => comment.id);
}

function failingReviewCommentIndexes(data: unknown) {
  const indexes = new Set<number>();
  for (const item of githubErrorItems(data)) {
    const text = Object.values(item)
      .filter((value) => typeof value === 'string' || typeof value === 'number')
      .join(' ');
    for (const match of text.matchAll(/comments\[(\d+)]/gi)) {
      indexes.add(Number(match[1]));
    }
  }
  return indexes;
}

function githubErrorDataMentionsComment(
  data: unknown,
  comment: GitHubPrReviewDraftComment,
) {
  const lineNeedles = [
    `line ${comment.line}`,
    `line:${comment.line}`,
    `line: ${comment.line}`,
    `"line":${comment.line}`,
  ];
  return githubErrorItems(data).some((item) => {
    const text = JSON.stringify(item);
    return (
      text.includes(comment.path) &&
      lineNeedles.some((needle) => text.includes(needle))
    );
  });
}

function githubErrorItems(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== 'object') return [];
  const errors = 'errors' in data ? data.errors : null;
  if (!Array.isArray(errors)) return [];
  return errors.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object',
  );
}

function rewriteThreadMutationError(error: unknown) {
  const message = errorMessage(error);
  if (isLikelyInsufficientScopeError(error, message)) {
    return new Error(
      'GitHub token needs pull request write access to update review threads.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}
