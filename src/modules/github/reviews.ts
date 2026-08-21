import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { prefixBotComment } from '../../../shared/bot-comments';
import { isUniqueConstraintError, openDb } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import { addWorkflowSummary } from '../app-state';
import {
  encodePathSegment,
  githubFetch,
  githubGraphqlFetch,
  nextLink,
} from './client';
import { fetchPullRequestReviewThread } from './comments';
import { GitHubApiError, errorMessage } from './errors';
import { fetchPullRequestDetail } from './pull-requests';
import {
  githubPullRequestReviewApiItemSchema,
  githubPullRequestReviewCommentApiItemSchema,
  githubPullRequestReviewCreatedApiResponseSchema,
} from './schemas';
import type {
  GitHubPullRequestRequestedChangesState,
  GitHubPullRequestReview,
  GitHubPullRequestReviewApiItem,
  GitHubPullRequestReviewCommentApiItem,
  GitHubPullRequestReviewThread,
  GitHubPullRequestReviewThreadComment,
  GitHubSubmittedPullRequestReview,
} from './schemas';
import type { PullRequestEventFetchBudget } from './event-budget';

export type GitHubPrReviewVerdict = 'comment' | 'approve' | 'request-changes';

export type GitHubPrReviewDraftStatus = 'draft' | 'submitted' | 'discarded';

export type GitHubPrReviewDraftCommentSide = 'RIGHT' | 'LEFT';

export type GitHubPrReviewDraftCommentOrigin = 'human' | 'neon';

type GitHubReviewCommentPayload = {
  path: string;
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  start_line?: number;
  start_side?: GitHubPrReviewDraftCommentSide;
  body: string;
};

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
  createdAt: string;
  updatedAt: string;
};

export type GitHubPrReviewNeonSeedSeverity =
  'critical' | 'major' | 'minor' | 'nit';

export type GitHubPrReviewNeonSeedOutcome = 'submitted' | 'skipped' | 'deleted';

const reviewCommentHydrationConcurrency = 4;

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
const draftStatusSchema = v.picklist(['draft', 'submitted', 'discarded']);

const draftRowSchema = v.object({
  id: v.string(),
  repo: v.string(),
  pr_number: v.number(),
  head_sha: v.string(),
  verdict: v.nullable(reviewVerdictSchema),
  body: v.nullable(v.string()),
  status: draftStatusSchema,
  created_at: v.string(),
  updated_at: v.string(),
  submitted_at: v.nullable(v.string()),
});
const draftIdRowSchema = v.looseObject({ draft_id: v.string() });
const draftStatusRowSchema = v.looseObject({
  status: draftStatusSchema,
  head_sha: v.string(),
});
const draftCommentAnchorRowSchema = v.object({
  path: v.string(),
  side: reviewCommentSideSchema,
  line: v.number(),
  start_line: v.nullable(v.number()),
  start_side: v.nullable(reviewCommentSideSchema),
});
const githubErrorItemsSchema = v.looseObject({
  errors: v.optional(v.array(v.unknown())),
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
    const parsed = v.safeParse(
      draftIdRowSchema,
      database
        .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
        .get(options.commentId),
    );
    const draftId = parsed.success ? parsed.output.draft_id : null;
    return draftId ? readDraftWithCommentsById(database, draftId) : null;
  } finally {
    database.close();
  }
}

