import type { GitHubPullRequestEventState } from './schemas';
import * as v from 'valibot';

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

export type GitHubPullRequestEventStateIncompleteness =
  GitHubPullRequestEventStateTruncation;

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

export function pullRequestEventStateIncompleteness(
  state: GitHubPullRequestEventState,
): GitHubPullRequestEventStateIncompleteness {
  const truncation = pullRequestEventStateTruncation(state);
  const incomplete = {
    commits: truncation.commits,
    reviewThreads: truncation.reviewThreads,
    reviews: truncation.reviews,
    conversationComments: truncation.conversationComments,
    checkSuites:
      truncation.checkSuites || Boolean(state.checkSuitesUnavailableReason),
    checkRuns:
      truncation.checkRuns || Boolean(state.checkRunsUnavailableReason),
  };
  const categories = Object.entries(incomplete)
    .filter(([, value]) => value)
    .map(([category]) => category);
  return {
    ...incomplete,
    any: categories.length > 0,
    categories,
  };
}

export function prEventWatermarkTruncationCategories<TValue>(
  watermarks: Array<{ category: string; value: TValue }>,
) {
  return watermarks.flatMap((watermark) => {
    const value = recordValue(watermark.value);
    if (
      !value ||
      value.truncated === true ||
      value.unavailableReason !== undefined
    ) {
      return [watermark.category];
    }
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

const truncationRecordSchema = v.looseObject({
  truncated: v.optional(v.boolean()),
  unavailableReason: v.optional(v.string()),
  threads: v.optional(v.unknown()),
  comments: v.optional(v.unknown()),
  reviews: v.optional(v.unknown()),
  latestByReviewer: v.optional(v.unknown()),
  history: v.optional(v.unknown()),
  commentsTruncated: v.optional(v.boolean()),
  bodyTruncated: v.optional(v.boolean()),
});

function recordValue<TValue>(value: TValue) {
  const parsed = v.safeParse(truncationRecordSchema, value);
  return parsed.success ? parsed.output : null;
}

function recordArray<TValue>(value: TValue) {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item);
        return record ? [record] : [];
      })
    : [];
}
