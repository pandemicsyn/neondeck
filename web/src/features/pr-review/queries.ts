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
  ApiError,
  type GitHubPrReviewDraft,
  type GitHubPrReviewSubmitResponse,
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

export function primeGitHubPullRequestFilePatch(
  queryClient: QueryClient,
  pr: GitHubPullRequest,
  path: string,
) {
  return queryClient.fetchQuery({
    queryKey: prReviewQueryKeys.filePatch(pr, path),
    queryFn: async ({ signal }) => {
      const result = await getGitHubPullRequestFileDiff(
        {
          repo: pr.repo,
          number: pr.number,
          path,
          headSha: pr.headSha,
          baseSha: pr.baseSha,
          baseRef: pr.baseRef,
          source: 'auto',
        },
        { signal },
      );
      assertGitHubRevision(pr, result.revision);
      return result;
    },
    staleTime: Infinity,
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
  const draftQueryKey = prReviewQueryKeys.draft(pr);
  const initialDraft = queryClient.getQueryData<GitHubPrReviewDraft | null>(
    draftQueryKey,
  );
  const draftUpdatedAtFrontierRef = useRef(initialDraft?.updatedAt ?? null);
  const advanceDraftUpdatedAtFrontier = (updatedAt: string) => {
    if (
      draftUpdatedAtFrontierRef.current === null ||
      Date.parse(updatedAt) >= Date.parse(draftUpdatedAtFrontierRef.current)
    ) {
      draftUpdatedAtFrontierRef.current = updatedAt;
    }
  };
  const cancelDraftQuery = () =>
    queryClient.cancelQueries({ exact: true, queryKey: draftQueryKey });
  const admitDraftMutation = async () => {
    await cancelDraftQuery();
    return {
      admittedDraft:
        queryClient.getQueryData<GitHubPrReviewDraft | null>(draftQueryKey) ??
        null,
    };
  };
  const updateDraftCache = (
    draft: GitHubPrReviewDraft | null,
    options: { preserveDifferentDraft?: boolean } = {},
  ) => {
    const cachedDraft = queryClient.getQueryData<GitHubPrReviewDraft | null>(
      draftQueryKey,
    );
    if (
      draft &&
      cachedDraft?.id !== draft.id &&
      draftUpdatedAtFrontierRef.current !== null &&
      Date.parse(draft.updatedAt) <
        Date.parse(draftUpdatedAtFrontierRef.current)
    ) {
      return;
    }
    if (draft) {
      advanceDraftUpdatedAtFrontier(draft.updatedAt);
    }
    queryClient.setQueryData<GitHubPrReviewDraft | null>(
      draftQueryKey,
      (current) =>
        options.preserveDifferentDraft &&
        current &&
        draft &&
        current.id !== draft.id
          ? current
          : newerDraftSnapshot(current, draft),
    );
  };
  const reconcileSubmittedReview = (submittedDraftId: string | null) => {
    const reconcileDraftCache = (incoming: GitHubPrReviewDraft | null) => {
      queryClient.setQueryData<GitHubPrReviewDraft | null>(
        draftQueryKey,
        (current) => {
          if (
            current?.status === 'draft' &&
            submittedDraftId !== null &&
            current.id !== submittedDraftId
          ) {
            return current;
          }
          if (
            incoming &&
            current?.id !== incoming.id &&
            draftUpdatedAtFrontierRef.current !== null &&
            Date.parse(incoming.updatedAt) <
              Date.parse(draftUpdatedAtFrontierRef.current)
          ) {
            return current ?? null;
          }
          if (incoming) {
            advanceDraftUpdatedAtFrontier(incoming.updatedAt);
          }
          return newerDraftSnapshot(current, incoming);
        },
      );
    };
    reconcileDraftCache(null);
    void getGitHubPrReviewDraft({
      repo: pr.repo,
      number: pr.number,
    })
      .then((liveDraft) => {
        reconcileDraftCache(liveDraft);
      })
      .catch(() => {
        // The submission response is authoritative; retry on a later read.
      });
    void Promise.all([
      invalidateThreads(),
      invalidateSubmittedReviewQueries(queryClient, pr),
    ]).catch(() => {
      // The submission is already settled; a later view refresh can retry.
    });
  };
  const reconcileDraftConflict = (
    error: unknown,
    admission: { admittedDraft: GitHubPrReviewDraft | null } | undefined,
  ) => {
    const currentDraft = currentDraftFromConflict(error);
    if (currentDraft === undefined) return;
    if (currentDraft === null) {
      const cachedDraft = queryClient.getQueryData<GitHubPrReviewDraft | null>(
        draftQueryKey,
      );
      if (
        !admission ||
        !sameDraftAdmission(cachedDraft, admission.admittedDraft)
      ) {
        return;
      }
    }
    updateDraftCache(currentDraft);
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
      onMutate: admitDraftMutation,
      onError: (error, _input, admission) =>
        reconcileDraftConflict(error, admission),
      onSuccess: (draft, input) =>
        updateDraftCache(draft, {
          preserveDifferentDraft: Boolean(input.draftId),
        }),
    }),
    addComment: useMutation({
      mutationFn: postGitHubPrReviewDraftComment,
      onMutate: admitDraftMutation,
      onError: (error, _input, admission) =>
        reconcileDraftConflict(error, admission),
      onSuccess: (draft) =>
        updateDraftCache(draft, { preserveDifferentDraft: true }),
    }),
    updateComment: useMutation({
      mutationFn: patchGitHubPrReviewDraftComment,
      onMutate: admitDraftMutation,
      onError: (error, _input, admission) =>
        reconcileDraftConflict(error, admission),
      onSuccess: (draft) =>
        updateDraftCache(draft, { preserveDifferentDraft: true }),
    }),
    deleteComment: useMutation({
      mutationFn: deleteGitHubPrReviewDraftComment,
      onMutate: admitDraftMutation,
      onError: (error, _input, admission) =>
        reconcileDraftConflict(error, admission),
      onSuccess: (draft) =>
        updateDraftCache(draft, { preserveDifferentDraft: true }),
    }),
    discardDraft: useMutation({
      mutationFn: deleteGitHubPrReviewDraft,
      onMutate: cancelDraftQuery,
      onSuccess: (discardedDraft) => {
        advanceDraftUpdatedAtFrontier(discardedDraft.updatedAt);
        queryClient.setQueryData<GitHubPrReviewDraft | null>(
          draftQueryKey,
          (current) =>
            current && current.id !== discardedDraft.id ? current : null,
        );
      },
    }),
    submitReview: useMutation({
      mutationFn: postGitHubPrReview,
      onMutate: cancelDraftQuery,
      onError: (error, input) => {
        const submittedDraft = submittedReviewDraftFromError(error);
        if (submittedDraft) {
          reconcileSubmittedReview(submittedDraft.id);
        } else if (submissionOutcomeIsUncertain(error)) {
          reconcileSubmittedReview(input.draftId);
        }
      },
      onSuccess: (result) =>
        reconcileSubmittedReview(result?.draft?.id ?? null),
    }),
    replyToThread: useMutation({
      mutationFn: postGitHubPrThreadReply,
      onSuccess: updateThreadCache,
    }),
    setThreadResolution: useMutation({
      mutationFn: postGitHubPrThreadResolution,
      onSuccess: updateThreadCache,
    }),
    invalidateReviewSources,
  };
}

