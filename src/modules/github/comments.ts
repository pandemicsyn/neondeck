import { createHash } from 'node:crypto';
import * as v from 'valibot';
import { encodePathSegment, githubFetch, githubGraphqlFetch } from './client';
import {
  githubIssueCommentApiResponseSchema,
  githubIssueCommentsApiResponseSchema,
  githubReviewThreadNodeGraphqlResponseSchema,
  githubReviewThreadCommentsGraphqlResponseSchema,
  githubReviewThreadsGraphqlResponseSchema,
  pullRequestReviewThreadNodeQuery,
  pullRequestReviewSurfaceThreadsQuery,
  pullRequestReviewThreadsQuery,
  reviewThreadCommentsQuery,
} from './schemas';
import type {
  GitHubPullRequestComment,
  GitHubPullRequestReviewThread,
  GitHubPullRequestReviewThreadComment,
  GitHubReviewThreadCommentGraphqlNode,
  GitHubReviewThreadGraphqlNode,
} from './schemas';

const reviewSurfaceCacheTtlMs = 15_000;
const reviewSurfaceCacheMaxEntries = 16;
const reviewSurfaceCache = new Map<string, CachedReviewSurfaceThreads>();
const reviewSurfaceTargetEpochs = new Map<string, number>();

type ReviewThreadsWithMetadata = {
  reviewThreads: GitHubPullRequestReviewThread[];
  truncated: boolean;
};

type CachedReviewSurfaceThreads = {
  targetKey: string;
  expiresAt: number;
  value: ReviewThreadsWithMetadata;
};

export async function postPullRequestComment(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  body: string;
}): Promise<GitHubPullRequestComment> {
  const response = await githubFetch(
    options.token,
    `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/issues/${options.number}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ body: options.body }),
    },
  );
  const data = v.parse(
    githubIssueCommentApiResponseSchema,
    await response.json(),
  );

  return {
    id: data.id,
    nodeId: data.node_id ?? null,
    url: data.html_url,
    authorLogin: data.user?.login ?? null,
    body: data.body,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function listPullRequestComments(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestComment[]> {
  const comments: GitHubPullRequestComment[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await githubFetch(
      options.token,
      `https://api.github.com/repos/${encodePathSegment(options.owner)}/${encodePathSegment(options.repo)}/issues/${options.number}/comments?per_page=100&page=${page}`,
    );
    const data = v.parse(
      githubIssueCommentsApiResponseSchema,
      await response.json(),
    );
    comments.push(...data.map(pullRequestCommentFromApi));
    if (data.length < 100) return comments;
  }
  throw new Error(
    'Pull request has more than 10,000 comments; refusing an incomplete idempotency check.',
  );
}

function pullRequestCommentFromApi(
  data: v.InferOutput<typeof githubIssueCommentApiResponseSchema>,
): GitHubPullRequestComment {
  return {
    id: data.id,
    nodeId: data.node_id ?? null,
    url: data.html_url,
    authorLogin: data.user?.login ?? null,
    body: data.body,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
}

export async function fetchPullRequestReviewThreads(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  signal?: AbortSignal;
}): Promise<GitHubPullRequestReviewThread[]> {
  return (await fetchPullRequestReviewThreadsWithMetadata(options))
    .reviewThreads;
}

export async function fetchPullRequestReviewThreadsWithMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  signal?: AbortSignal;
}): Promise<{
  reviewThreads: GitHubPullRequestReviewThread[];
  truncated: boolean;
}> {
  return fetchReviewThreadsWithQuery(options, pullRequestReviewThreadsQuery);
}

export async function fetchPullRequestReviewSurfaceThreadsWithMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
  signal?: AbortSignal;
}): Promise<ReviewThreadsWithMetadata> {
  const targetKey = reviewSurfaceTargetKey(options);
  const cacheKey = `${targetKey}\u0000${tokenFingerprint(options.token)}`;
  const cached = reviewSurfaceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    reviewSurfaceCache.delete(cacheKey);
    reviewSurfaceCache.set(cacheKey, cached);
    return cached.value;
  }
  if (cached) reviewSurfaceCache.delete(cacheKey);

  const targetEpoch = reviewSurfaceTargetEpochs.get(targetKey) ?? 0;
  const value = await fetchReviewThreadsWithQuery(
    options,
    pullRequestReviewSurfaceThreadsQuery,
  );
  if ((reviewSurfaceTargetEpochs.get(targetKey) ?? 0) === targetEpoch) {
    storeReviewSurfaceThreads(cacheKey, {
      targetKey,
      expiresAt: Date.now() + reviewSurfaceCacheTtlMs,
      value,
    });
  }
  return value;
}

export function invalidatePullRequestReviewSurfaceThreadCache(options: {
  owner: string;
  repo: string;
  number: number;
}) {
  const targetKey = reviewSurfaceTargetKey(options);
  reviewSurfaceTargetEpochs.set(
    targetKey,
    (reviewSurfaceTargetEpochs.get(targetKey) ?? 0) + 1,
  );
  for (const [key, cached] of reviewSurfaceCache) {
    if (cached.targetKey === targetKey) reviewSurfaceCache.delete(key);
  }
}

export function clearPullRequestReviewSurfaceThreadCache() {
  reviewSurfaceCache.clear();
  reviewSurfaceTargetEpochs.clear();
}

