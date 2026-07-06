import * as v from 'valibot';
import { encodePathSegment, githubFetch, githubGraphqlFetch } from './client';
import {
  githubIssueCommentApiResponseSchema,
  githubReviewThreadNodeGraphqlResponseSchema,
  githubReviewThreadCommentsGraphqlResponseSchema,
  githubReviewThreadsGraphqlResponseSchema,
  pullRequestReviewThreadNodeQuery,
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

export async function fetchPullRequestReviewThreads(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<GitHubPullRequestReviewThread[]> {
  return (await fetchPullRequestReviewThreadsWithMetadata(options))
    .reviewThreads;
}

export async function fetchPullRequestReviewThreadsWithMetadata(options: {
  token: string;
  owner: string;
  repo: string;
  number: number;
}): Promise<{
  reviewThreads: GitHubPullRequestReviewThread[];
  truncated: boolean;
}> {
  const threads: GitHubPullRequestReviewThread[] = [];
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < 5; page += 1) {
    const data = await githubGraphqlFetch(
      options.token,
      pullRequestReviewThreadsQuery,
      {
        owner: options.owner,
        name: options.repo,
        number: options.number,
        after: cursor,
      },
    );
    const parsed = v.parse(githubReviewThreadsGraphqlResponseSchema, data);
    const pullRequest = parsed.data.repository?.pullRequest;
    if (!pullRequest) break;
    for (const thread of pullRequest.reviewThreads.nodes ?? []) {
      threads.push(await normalizeReviewThread(options.token, thread));
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
}): Promise<GitHubPullRequestReviewThread> {
  const data = await githubGraphqlFetch(
    options.token,
    pullRequestReviewThreadNodeQuery,
    { threadId: options.threadId },
  );
  const parsed = v.parse(githubReviewThreadNodeGraphqlResponseSchema, data);
  const thread = parsed.data.node;
  if (!thread) {
    throw new Error(
      `GitHub review thread "${options.threadId}" was not found.`,
    );
  }
  return normalizeReviewThread(options.token, thread);
}

async function normalizeReviewThread(
  token: string,
  thread: GitHubReviewThreadGraphqlNode,
): Promise<GitHubPullRequestReviewThread> {
  const comments = await fetchAllReviewThreadComments(token, thread);
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
    const data = await githubGraphqlFetch(token, reviewThreadCommentsQuery, {
      threadId: thread.id,
      after: cursor,
    });
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
