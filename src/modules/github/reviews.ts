import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
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
  githubPullRequestReviewCreatedApiResponseSchema,
} from './schemas';
import type {
  GitHubPullRequestRequestedChangesState,
  GitHubPullRequestReview,
  GitHubPullRequestReviewApiItem,
  GitHubPullRequestReviewThread,
  GitHubSubmittedPullRequestReview,
} from './schemas';

export type GitHubPrReviewVerdict = 'comment' | 'approve' | 'request-changes';

export type GitHubPrReviewDraftStatus = 'draft' | 'submitted' | 'discarded';

export type GitHubPrReviewDraftCommentSide = 'RIGHT' | 'LEFT';

export type GitHubPrReviewDraftComment = {
  id: string;
  draftId: string;
  path: string;
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  startLine: number | null;
  startSide: GitHubPrReviewDraftCommentSide | null;
  body: string;
  createdAt: string;
  updatedAt: string;
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

const draftCommentRowSchema = v.object({
  id: v.string(),
  draft_id: v.string(),
  path: v.string(),
  side: reviewCommentSideSchema,
  line: v.number(),
  start_line: v.nullable(v.number()),
  start_side: v.nullable(reviewCommentSideSchema),
  body: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
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
        WHERE repo = ?
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
        WHERE repo = ?
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
          WHERE repo = ?
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
        WHERE repo = ?
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
  databasePath: string;
  draftId: string;
  path: string;
  side: GitHubPrReviewDraftCommentSide;
  line: number;
  startLine?: number | null;
  startSide?: GitHubPrReviewDraftCommentSide | null;
  body: string;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    assertDraftIsLive(database, options.draftId);
    assertValidReviewCommentAnchor(options);
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
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        options.draftId,
        options.path,
        options.side,
        options.line,
        options.startLine ?? null,
        options.startSide ?? null,
        options.body.trim(),
        now,
        now,
      );
    touchDraft(database, options.draftId, now);
    return readDraftWithCommentsById(database, options.draftId);
  } finally {
    database.close();
  }
}

export function updatePrReviewDraftComment(options: {
  databasePath: string;
  commentId: string;
  body: string;
  path?: string;
  side?: GitHubPrReviewDraftCommentSide;
  line?: number;
  startLine?: number | null;
  startSide?: GitHubPrReviewDraftCommentSide | null;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    const row = database
      .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
      .get(options.commentId) as { draft_id?: unknown } | undefined;
    const draftId = typeof row?.draft_id === 'string' ? row.draft_id : null;
    if (!draftId) throw new Error('Review draft comment not found.');
    assertDraftIsLive(database, draftId);
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
        options.body.trim(),
        now,
        options.commentId,
      );
    touchDraft(database, draftId, now);
    return readDraftWithCommentsById(database, draftId);
  } finally {
    database.close();
  }
}

export function deletePrReviewDraftComment(options: {
  databasePath: string;
  commentId: string;
}): GitHubPrReviewDraft {
  const database = openDb(options.databasePath);
  const now = new Date().toISOString();
  try {
    const row = database
      .prepare('SELECT draft_id FROM pr_review_draft_comments WHERE id = ?;')
      .get(options.commentId) as { draft_id?: unknown } | undefined;
    const draftId = typeof row?.draft_id === 'string' ? row.draft_id : null;
    if (!draftId) throw new Error('Review draft comment not found.');
    assertDraftIsLive(database, draftId);
    database
      .prepare('DELETE FROM pr_review_draft_comments WHERE id = ?;')
      .run(options.commentId);
    touchDraft(database, draftId, now);
    return readDraftWithCommentsById(database, draftId);
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
        reviewUrl: review.url,
        headSha: currentHeadSha,
      },
    },
    options.paths,
  );

  return { draft: submitted, review };
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
  const reviews: GitHubPullRequestReviewApiItem[] = [];
  let nextUrl: string | undefined =
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/pulls/${options.number}/reviews?per_page=100`;

  while (nextUrl) {
    const response = await githubFetch(options.token, nextUrl);
    const data = v.parse(
      v.array(githubPullRequestReviewApiItemSchema),
      await response.json(),
    );
    reviews.push(...data);
    nextUrl = nextLink(response.headers.get('link'));
  }

  return reviews.map((review) => ({
    id: review.id,
    nodeId: review.node_id ?? null,
    state: review.state,
    authorLogin: review.user?.login ?? null,
    submittedAt: review.submitted_at ?? null,
    commitId: review.commit_id ?? null,
    url: review.html_url ?? null,
  }));
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
        body: parsed.body,
        createdAt: parsed.created_at,
        updatedAt: parsed.updated_at,
      };
    });
}

function assertDraftIsLive(
  database: ReturnType<typeof openDb>,
  draftId: string,
) {
  const row = database
    .prepare('SELECT status FROM pr_review_drafts WHERE id = ?;')
    .get(draftId) as { status?: unknown } | undefined;
  if (row?.status !== 'draft') {
    throw new Error('Review draft is not editable.');
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
}

function normalizeNullableBody(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isLikelyInsufficientScopeError(error: unknown, message: string) {
  if (error instanceof GitHubApiError && error.status === 403) return true;
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
  const needles = [
    comment.path,
    `line ${comment.line}`,
    `line:${comment.line}`,
    `"line":${comment.line}`,
  ];
  return githubErrorItems(data).some((item) => {
    const text = JSON.stringify(item);
    return needles.every((needle) => text.includes(needle));
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
