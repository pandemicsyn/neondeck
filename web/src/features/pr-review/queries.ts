import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  deleteGitHubPrReviewDraft,
  deleteGitHubPrReviewDraftComment,
  getGitHubPullRequests,
  getGitHubPrReviewDraft,
  getGitHubPrReviewThreads,
  getGitHubPullRequestFileDiff,
  getGitHubPullRequestFiles,
  patchGitHubPrReviewDraftComment,
  postGitHubPrReview,
  postGitHubPrReviewDraftComment,
  postGitHubPrThreadReply,
  postGitHubPrThreadResolution,
  putGitHubPrReviewDraft,
  type GitHubPullRequest,
  type GitHubPullRequestReviewThread,
} from '../../api';
import { queryKeys } from '../../lib/query';

type ReviewThreadsQueryData = Awaited<
  ReturnType<typeof getGitHubPrReviewThreads>
>;

export const prReviewQueryKeys = {
  revision: (pr: GitHubPullRequest) =>
    [
      pr.repo,
      pr.number,
      pr.headSha ?? null,
      pr.baseSha ?? pr.baseRef ?? null,
    ] as const,
  files: (pr: GitHubPullRequest) =>
    ['pr-review', 'files', ...prReviewQueryKeys.revision(pr)] as const,
  fileList: (pr: GitHubPullRequest) =>
    ['pr-review', 'file-list', ...prReviewQueryKeys.revision(pr)] as const,
  filePatch: (pr: GitHubPullRequest, path: string) =>
    [
      'pr-review',
      'file-patch',
      ...prReviewQueryKeys.revision(pr),
      path,
    ] as const,
  reviewThreads: (pr: GitHubPullRequest) =>
    ['pr-review', 'review-threads', ...prReviewQueryKeys.revision(pr)] as const,
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
        baseSha: pr.baseSha,
        baseRef: pr.baseRef,
      }),
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}

export function useGitHubPullRequestFileList(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.fileList(pr),
    queryFn: () =>
      getGitHubPullRequestFiles({
        repo: pr.repo,
        number: pr.number,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        baseRef: pr.baseRef,
        patches: 'none',
        source: 'auto',
      }),
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}

export function useGitHubPullRequestFilePatches(
  pr: GitHubPullRequest,
  paths: string[],
) {
  return useQueries({
    queries: paths.map((path) => ({
      queryKey: prReviewQueryKeys.filePatch(pr, path),
      queryFn: () =>
        getGitHubPullRequestFileDiff({
          repo: pr.repo,
          number: pr.number,
          path,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          baseRef: pr.baseRef,
          source: 'auto' as const,
        }),
      enabled: pr.repo.length > 0 && pr.number > 0 && path.length > 0,
    })),
  });
}

export function usePrefetchGitHubPullRequestFilePatch(pr: GitHubPullRequest) {
  const queryClient = useQueryClient();
  return useCallback(
    (path: string) =>
      queryClient.prefetchQuery({
        queryKey: prReviewQueryKeys.filePatch(pr, path),
        queryFn: () =>
          getGitHubPullRequestFileDiff({
            repo: pr.repo,
            number: pr.number,
            path,
            headSha: pr.headSha,
            baseSha: pr.baseSha,
            baseRef: pr.baseRef,
            source: 'auto',
          }),
      }),
    [pr, queryClient],
  );
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
  const updateThreadCache = (thread: GitHubPullRequestReviewThread) => {
    queryClient.setQueryData<ReviewThreadsQueryData>(
      prReviewQueryKeys.reviewThreads(pr),
      (current) => upsertReviewThread(current, thread),
    );
  };
  const refetchPullRequestHeadSha = async () => {
    const queue = await queryClient.fetchQuery({
      queryKey: queryKeys.githubPrs,
      queryFn: getGitHubPullRequests,
    });
    return (
      queue.items.find(
        (item) => item.repo === pr.repo && item.number === pr.number,
      )?.headSha ?? null
    );
  };
  const invalidateReviewSources = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['pr-review', 'file-list', pr.repo, pr.number],
      }),
      queryClient.invalidateQueries({
        queryKey: ['pr-review', 'file-patch', pr.repo, pr.number],
      }),
      queryClient.invalidateQueries({
        queryKey: ['pr-review', 'files', pr.repo, pr.number],
      }),
      queryClient.invalidateQueries({
        queryKey: ['pr-review', 'review-threads', pr.repo, pr.number],
      }),
    ]);

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
      onSuccess: updateThreadCache,
    }),
    setThreadResolution: useMutation({
      mutationFn: postGitHubPrThreadResolution,
      onSuccess: updateThreadCache,
    }),
    refetchPullRequestHeadSha,
    invalidateReviewSources,
  };
}

export function upsertReviewThread(
  current: ReviewThreadsQueryData | undefined,
  thread: GitHubPullRequestReviewThread,
): ReviewThreadsQueryData {
  const reviewThreads = upsertThread(current?.reviewThreads ?? [], thread);
  return {
    reviewThreads,
    reviewThreadsTruncated: current?.reviewThreadsTruncated ?? false,
    unresolvedReviewThreads: reviewThreads.filter((item) => !item.isResolved),
  };
}

function upsertThread(
  threads: GitHubPullRequestReviewThread[],
  thread: GitHubPullRequestReviewThread,
) {
  const index = threads.findIndex((item) => item.id === thread.id);
  if (index < 0) return [...threads, thread];
  return threads.map((item) => (item.id === thread.id ? thread : item));
}