function storeReviewSurfaceThreads(
  key: string,
  value: CachedReviewSurfaceThreads,
) {
  const now = Date.now();
  for (const [cachedKey, cached] of reviewSurfaceCache) {
    if (cached.expiresAt <= now) reviewSurfaceCache.delete(cachedKey);
  }
  reviewSurfaceCache.delete(key);
  reviewSurfaceCache.set(key, value);
  while (reviewSurfaceCache.size > reviewSurfaceCacheMaxEntries) {
    const oldestKey = reviewSurfaceCache.keys().next().value;
    if (oldestKey === undefined) break;
    reviewSurfaceCache.delete(oldestKey);
  }
}

function reviewSurfaceTargetKey(options: {
  owner: string;
  repo: string;
  number: number;
}) {
  return [
    options.owner.toLowerCase(),
    options.repo.toLowerCase(),
    options.number,
  ].join('\u0000');
}

function tokenFingerprint(token: string) {
  return createHash('sha256').update(token).digest('base64url').slice(0, 16);
}

async function fetchReviewThreadsWithQuery(
  options: {
    token: string;
    owner: string;
    repo: string;
    number: number;
    signal?: AbortSignal;
  },
  query: string,
): Promise<{
  reviewThreads: GitHubPullRequestReviewThread[];
  truncated: boolean;
}> {
  const threads: GitHubPullRequestReviewThread[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < 5; page += 1) {
    const data = await githubGraphqlFetch(
      options.token,
      query,
      {
        owner: options.owner,
        name: options.repo,
        number: options.number,
        after: cursor,
      },
      { signal: options.signal },
    );
    const parsed = v.parse(githubReviewThreadsGraphqlResponseSchema, data);
    const pullRequest = parsed.data.repository?.pullRequest;
    if (!pullRequest) break;
    for (const thread of pullRequest.reviewThreads.nodes ?? []) {
      threads.push(
        await normalizeReviewThread(options.token, thread, options.signal),
      );
    }

    if (!pullRequest.reviewThreads.pageInfo.hasNextPage) break;
    if (page === 4) {
      truncated = true;
      console.warn(
        `[neondeck] GitHub review thread fetch reached the page cap for ${options.owner}/${options.repo}#${options.number}; results may be truncated.`,
      );
      break;
    }
    cursor = pullRequest.reviewThreads.pageInfo.endCursor ?? null;
    if (!cursor) {
      truncated = true;
      break;
    }
  }

  return { reviewThreads: threads, truncated };
}

export async function fetchPullRequestReviewThread(options: {
  token: string;
  threadId: string;
  signal?: AbortSignal;
}): Promise<GitHubPullRequestReviewThread> {
  const data = await githubGraphqlFetch(
    options.token,
    pullRequestReviewThreadNodeQuery,
    { threadId: options.threadId },
    { signal: options.signal },
  );
  const parsed = v.parse(githubReviewThreadNodeGraphqlResponseSchema, data);
  const thread = parsed.data.node;
  if (!thread) {
    throw new Error(
      `GitHub review thread "${options.threadId}" was not found.`,
    );
  }
  return normalizeReviewThread(options.token, thread, options.signal);
}

async function normalizeReviewThread(
  token: string,
  thread: GitHubReviewThreadGraphqlNode,
  signal?: AbortSignal,
): Promise<GitHubPullRequestReviewThread> {
  const comments = await fetchAllReviewThreadComments(token, thread, signal);
  return {
    id: thread.id,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: thread.path ?? null,
    line: thread.line ?? null,
    originalLine: thread.originalLine ?? null,
    diffSide: thread.diffSide ?? null,
    pullRequestRepo: thread.pullRequest?.repository.nameWithOwner ?? null,
    pullRequestNumber: thread.pullRequest?.number ?? null,
    commentsTruncated: comments.truncated,
    comments: comments.items.map((comment) =>
      normalizeReviewThreadComment(comment, thread),
    ),
  };
}

async function fetchAllReviewThreadComments(
  token: string,
  thread: GitHubReviewThreadGraphqlNode,
  signal?: AbortSignal,
) {
  const comments = [...(thread.comments.nodes ?? [])];
  let cursor = thread.comments.pageInfo.endCursor;
  let hasNextPage = thread.comments.pageInfo.hasNextPage;
  let truncated = false;

  for (let page = 0; hasNextPage && page < 10;) {
    page += 1;
    if (!cursor) {
      truncated = true;
      break;
    }
    const data = await githubGraphqlFetch(
      token,
      reviewThreadCommentsQuery,
      {
        threadId: thread.id,
        after: cursor,
      },
      { signal },
    );
    const parsed = v.parse(
      githubReviewThreadCommentsGraphqlResponseSchema,
      data,
    );
    const node = parsed.data.node;
    if (!node?.comments) break;
    comments.push(...(node.comments.nodes ?? []));
    hasNextPage = node.comments.pageInfo.hasNextPage;
    if (!hasNextPage) break;
    cursor = node.comments.pageInfo.endCursor;
  }
  truncated = truncated || hasNextPage;

  return { items: comments, truncated };
}

function normalizeReviewThreadComment(
  comment: GitHubReviewThreadCommentGraphqlNode,
  thread: Pick<GitHubReviewThreadGraphqlNode, 'path' | 'line'>,
): GitHubPullRequestReviewThreadComment {
  return {
    id: comment.id,
    databaseId: comment.databaseId ?? null,
    authorLogin: comment.author?.login ?? null,
    body: comment.body,
    url: comment.url ?? null,
    path: comment.path ?? thread.path ?? null,
    line: comment.line ?? thread.line ?? null,
    originalLine: comment.originalLine ?? null,
    diffHunk: comment.diffHunk ?? null,
    reviewId: comment.pullRequestReview?.databaseId ?? null,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}
