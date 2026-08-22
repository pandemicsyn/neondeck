import * as v from 'valibot';
import { mapWithConcurrency } from '../../lib/concurrency';
import { encodePathSegment, githubFetch, nextLink } from './client';
import {
  githubPullRequestReviewApiItemSchema,
  githubPullRequestReviewCommentApiItemSchema,
} from './schemas';
import type {
  GitHubPullRequestRequestedChangesState,
  GitHubPullRequestReview,
  GitHubPullRequestReviewApiItem,
  GitHubPullRequestReviewCommentApiItem,
  GitHubPullRequestReviewThreadComment,
} from './schemas';
import type { PullRequestEventFetchBudget } from './event-budget';

const reviewCommentHydrationConcurrency = 4;

/**
 * Reads submitted GitHub reviews and their exact inline-comment anchors.
 *
 * Local review-draft persistence intentionally lives in `reviews.ts`; callers
 * that only need remote review facts should not depend on that write surface.
 */
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

function compareReviewAge(
  left: GitHubPullRequestReview,
  right: GitHubPullRequestReview,
) {
  const leftTime = left.submittedAt ? Date.parse(left.submittedAt) : 0;
  const rightTime = right.submittedAt ? Date.parse(right.submittedAt) : 0;
  return leftTime - rightTime || left.id - right.id;
}