export function upsertPrReviewDraft(options: {
  databasePath: string;
  repo: string;
  prNumber: number;
  headSha: string;
  verdict?: GitHubPrReviewVerdict | null;
  body?: string | null;
  reanchorHeadSha?: boolean;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  const body = normalizeNullableBody(options.body);
  try {
    const existing = database
      .prepare(
        `
        SELECT *
        FROM pr_review_drafts
        WHERE repo = ? COLLATE NOCASE
          AND pr_number = ?
          AND status = 'draft'
        LIMIT 1;
      `,
      )
      .get(options.repo, options.prNumber);

    if (existing) {
      return updateExistingReviewDraft(database, existing, options, now);
    }

    const id = randomUUID();
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
          options.repo,
          options.prNumber,
          options.headSha,
          options.verdict ?? null,
          body,
          now,
          now,
        );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const winner = database
        .prepare(
          `
          SELECT *
          FROM pr_review_drafts
          WHERE repo = ? COLLATE NOCASE
            AND pr_number = ?
            AND status = 'draft'
          LIMIT 1;
        `,
        )
        .get(options.repo, options.prNumber);
      if (!winner) throw error;
      return updateExistingReviewDraft(database, winner, options, now);
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
  expectedHeadSha: string;
  headSha: string;
}): GitHubPrReviewDraft | null {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    const result = database
      .prepare(
        `
        UPDATE pr_review_drafts
        SET head_sha = ?,
            updated_at = ?
        WHERE id = ?
          AND repo = ? COLLATE NOCASE
          AND pr_number = ?
          AND status = 'draft'
          AND head_sha = ?;
      `,
      )
      .run(
        options.headSha,
        now,
        options.draftId,
        options.repo,
        options.prNumber,
        options.expectedHeadSha,
      );
    return Number(result.changes) === 1
      ? readDraftWithCommentsById(database, options.draftId)
      : null;
  } finally {
    database.close();
  }
}

export function discardPrReviewDraft(options: {
  databasePath: string;
  repo: string;
  prNumber: number;
}): GitHubPrReviewDraft | null {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM pr_review_drafts
        WHERE repo = ? COLLATE NOCASE
          AND pr_number = ?
          AND status = 'draft'
        LIMIT 1;
      `,
      )
      .get(options.repo, options.prNumber);
    if (!row) return null;
    const draft = readDraftRow(row);
    database
      .prepare(
        `
        UPDATE pr_review_drafts
        SET status = 'discarded',
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, draft.id);
    return readDraftWithCommentsById(database, draft.id);
  } finally {
    database.close();
  }
}

