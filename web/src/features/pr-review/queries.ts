import { useQuery } from '@tanstack/react-query';
import {
  getGitHubPrReviewThreads,
  getGitHubPullRequestFiles,
  type GitHubPullRequest,
} from '../../api';

export const prReviewQueryKeys = {
  files: (pr: GitHubPullRequest) =>
    [
      'pr-review',
      'files',
      pr.repo,
      pr.number,
      pr.headSha,
      pr.updatedAt,
    ] as const,
  reviewThreads: (pr: GitHubPullRequest) =>
    [
      'pr-review',
      'review-threads',
      pr.repo,
      pr.number,
      pr.headSha,
      pr.updatedAt,
    ] as const,
};

export function useGitHubPullRequestFiles(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.files(pr),
    queryFn: () =>
      getGitHubPullRequestFiles({ repo: pr.repo, number: pr.number }),
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}

export function useGitHubPrReviewThreads(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.reviewThreads(pr),
    queryFn: () =>
      getGitHubPrReviewThreads({ repo: pr.repo, number: pr.number }),
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}
