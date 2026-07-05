import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteGitHubPrReviewDraft,
  deleteGitHubPrReviewDraftComment,
  getGitHubPrReviewDraft,
  getGitHubPrReviewThreads,
  getGitHubPullRequestFiles,
  patchGitHubPrReviewDraftComment,
  postGitHubPrReview,
  postGitHubPrReviewDraftComment,
  postGitHubPrThreadReply,
  postGitHubPrThreadResolution,
  putGitHubPrReviewDraft,
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
  draft: (pr: Pick<GitHubPullRequest, 'repo' | 'number'>) =>
    ['pr-review', 'draft', pr.repo, pr.number] as const,
};

export function useGitHubPullRequestFiles(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.files(pr),
    queryFn: () =>
      getGitHubPullRequestFiles({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha,
      }),
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

export function useGitHubPrReviewDraft(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.draft(pr),
    queryFn: () => getGitHubPrReviewDraft({ repo: pr.repo, number: pr.number }),
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}

export function useGitHubPrReviewMutations(pr: GitHubPullRequest) {
  const queryClient = useQueryClient();
  const invalidateDraft = () =>
    queryClient.invalidateQueries({ queryKey: prReviewQueryKeys.draft(pr) });
  const invalidateThreads = () =>
    queryClient.invalidateQueries({
      queryKey: prReviewQueryKeys.reviewThreads(pr),
    });

  return {
    saveDraft: useMutation({
      mutationFn: putGitHubPrReviewDraft,
      onSuccess: invalidateDraft,
    }),
    addComment: useMutation({
      mutationFn: postGitHubPrReviewDraftComment,
      onSuccess: invalidateDraft,
    }),
    updateComment: useMutation({
      mutationFn: patchGitHubPrReviewDraftComment,
      onSuccess: invalidateDraft,
    }),
    deleteComment: useMutation({
      mutationFn: deleteGitHubPrReviewDraftComment,
      onSuccess: invalidateDraft,
    }),
    discardDraft: useMutation({
      mutationFn: deleteGitHubPrReviewDraft,
      onSuccess: invalidateDraft,
    }),
    submitReview: useMutation({
      mutationFn: postGitHubPrReview,
      onSuccess: () => {
        void invalidateDraft();
        void invalidateThreads();
      },
    }),
    replyToThread: useMutation({
      mutationFn: postGitHubPrThreadReply,
      onSuccess: invalidateThreads,
    }),
    setThreadResolution: useMutation({
      mutationFn: postGitHubPrThreadResolution,
      onSuccess: invalidateThreads,
    }),
  };
}