export function addPrReviewDraftComment(options: {
  id?: string;
  databasePath: string;
  draftId: string;
  expectedHeadSha?: string;
  path: string;
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  startLine?: number | null;
  startSide?: GitHubPrReviewDraftCommentSide | null;
  body: string;
  origin?: GitHubPrReviewDraftCommentOrigin;
  sourceFindingId?: string | null;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  const origin = options.origin ?? 'human';
  const body =
    origin === 'neon'
      ? prefixBotComment(unbrandedGeneratedCommentBody(options.body))
      : options.body.trim();
  try {
    return withEditableDraftWrite(
      database,
      options.draftId,
      options.expectedHeadSha,
      () => {
        assertValidReviewCommentAnchor(options);
        const id = options.id?.trim() || randomUUID();
        const existing = v.safeParse(
          draftIdRowSchema,
          database
            .prepare(
              'SELECT draft_id FROM pr_review_draft_comments WHERE id = ? LIMIT 1;',
            )
            .get(id),
        );
        if (existing.success) {
          if (existing.output.draft_id !== options.draftId) {
            throw new Error(
              'Review draft comment id belongs to another draft.',
            );
          }
          return readDraftWithCommentsById(database, options.draftId);
        }
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
        touchDraft(database, options.draftId, now);
        return readDraftWithCommentsById(database, options.draftId);
      },
    );
  } finally {
    database.close();
  }
}

export function updatePrReviewDraftComment(options: {
  databasePath: string;
  commentId: string;
  body: string;
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
    const row = v.safeParse(
      draftIdRowSchema,
      database
        .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
        .get(options.commentId),
    );
    const draftId = row.success ? row.output.draft_id : null;
    if (!draftId) throw new Error('Review draft comment not found.');
    return withEditableDraftWrite(
      database,
      draftId,
      options.expectedHeadSha,
      () => {
        const existing = v.safeParse(
          draftCommentAnchorRowSchema,
          database
            .prepare(
              `
            SELECT path, side, line, start_line, start_side
            FROM pr_review_draft_comments
            WHERE id = ?;
          `,
            )
            .get(options.commentId),
        );
        if (!existing.success)
          throw new Error('Review draft comment not found.');
        const nextAnchor = {
          path: options.path ?? existing.output.path,
          side: options.side ?? existing.output.side,
          line: options.line ?? existing.output.line,
          startLine:
            'startLine' in options
              ? (options.startLine ?? null)
              : existing.output.start_line,
          startSide:
            'startSide' in options
              ? (options.startSide ?? null)
              : existing.output.start_side,
        };
        assertValidReviewCommentAnchor(nextAnchor);
        database
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
        touchDraft(database, draftId, now);
        return readDraftWithCommentsById(database, draftId);
      },
    );
  } finally {
    database.close();
  }
}

export function clearPrReviewNeonDraftComments(options: {
  databasePath: string;
  draftId: string;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    assertDraftIsLive(database, options.draftId);
    const result = database
      .prepare(
        `
        DELETE FROM pr_review_draft_comments
        WHERE draft_id = ?
          AND origin = 'neon';
      `,
      )
      .run(options.draftId);
    if (result.changes > 0) touchDraft(database, options.draftId, now);
    return readDraftWithCommentsById(database, options.draftId);
  } finally {
    database.close();
  }
}

export function deletePrReviewDraftComment(options: {
  databasePath: string;
  commentId: string;
  expectedHeadSha?: string;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    const row = v.safeParse(
      draftIdRowSchema,
      database
        .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
        .get(options.commentId),
    );
    const draftId = row.success ? row.output.draft_id : null;
    if (!draftId) throw new Error('Review draft comment not found.');
    return withEditableDraftWrite(
      database,
      draftId,
      options.expectedHeadSha,
      () => {
        database
          .prepare('DELETE FROM pr_review_draft_comments WHERE id = ?;')
          .run(options.commentId);
        touchDraft(database, draftId, now);
        return readDraftWithCommentsById(database, draftId);
      },
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
        now,
      );
    return readNeonSeedByCommentId(database, options.comment.id);
  } finally {
    database.close();
  }
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
  const draft = readPrReviewDraft({
    databasePath: options.databasePath,
    draftId: options.draftId,
  });
  if (!draft || draft.status !== 'draft') {
    throw new GitHubPrReviewSubmitError({
      code: 'draft-not-found',
      message: 'Review draft was not found.',
    });
  }

  const expectedRepo = `${options.owner}/${options.repo}`;
  if (draft.repo !== expectedRepo || draft.prNumber !== options.number) {
    throw new GitHubPrReviewSubmitError({
      code: 'draft-not-found',
      message: 'Review draft does not belong to this pull request.',
    });
  }

  const currentHeadSha = await readCurrentPullRequestHeadSha(options);
  if (draft.headSha !== currentHeadSha || options.headSha !== currentHeadSha) {
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
      : draft.comments.filter((comment) => selectedCommentIds.has(comment.id));
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

  let review: GitHubSubmittedPullRequestReview;
  try {
    review = await createPullRequestReview({
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      number: options.number,
      headSha: currentHeadSha,
      verdict,
      body,
      comments,
    });
  } catch (error) {
    const message = errorMessage(error);
    if (isLikelyInsufficientScopeError(error, message)) {
      throw new GitHubPrReviewSubmitError({
        code: 'insufficient-scope',
        message:
          'GitHub token needs pull request write access to submit reviews.',
        requires: ['pull_requests:write'],
      });
    }
    throw new GitHubPrReviewSubmitError({
      code: 'github-review-submit-failed',
      message,
      failingCommentIds: failingReviewCommentIdsFromGitHubError(
        error,
        comments,
      ),
    });
  }

  const neonDraftOutcome = markNeonDraftSeedOutcomes(
    options.databasePath,
    draft,
    comments,
  );
  const submitted = markDraftSubmitted(options.databasePath, draft.id);
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

  return { draft: submitted, review };
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

function readNeonSeedRow<TRow>(row: TRow): GitHubPrReviewNeonSeededComment {
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

export async function fetchPullRequestReviews(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestReview[]> {
  return (await fetchPullRequestReviewsWithMetadata(options)).reviews;
}

export async function fetchPullRequestReviewComments(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  reviewId: number;
}): Promise<GitHubPullRequestReviewThreadComment[]> {
  const comments: GitHubPullRequestReviewCommentApiItem[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/reviews/${options.reviewId}/comments?per_page=100`;
  for (let page = 0; nextUrl && page < 100; page += 1) {
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      v.array(githubPullRequestReviewCommentApiItemSchema),
      await response.json(),
    );
    comments.push(...data);
    nextUrl = nextLink(response.headers.get('link'));
  }
  if (nextUrl) {
    throw new Error(
      `Pull request review ${options.reviewId} has more than 10,000 comments; refusing an incomplete delivery-identity check.`,
    );
  }
  if (
    comments.some(
      (comment) => comment.pull_request_review_id !== options.reviewId,
    )
  ) {
    throw new Error(
      `GitHub returned a comment outside submitted review ${options.reviewId}.`,
    );
  }
  const commentsWithExactAnchors = await mapWithConcurrency(
    comments,
    reviewCommentHydrationConcurrency,
    async (comment) =>
      comment.line == null || comment.side == null
        ? fetchPullRequestReviewComment(options, comment.id)
        : comment,
  );
  return commentsWithExactAnchors.map(reviewThreadCommentFromApi);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item !== undefined) results[index] = await task(item);
      }
    }),
  );
  return results;
}

async function fetchPullRequestReviewComment(
  options: {
    token: string;
    owner: string;
    repo: string;
    reviewId: number;
  },
  commentId: number,
) {
  const response = await githubFetch(
    options.token,
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/comments/${commentId}`,
  );
  const comment = v.parse(
    githubPullRequestReviewCommentApiItemSchema,
    await response.json(),
  );
  if (
    comment.id !== commentId ||
    comment.pull_request_review_id !== options.reviewId
  ) {
    throw new Error(
      `GitHub returned comment ${comment.id} outside submitted review ${options.reviewId}.`,
    );
  }
  return comment;
}

function reviewThreadCommentFromApi(
  comment: GitHubPullRequestReviewCommentApiItem,
): GitHubPullRequestReviewThreadComment {
  return {
    id: comment.node_id ?? String(comment.id),
    databaseId: comment.id,
    authorLogin: comment.user?.login ?? null,
    authorType: comment.user?.type ?? null,
    authorIsBot:
      comment.user?.type === undefined
        ? undefined
        : comment.user.type === 'Bot',
    body: comment.body,
    url: comment.html_url ?? null,
    path: comment.path,
    side: comment.side ?? null,
    line: comment.line ?? comment.original_line ?? null,
    startLine: comment.start_line ?? comment.original_start_line ?? null,
    startSide:
      comment.start_line != null || comment.original_start_line != null
        ? (comment.start_side ?? null)
        : null,
    originalLine: comment.original_line ?? null,
    diffHunk: comment.diff_hunk ?? null,
    reviewId: comment.pull_request_review_id,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

export async function fetchPullRequestReviewsWithMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  eventBudget?: PullRequestEventFetchBudget;
}): Promise<{ reviews: GitHubPullRequestReview[]; truncated: boolean }> {
  const reviews: GitHubPullRequestReviewApiItem[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/reviews?per_page=100`;
  let pageCount = 0;

  while (
    nextUrl &&
    pageCount < 3 &&
    (options.eventBudget?.canFetch('requested_changes_reviews') ?? true)
  ) {
    pageCount += 1;
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      v.array(githubPullRequestReviewApiItemSchema),
      await response.json(),
    );
    let admittedPage = true;
    for (const review of data) {
      if (
        options.eventBudget?.admit('requested_changes_reviews', review) ===
        false
      ) {
        admittedPage = false;
        break;
      }
      reviews.push(review);
    }
    nextUrl = nextLink(response.headers.get('link'));
    if (!admittedPage) break;
  }

  return {
    reviews: reviews.map((review) => ({
      id: review.id,
      nodeId: review.node_id ?? null,
      state: review.state,
      authorLogin: review.user?.login ?? null,
      authorType: review.user?.type ?? null,
      authorIsBot:
        review.user?.type === undefined
          ? undefined
          : review.user.type === 'Bot',
      submittedAt: review.submitted_at ?? null,
      commitId: review.commit_id ?? null,
      url: review.html_url ?? null,
      body: review.body ?? null,
      bodyTruncated: false,
    })),
    truncated:
      Boolean(nextUrl) ||
      Boolean(options.eventBudget?.exhausted('requested_changes_reviews')),
  };
}

export function requestedChangesStateFromReviews(
  reviews: GitHubPullRequestReview[],
): GitHubPullRequestRequestedChangesState {
  const relevantStates = new Set([
    'APPROVED',
    'CHANGES_REQUESTED',
    'DISMISSED',
  ]);
  const history = reviews
    .filter((review) => relevantStates.has(review.state))
    .sort(compareReviewAge);
  const latestByReviewer = Array.from(
    history
      .reduce((items, review) => {
        items.set(review.authorLogin ?? `review:${review.id}`, review);
        return items;
      }, new Map<string, GitHubPullRequestReview>())
      .values(),
  ).sort(compareReviewAge);

  return {
    active: latestByReviewer.filter(
      (review) => review.state === 'CHANGES_REQUESTED',
    ),
    latestByReviewer,
    history,
  };
}

function compareReviewAge(
  left: GitHubPullRequestReview,
  right: GitHubPullRequestReview,
) {
  const leftTime = left.submittedAt ? Date.parse(left.submittedAt) : 0;
  const rightTime = right.submittedAt ? Date.parse(right.submittedAt) : 0;
  return leftTime - rightTime || left.id - right.id;
}

function readDraftWithComments<TRow>(
  database: ReturnType<typeof openDb>,
  row: TRow,
) {
  const draft = readDraftRow(row);
  return {
    ...draft,
    comments: readDraftComments(database, draft.id),
  };
}

function updateExistingReviewDraft<TRow>(
  database: ReturnType<typeof openDb>,
  row: TRow,
  options: {
    headSha?: string;
    verdict?: GitHubPrReviewVerdict | null;
    body?: string | null;
    reanchorHeadSha?: boolean;
  },
  updatedAt: string,
) {
  const draft = readDraftRow(row);
  const nextVerdict =
    'verdict' in options ? (options.verdict ?? null) : draft.verdict;
  const nextBody =
    'body' in options ? normalizeNullableBody(options.body) : draft.body;
  database
    .prepare(
      `
      UPDATE pr_review_drafts
      SET head_sha = ?,
          verdict = ?,
          body = ?,
          updated_at = ?
      WHERE id = ?;
    `,
    )
    .run(
      options.reanchorHeadSha
        ? (options.headSha ?? draft.headSha)
        : draft.headSha,
      nextVerdict,
      nextBody,
      updatedAt,
      draft.id,
    );
  return readDraftWithCommentsById(database, draft.id);
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

function readDraftRow<TRow>(row: TRow): Omit<GitHubPrReviewDraft, 'comments'> {
  const parsed = v.parse(draftRowSchema, row);
  return {
    id: parsed.id,
    repo: parsed.repo,
    prNumber: parsed.pr_number,
    headSha: parsed.head_sha,
    verdict: parsed.verdict,
    body: parsed.body,
    status: parsed.status,
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
      SELECT *
      FROM pr_review_draft_comments
      WHERE draft_id = ?
      ORDER BY created_at ASC;
    `,
    )
    .all(draftId)
    .map((row) => {
      const parsed = v.parse(draftCommentRowSchema, row);
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

function assertDraftIsLive(
  database: ReturnType<typeof openDb>,
  draftId: string,
  expectedHeadSha?: string,
) {
  const row = v.safeParse(
    draftStatusRowSchema,
    database
      .prepare('SELECT status, head_sha FROM pr_review_drafts WHERE id = ?;')
      .get(draftId),
  );
  if (!row.success || row.output.status !== 'draft') {
    throw new Error('Review draft is not editable.');
  }
  if (expectedHeadSha && row.output.head_sha !== expectedHeadSha) {
    throw new Error(
      'Review draft no longer matches the expected head revision.',
    );
  }
}

function withEditableDraftWrite<T>(
  database: ReturnType<typeof openDb>,
  draftId: string,
  expectedHeadSha: string | undefined,
  write: () => T,
) {
  if (!expectedHeadSha) {
    assertDraftIsLive(database, draftId);
    return write();
  }
  database.exec('BEGIN IMMEDIATE;');
  try {
    assertDraftIsLive(database, draftId, expectedHeadSha);
    const result = write();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the write failure if SQLite already ended the transaction.
    }
    throw error;
  }
}

function touchDraft(
  database: ReturnType<typeof openDb>,
  draftId: string,
  updatedAt: string,
) {
  database
    .prepare('UPDATE pr_review_drafts SET updated_at = ? WHERE id = ?;')
    .run(updatedAt, draftId);
}

function markDraftSubmitted(
  databasePath: string,
  draftId: string,
): GitHubPrReviewDraft {
  const database = openDb(databasePath);
  const now = new Date().toISOString();
  try {
    database
      .prepare(
        `
        UPDATE pr_review_drafts
        SET status = 'submitted',
            submitted_at = ?,
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, now, draftId);
    return readDraftWithCommentsById(database, draftId);
  } finally {
    database.close();
  }
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
    body: reviewBody(review),
  };
}

function reviewEvent(verdict: GitHubPrReviewVerdict) {
  if (verdict === 'approve') return 'APPROVE';
  if (verdict === 'request-changes') return 'REQUEST_CHANGES';
  return 'COMMENT';
}

function reviewBody<TReview>(review: TReview) {
  const parsed = v.safeParse(v.looseObject({ body: v.string() }), review);
  return parsed.success ? parsed.output.body : null;
}

function reviewCommentPayload(
  comment: GitHubPrReviewDraftComment,
): GitHubReviewCommentPayload {
  const payload: GitHubReviewCommentPayload = {
    path: comment.path,
    side: comment.side,
    line: comment.line,
    body: comment.body,
  };
  if (comment.startLine) payload.start_line = comment.startLine;
  if (comment.startSide) payload.start_side = comment.startSide;
  return payload;
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

function isLikelyInsufficientScopeError<TError>(
  error: TError,
  message: string,
) {
  if (error instanceof GitHubApiError && error.status === 403) return true;
  return /Resource not accessible by integration|pull request write access/i.test(
    message,
  );
}

function failingReviewCommentIdsFromGitHubError<TError>(
  error: TError,
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

function failingReviewCommentIndexes<TData>(data: TData) {
  const indexes = new Set<number>();
  for (const item of githubErrorItems(data)) {
    const text = Object.values(item)
      .flatMap((value) => {
        const parsed = v.safeParse(v.union([v.string(), v.number()]), value);
        return parsed.success ? [parsed.output] : [];
      })
      .join(' ');
    for (const match of text.matchAll(/comments\[(\d+)]/gi)) {
      indexes.add(Number(match[1]));
    }
  }
  return indexes;
}

function githubErrorDataMentionsComment<TData>(
  data: TData,
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

function githubErrorItems<TData>(data: TData) {
  const parsed = v.safeParse(githubErrorItemsSchema, data);
  if (!parsed.success) return [];
  return (parsed.output.errors ?? []).flatMap((item) => {
    const parsedItem = v.safeParse(v.looseObject({}), item);
    return parsedItem.success ? [parsedItem.output] : [];
  });
}

function rewriteThreadMutationError<TError>(error: TError) {
  const message = errorMessage(error);
  if (isLikelyInsufficientScopeError(error, message)) {
    return new Error(
      'GitHub token needs pull request write access to update review threads.',
    );
  }
  return error instanceof Error ? error : new Error(message);
}
