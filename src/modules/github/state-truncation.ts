import type { GitHubPullRequestEventState } from './schemas';

export type GitHubPullRequestEventStateTruncation = {
  any: boolean;
  categories: string[];
  commits: boolean;
  reviewThreads: boolean;
  reviews: boolean;
  checkSuites: boolean;
  checkRuns: boolean;
};

export function pullRequestEventStateTruncation(
  state: GitHubPullRequestEventState,
): GitHubPullRequestEventStateTruncation {
  const truncation = {
    commits: Boolean(state.commitsTruncated),
    reviewThreads: Boolean(state.reviewThreadsTruncated),
    reviews: Boolean(state.reviewsTruncated),
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