function currentDraftFromConflict(error: unknown) {
  if (!(error instanceof ApiError) || error.status !== 409) return undefined;
  const result = error.data as
    { data?: { currentDraft?: GitHubPrReviewDraft | null } } | undefined;
  if (!result?.data || !('currentDraft' in result.data)) return undefined;
  return result.data.currentDraft ?? null;
}

export function newerDraftSnapshot(
  current: GitHubPrReviewDraft | null | undefined,
  incoming: GitHubPrReviewDraft | null,
) {
  if (!incoming || !current) return incoming;
  if (incoming.id === current.id) {
    if (incoming.revision !== current.revision) {
      return incoming.revision > current.revision ? incoming : current;
    }
    return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
      ? incoming
      : current;
  }
  return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
    ? incoming
    : current;
}

function sameDraftAdmission(
  current: GitHubPrReviewDraft | null | undefined,
  admitted: GitHubPrReviewDraft | null,
) {
  if (!current || !admitted) return !current && !admitted;
  return (
    current.id === admitted.id &&
    current.revision === admitted.revision &&
    current.status === admitted.status &&
    current.updatedAt === admitted.updatedAt
  );
}

function submissionOutcomeIsUncertain(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  const result = error.data as GitHubPrReviewSubmitResponse | undefined;
  return result?.data?.code === 'submission-uncertain';
}

export function submittedReviewWasAccepted(error: unknown) {
  return submittedReviewDraftFromError(error) !== null;
}

function submittedReviewDraftFromError(error: unknown) {
  if (!(error instanceof ApiError)) return null;
  const result = error.data as GitHubPrReviewSubmitResponse | undefined;
  const draft = result?.data?.draft;
  if (
    !result?.changed ||
    draft?.status !== 'submitted' ||
    !result.data?.review
  ) {
    return null;
  }
  return draft;
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
