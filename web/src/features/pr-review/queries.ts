import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { assertReviewRevisionCurrent } from '../../../../shared/review-refresh';
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
  type GitHubPrReviewDraft,
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
  reviewThreads: (pr: Pick<GitHubPullRequest, 'number' | 'repo'>) =>
    ['pr-review', 'review-threads', pr.repo, pr.number] as const,
  draft: (pr: Pick<GitHubPullRequest, 'repo' | 'number'>) =>
    ['pr-review', 'draft', pr.repo, pr.number] as const,
};

export function useGitHubPullRequestFiles(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.files(pr),
    queryFn: async ({ signal }) => {
      const result = await getGitHubPullRequestFiles(
        {
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          baseRef: pr.baseRef,
        },
        { signal },
      );
      assertGitHubRevision(pr, result.revision);
      return result;
    },
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}

export function useGitHubPullRequestFileList(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.fileList(pr),
    queryFn: async ({ signal }) => {
      const result = await getGitHubPullRequestFiles(
        {
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          baseRef: pr.baseRef,
          patches: 'none',
          source: 'auto',
        },
        { signal },
      );
      assertGitHubRevision(pr, result.revision);
      return result;
    },
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}

export function primeGitHubPullRequestFileList(
  queryClient: QueryClient,
  pr: GitHubPullRequest,
) {
  return queryClient.fetchQuery({
    queryKey: prReviewQueryKeys.fileList(pr),
    queryFn: async ({ signal }) => {
      const result = await getGitHubPullRequestFiles(
        {
          repo: pr.repo,
          number: pr.number,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          baseRef: pr.baseRef,
          patches: 'none',
          source: 'auto',
        },
        { signal },
      );
      assertGitHubRevision(pr, result.revision);
      return result;
    },
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
        queryFn: async ({ signal }: { signal: AbortSignal }) => {
          const result = await getGitHubPullRequestFileDiff(
            {
              repo,
              number,
              path,
              headSha,
              baseSha,
              baseRef,
              source: 'auto' as const,
            },
            { signal },
          );
          assertGitHubRevision({ headSha, baseSha }, result.revision);
          return result;
        },
        staleTime: Infinity,
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

function assertGitHubRevision(
  expected: Pick<GitHubPullRequest, 'headSha' | 'baseSha'>,
  received: PullRequestFilePatchResponse['revision'],
) {
  const expectedKey = expected.headSha
    ? `git-commit:${expected.baseSha ?? ''}:${expected.headSha}`
    : null;
  assertReviewRevisionCurrent(
    expectedKey,
    received,
    'The PR revision changed while loading review data.',
  );
}

type ReviewThreadsRefreshState = {
  repo: string;
  number: number;
  activityVersion: string | null;
};

export function useGitHubPrReviewThreads(
  pr: GitHubPullRequest,
  activityVersion: string | null = pr.updatedAt,
) {
  const queryClient = useQueryClient();
  const repo = pr.repo;
  const number = pr.number;
  const queryKey = useMemo(
    () => prReviewQueryKeys.reviewThreads({ repo, number }),
    [number, repo],
  );
  const refreshState = useRef<ReviewThreadsRefreshState>({
    repo,
    number,
    activityVersion,
  });
  useEffect(() => {
    const current = { repo, number, activityVersion };
    const previous = refreshState.current;
    refreshState.current = current;
    if (!shouldRefreshReviewThreads(previous, current)) return;
    void queryClient.invalidateQueries({ exact: true, queryKey });
  }, [activityVersion, number, queryClient, queryKey, repo]);

  return useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      getGitHubPrReviewThreads({ repo, number }, { signal }),
    enabled: repo.length > 0 && number > 0,
  });
}

export function shouldRefreshReviewThreads(
  previous: ReviewThreadsRefreshState,
  current: ReviewThreadsRefreshState,
) {
  return (
    previous.repo === current.repo &&
    previous.number === current.number &&
    previous.activityVersion !== null &&
    current.activityVersion !== null &&
    previous.activityVersion !== current.activityVersion
  );
}

export function useGitHubPrReviewDraft(pr: GitHubPullRequest) {
  return useQuery({
    queryKey: prReviewQueryKeys.draft(pr),
    queryFn: ({ signal }) =>
      getGitHubPrReviewDraft({ repo: pr.repo, number: pr.number }, { signal }),
    enabled: pr.repo.length > 0 && pr.number > 0,
  });
}

export function useGitHubPrReviewMutations(pr: GitHubPullRequest) {
  const queryClient = useQueryClient();
  const updateDraftCache = (draft: GitHubPrReviewDraft | null) => {
    queryClient.setQueryData(prReviewQueryKeys.draft(pr), draft);
  };
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
      onSuccess: updateDraftCache,
    }),
    addComment: useMutation({
      mutationFn: postGitHubPrReviewDraftComment,
      onSuccess: updateDraftCache,
    }),
    updateComment: useMutation({
      mutationFn: patchGitHubPrReviewDraftComment,
      onSuccess: updateDraftCache,
    }),
    deleteComment: useMutation({
      mutationFn: deleteGitHubPrReviewDraftComment,
      onSuccess: updateDraftCache,
    }),
    discardDraft: useMutation({
      mutationFn: deleteGitHubPrReviewDraft,
      onSuccess: updateDraftCache,
    }),
    submitReview: useMutation({
      mutationFn: postGitHubPrReview,
      onSuccess: (result) => {
        updateDraftCache(result?.draft ?? null);
        void invalidateThreads();
        void invalidateSubmittedReviewQueries(queryClient, pr);
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

export function invalidateSubmittedReviewQueries(
  queryClient: QueryClient,
  pr: Pick<GitHubPullRequest, 'number' | 'repo'>,
) {
  return Promise.all([
    queryClient.invalidateQueries({
      exact: true,
      queryKey: queryKeys.prReviewTarget(pr.repo, pr.number),
    }),
    queryClient.invalidateQueries({
      exact: true,
      queryKey: queryKeys.prReviews,
    }),
  ]);
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
