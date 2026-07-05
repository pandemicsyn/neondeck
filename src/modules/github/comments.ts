import * as v from 'valibot';
import { encodePathSegment, githubFetch, githubGraphqlFetch } from './client';
import {
  githubIssueCommentApiResponseSchema,
  githubReviewThreadCommentsGraphqlResponseSchema,
  githubReviewThreadsGraphqlResponseSchema,
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
  const threads: GitHubPullRequestReviewThread[] = [];
  let cursor: string | null = null;

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
      const comments = await fetchAllReviewThreadComments(
        options.token,
        thread,
      );
      threads.push({
        id: thread.id,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        path: thread.path ?? null,
        line: thread.line ?? null,
        originalLine: thread.originalLine ?? null,
        diffSide: thread.diffSide ?? null,
        comments: comments.map((comment) =>
          normalizeReviewThreadComment(comment, thread),
        ),
      });
    }

    if (!pullRequest.reviewThreads.pageInfo.hasNextPage) break;
    cursor = pullRequest.reviewThreads.pageInfo.endCursor ?? null;
    if (!cursor) break;
  }

  return threads;
}

async function fetchAllReviewThreadComments(
  token: string,
  thread: GitHubReviewThreadGraphqlNode,
) {
  const comments = [...(thread.comments.nodes ?? [])];
  let cursor = thread.comments.pageInfo.endCursor;

  for (let page = 0; thread.comments.pageInfo.hasNextPage && page < 10;) {
    page += 1;
    if (!cursor) break;
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
    if (!node.comments.pageInfo.hasNextPage) break;
    cursor = node.comments.pageInfo.endCursor;
  }

  return comments;
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
