import type { GitHubPullRequestEventState } from './schemas';

export const maxPrEventFeedbackBodyLength = 65_536;

export type GitHubPullRequestEventStateTruncation = {
  any: boolean;
  categories: string[];
  commits: boolean;
  reviewThreads: boolean;
  reviews: boolean;
  conversationComments: boolean;
  checkSuites: boolean;
  checkRuns: boolean;
};

export function pullRequestEventStateTruncation(
  state: GitHubPullRequestEventState,
): GitHubPullRequestEventStateTruncation {
  const truncation = {
    commits: Boolean(state.commitsTruncated),
    reviewThreads:
      Boolean(state.reviewThreadsTruncated) ||
      state.reviewThreads.some(
        (thread) =>
          Boolean(thread.commentsTruncated) ||
          thread.comments.some((comment) => Boolean(comment.bodyTruncated)),
      ),
    reviews:
      Boolean(state.reviewsTruncated) ||
      state.requestedChangesState.history.some((review) =>
        Boolean(review.bodyTruncated),
      ),
    conversationComments: Boolean(state.conversationCommentsTruncated),
    checkSuites: Boolean(state.checkSuitesTruncated),
    checkRuns: Boolean(state.checkRunsTruncated),
  };
  const categories = Object.entries(truncation)
    .filter(([, truncated]) => truncated)
    .map(([category]) => category);
  return {
    ...truncation,
    any: categories.length > 0,
    categories,
  };
}

export function prEventWatermarkTruncationCategories(
  watermarks: Array<{ category: string; value: unknown }>,
) {
  return watermarks.flatMap((watermark) => {
    const value = recordValue(watermark.value);
    if (!value || value.truncated === true) return [watermark.category];
    if (
      watermark.category === 'review_threads' &&
      recordArray(value.threads).some(
        (thread) =>
          thread.commentsTruncated === true ||
          recordArray(thread.comments).some(
            (comment) => comment.bodyTruncated === true,
          ),
      )
    ) {
      return [watermark.category];
    }
    if (
      watermark.category === 'requested_changes_reviews' &&
      [value.reviews, value.latestByReviewer, value.history].some((items) =>
        recordArray(items).some((item) => item.bodyTruncated === true),
      )
    ) {
      return [watermark.category];
    }
    if (
      watermark.category === 'conversation_comments' &&
      recordArray(value.comments).some(
        (comment) => comment.bodyTruncated === true,
      )
    ) {
      return [watermark.category];
    }
    return [];
  });
}

function recordValue(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function recordArray(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item);
        return record ? [record] : [];
      })
    : [];
}
