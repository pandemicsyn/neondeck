import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
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
type PullRequestFilePatchResponse = Awaited<
  ReturnType<typeof getGitHubPullRequestFileDiff>
>;
type PullRequestFilePatchQueryResult =
  UseQueryResult<PullRequestFilePatchResponse>;
export type PullRequestFilePatchQueryState = {
  file: PullRequestFilePatchResponse['file'];
  hasData: boolean;
  isError: boolean;
  isLoading: boolean;
  error: unknown;
};

export const prReviewQueryKeys = {
  revision: (pr: GitHubPullRequest) =>
    [
      pr.repo,
      pr.number,
      pr.headSha ?? null,
      pr.baseSha ?? null,
      pr.baseRef ?? null,
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
    [
      'pr-review',
      'review-threads',
      ...prReviewQueryKeys.revision(pr),
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
  const repo = pr.repo;
  const number = pr.number;
  const headSha = pr.headSha;
  const baseSha = pr.baseSha;
  const baseRef = pr.baseRef;
  const queries = useMemo(
    () =>
      paths.map((path) => ({
        queryKey: [
          'pr-review',
          'file-patch',
          repo,
          number,
          headSha ?? null,
          baseSha ?? null,
          baseRef ?? null,
          path,
        ] as const,
        queryFn: () =>
          getGitHubPullRequestFileDiff({
            repo,
            number,
            path,
            headSha,
            baseSha,
            baseRef,
            source: 'auto' as const,
          }),
        enabled: repo.length > 0 && number > 0 && path.length > 0,
      })),
    [baseRef, baseSha, headSha, number, paths, repo],
  );
  const combinePatchQueries = useCallback(
    (results: PullRequestFilePatchQueryResult[]) => ({
      byPath: new Map(
        paths.map((path, index) => {
          const result = results[index];
          return [
            path,
            {
              file: result?.data?.file ?? null,
              hasData: Boolean(result?.data),
              isError: result?.isError ?? false,
              isLoading: result?.isLoading ?? false,
              error: result?.error ?? null,
            } satisfies PullRequestFilePatchQueryState,
          ] as const;
        }),
      ),
    }),
    [paths],
  );

  return useQueries({
    queries,
    combine: combinePatchQueries,
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
