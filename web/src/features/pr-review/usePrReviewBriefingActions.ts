import {
  useMutation,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ApiError, getPrReview, reconcilePrReviewSubmission } from '../../api';
import type {
  GitHubPrReviewDraft,
  PrReviewRecord,
  PrReviewReportOnlyFinding,
} from '../../api';
import { queryKeys } from '../../lib/query';
import { prReviewQueryKeys, useGitHubPrReviewMutations } from './queries';
import { reportOnlyFindingBody } from './PrReviewFindingsSidebar';
import {
  failingCommentIdsFromError,
  normalizeReviewBody,
  settleAndSubmitPrReview,
  submissionMayHaveBeenAccepted,
  waitForPendingDraftMutations,
} from './review-helpers';

type SubmissionLockState = 'active' | 'recovery-needed';

const submissionLocks = new Map<string, SubmissionLockState>();
const submissionLockListeners = new Map<string, Set<() => void>>();
const pendingDraftMutations = new Map<string, Set<Promise<unknown>>>();
const failedSubmissionComments = new Map<
  string,
  { draftId: string; fingerprints: Map<string, string> }
>();

export function usePrReviewBriefingActions(
  review: PrReviewRecord,
  draftQuery: Pick<
    UseQueryResult<GitHubPrReviewDraft | null>,
    'data' | 'refetch'
  >,
  options: { onReviewChange?: (review: PrReviewRecord) => void } = {},
) {
  const target = { repo: review.repoFullName, number: review.prNumber };
  const submissionKey = `${review.repoFullName.toLowerCase()}#${review.prNumber}`;
  const subscribeToSubmissionLock = useCallback(
    (listener: () => void) => {
      const listeners = submissionLockListeners.get(submissionKey) ?? new Set();
      listeners.add(listener);
      submissionLockListeners.set(submissionKey, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) submissionLockListeners.delete(submissionKey);
      };
    },
    [submissionKey],
  );
  const submissionLockState = useSyncExternalStore(
    subscribeToSubmissionLock,
    () => submissionLocks.get(submissionKey) ?? null,
    () => null,
  );
  const rejectedCommentCount = useSyncExternalStore(
    subscribeToSubmissionLock,
    () => failedSubmissionComments.get(submissionKey)?.fingerprints.size ?? 0,
    () => 0,
  );
  const queryClient = useQueryClient();
  const mutations = useGitHubPrReviewMutations(target);
  const submissionPendingRef = useRef(false);
  const [submissionPending, setSubmissionPending] = useState(false);
  const publishReview = (nextReview: PrReviewRecord) => {
    synchronizePrReviewSubmissionLock(nextReview);
    if (nextReview.status !== 'ready' && submissionPendingRef.current) {
      submissionPendingRef.current = false;
      setSubmissionPending(false);
    }
    queryClient.setQueryData(queryKeys.prReview(review.id), nextReview);
    options.onReviewChange?.(nextReview);
  };
  const refreshReview = async () => {
    try {
      const result = await getPrReview(review.id);
      publishReview(result.review);
      return result.review;
    } catch {
      return null;
    }
  };
  const reconciliation = useMutation({
    mutationFn: () => reconcilePrReviewSubmission(review.id),
    onSuccess: (result) => {
      publishReview(result.review);
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.prReviews }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.prReviewTarget(
            review.repoFullName,
            review.prNumber,
          ),
        }),
        ...(result.review.status === 'ready' ||
        result.review.status === 'failed'
          ? [
              queryClient.invalidateQueries({
                queryKey: prReviewQueryKeys.draft(target),
              }),
            ]
          : []),
      ]);
    },
  });
  const draftRef = useRef(draftQuery.data ?? null);
  useEffect(() => {
    draftRef.current = draftQuery.data ?? null;
    if (draftQuery.data) {
      synchronizeFailedSubmissionComments(submissionKey, draftQuery.data);
    }
  }, [draftQuery.data, review.id, submissionKey]);
  useEffect(() => {
    synchronizePrReviewSubmissionLock(review);
    if (review.status !== 'ready' && submissionPendingRef.current) {
      submissionPendingRef.current = false;
      setSubmissionPending(false);
    }
  }, [review, submissionKey]);
  const acceptDraft = (draft: GitHubPrReviewDraft) => {
    draftRef.current = draft;
    synchronizeFailedSubmissionComments(submissionKey, draft);
    return draft;
  };
  const trackMutation = <T>(promise: Promise<T>) => {
    const inFlight = pendingDraftMutations.get(submissionKey) ?? new Set();
    const tracked = promise.finally(() => {
      inFlight.delete(tracked);
      if (inFlight.size === 0) pendingDraftMutations.delete(submissionKey);
    });
    inFlight.add(tracked);
    pendingDraftMutations.set(submissionKey, inFlight);
    return tracked;
  };
  const assertSubmissionIdle = () => {
    if (submissionPendingRef.current || submissionLocks.has(submissionKey)) {
      throw new Error('Review submission is already in progress.');
    }
  };
  const mutableDraft = () => {
    assertSubmissionIdle();
    assertReadyReview(review);
    const draft = draftRef.current;
    if (!draft || draft.status !== 'draft') {
      throw new Error('The local review draft is not available for editing.');
    }
    if (draft.headSha !== review.headSha) {
      throw new Error(
        'The local review draft does not match the reviewed pull request head.',
      );
    }
    return draft;
  };
  const ensureDraft = async () => {
    assertSubmissionIdle();
    const current = draftRef.current;
    if (current) return mutableDraft();
    assertReadyReview(review);
    return acceptDraft(
      await trackMutation(
        mutations.saveDraft.mutateAsync({
          expectedAbsent: true,
          ...target,
          headSha: review.headSha,
        }),
      ),
    );
  };

  return {
    rejectedCommentCount,
    submitting:
      submissionPending ||
      submissionLockState !== null ||
      mutations.submitReview.isPending,
    busy:
      submissionLockState === 'active' ||
      (submissionLockState === 'recovery-needed' &&
        review.status !== 'submitting') ||
      submissionPending ||
      mutations.saveDraft.isPending ||
      mutations.addComment.isPending ||
      mutations.updateComment.isPending ||
      mutations.deleteComment.isPending ||
      mutations.submitReview.isPending ||
      reconciliation.isPending,
    async dismissComment(commentId: string) {
      const draft = mutableDraft();
      acceptDraft(
        await trackMutation(
          mutations.deleteComment.mutateAsync({
            ...target,
            id: commentId,
            draftId: draft.id,
            expectedRevision: draft.revision,
          }),
        ),
      );
    },
    async editComment(commentId: string, body: string) {
      const draft = mutableDraft();
      const normalized = body.trim();
      if (!normalized) throw new Error('Draft comment text is required.');
      const updated = acceptDraft(
        await trackMutation(
          mutations.updateComment.mutateAsync({
            ...target,
            id: commentId,
            draftId: draft.id,
            expectedRevision: draft.revision,
            body: normalized,
          }),
        ),
      );
      clearFailedSubmissionComment(submissionKey, updated.id, commentId);
    },
    promoteFinding(
      finding: PrReviewReportOnlyFinding,
      body = reportOnlyFindingBody(finding),
    ) {
      const operation = (async () => {
        if (!finding.line || !finding.side) {
          throw new Error(
            'A complete changed-line anchor is required to draft this note.',
          );
        }
        const draft = await ensureDraft();
        const normalized = body.trim();
        if (!normalized) throw new Error('Draft comment text is required.');
        acceptDraft(
          await trackMutation(
            mutations.addComment.mutateAsync({
              ...target,
              draftId: draft.id,
              expectedRevision: draft.revision,
              path: finding.path,
              side: finding.side,
              line: finding.line,
              body: normalized,
              sourceFindingId: finding.sourceId ?? null,
            }),
          ),
        );
      })();
      return trackMutation(operation);
    },
    async submitApproval(body: string) {
      assertReadyReview(review);
      if (!acquireSubmissionLock(submissionKey)) return;
      submissionPendingRef.current = true;
      setSubmissionPending(true);
      let lockRetention: 'none' | 'confirmed' | 'ambiguous' = 'none';
      let submissionStarted = false;
      try {
        await waitForPendingDraftMutations(
          pendingDraftMutations.get(submissionKey) ?? new Set(),
        );
        const barrierDraft = draftRef.current;
        const settledDraft = await settleAndSubmitPrReview({
          barrierDraft,
          body: normalizeReviewBody(body),
          commentIds: (draft) => {
            synchronizeFailedSubmissionComments(submissionKey, draft);
            const failedIds =
              failedSubmissionComments.get(submissionKey)?.fingerprints ??
              new Map();
            return draft.comments
              .filter((comment) => !failedIds.has(comment.id))
              .map((comment) => comment.id);
          },
          headSha: review.headSha,
          number: review.prNumber,
          onSubmitStart: () => {
            submissionStarted = true;
          },
          refetchDraft: async () => {
            const result = await draftQuery.refetch({ throwOnError: true });
            const refreshedDraft = result.data ?? null;
            draftRef.current = refreshedDraft;
            return refreshedDraft;
          },
          repo: review.repoFullName,
          saveDraft: async (input) =>
            acceptDraft(await mutations.saveDraft.mutateAsync(input)),
          submitReview: mutations.submitReview.mutateAsync,
          verdict: 'approve',
        });
        clearFailedSubmissionComments(submissionKey, settledDraft.id);
        lockRetention = 'confirmed';
      } catch (error) {
        const failingIds = failingCommentIdsFromError(error);
        if (failingIds.length > 0) {
          recordFailedSubmissionComments(
            submissionKey,
            draftRef.current,
            failingIds,
          );
        }
        lockRetention = submissionMayHaveBeenAccepted(error)
          ? 'confirmed'
          : submissionStarted &&
              (!(error instanceof ApiError) || error.status >= 500)
            ? 'ambiguous'
            : 'none';
        throw error;
      } finally {
        let refreshedReview: PrReviewRecord | null = null;
        try {
          const [, latestReview] = await Promise.all([
            queryClient.invalidateQueries({
              queryKey: queryKeys.prReview(review.id),
            }),
            refreshReview(),
          ]);
          refreshedReview = latestReview;
        } finally {
          if (
            lockRetention === 'none' ||
            (lockRetention === 'ambiguous' &&
              refreshedReview?.status === 'ready')
          ) {
            submissionPendingRef.current = false;
            setSubmissionPending(false);
            releaseSubmissionLock(submissionKey);
          } else {
            submissionPendingRef.current = false;
            setSubmissionPending(false);
            markSubmissionRecoveryNeeded(submissionKey);
          }
        }
      }
    },
    async recoverSubmission() {
      if (review.status !== 'submitting') {
        throw new Error('Only an interrupted submission can be recovered.');
      }
      if (!acquireSubmissionRecoveryLock(submissionKey)) return;
      submissionPendingRef.current = true;
      setSubmissionPending(true);
      try {
        return await reconciliation.mutateAsync();
      } finally {
        submissionPendingRef.current = false;
        setSubmissionPending(false);
        releaseSubmissionLock(submissionKey);
      }
    },
  };
}

function acquireSubmissionLock(key: string) {
  if (submissionLocks.has(key)) return false;
  submissionLocks.set(key, 'active');
  notifySubmissionLock(key);
  return true;
}

function acquireSubmissionRecoveryLock(key: string) {
  if (submissionLocks.get(key) === 'active') return false;
  submissionLocks.set(key, 'active');
  notifySubmissionLock(key);
  return true;
}

function markSubmissionRecoveryNeeded(key: string) {
  if (!submissionLocks.has(key)) return;
  submissionLocks.set(key, 'recovery-needed');
  notifySubmissionLock(key);
}

function releaseSubmissionLock(key: string) {
  if (!submissionLocks.delete(key)) return;
  notifySubmissionLock(key);
}

function notifySubmissionLock(key: string) {
  for (const listener of submissionLockListeners.get(key) ?? []) listener();
}

export function synchronizePrReviewSubmissionLock(
  review: Pick<PrReviewRecord, 'prNumber' | 'repoFullName' | 'status'>,
) {
  const key = `${review.repoFullName.toLowerCase()}#${review.prNumber}`;
  if (review.status === 'submitting') return;
  if (review.status === 'ready') {
    if (submissionLocks.get(key) === 'recovery-needed') {
      releaseSubmissionLock(key);
    }
    return;
  }
  releaseSubmissionLock(key);
}

function synchronizeFailedSubmissionComments(
  key: string,
  draft: GitHubPrReviewDraft,
) {
  const current = failedSubmissionComments.get(key);
  if (!current) return;
  if (current.draftId !== draft.id) {
    failedSubmissionComments.delete(key);
    notifySubmissionLock(key);
    return;
  }
  const liveComments = new Map(
    draft.comments.map((comment) => [comment.id, comment]),
  );
  const nextFingerprints = new Map(
    [...current.fingerprints].filter(([id, fingerprint]) => {
      const comment = liveComments.get(id);
      return comment && submissionCommentFingerprint(comment) === fingerprint;
    }),
  );
  if (nextFingerprints.size === current.fingerprints.size) return;
  if (nextFingerprints.size === 0) failedSubmissionComments.delete(key);
  else {
    failedSubmissionComments.set(key, {
      ...current,
      fingerprints: nextFingerprints,
    });
  }
  notifySubmissionLock(key);
}

function recordFailedSubmissionComments(
  key: string,
  draft: GitHubPrReviewDraft | null,
  commentIds: readonly string[],
) {
  if (!draft) return;
  const current = failedSubmissionComments.get(key);
  const fingerprints =
    current?.draftId === draft.id
      ? new Map(current.fingerprints)
      : new Map<string, string>();
  for (const commentId of commentIds) {
    const comment = draft.comments.find((item) => item.id === commentId);
    if (comment) {
      fingerprints.set(commentId, submissionCommentFingerprint(comment));
    }
  }
  failedSubmissionComments.set(key, { draftId: draft.id, fingerprints });
  synchronizeFailedSubmissionComments(key, draft);
  notifySubmissionLock(key);
}

function clearFailedSubmissionComment(
  key: string,
  draftId: string,
  commentId: string,
) {
  const current = failedSubmissionComments.get(key);
  if (!current || current.draftId !== draftId) return;
  const fingerprints = new Map(current.fingerprints);
  if (!fingerprints.delete(commentId)) return;
  if (fingerprints.size === 0) failedSubmissionComments.delete(key);
  else failedSubmissionComments.set(key, { draftId, fingerprints });
  notifySubmissionLock(key);
}

function clearFailedSubmissionComments(key: string, draftId: string) {
  const current = failedSubmissionComments.get(key);
  if (!current || current.draftId !== draftId) return;
  failedSubmissionComments.delete(key);
  notifySubmissionLock(key);
}

function submissionCommentFingerprint(
  comment: GitHubPrReviewDraft['comments'][number],
) {
  return JSON.stringify([
    comment.updatedAt,
    comment.path,
    comment.side,
    comment.line,
    comment.startSide,
    comment.startLine,
    comment.body,
  ]);
}

function assertReadyReview(review: PrReviewRecord) {
  if (review.archivedAt) {
    throw new Error(
      'Restore this archived review before changing or submitting it.',
    );
  }
  if (review.status !== 'ready') {
    throw new Error('Only a ready review can be changed or submitted.');
  }
  if (!review.headSha) {
    throw new Error('The reviewed pull request head is unavailable.');
  }
}

export type PrReviewBriefingActions = {
  busy: boolean;
  rejectedCommentCount: number;
  submitting: boolean;
  dismissComment: (commentId: string) => Promise<unknown>;
  editComment: (commentId: string, body: string) => Promise<unknown>;
  promoteFinding: (
    finding: PrReviewReportOnlyFinding,
    body?: string,
  ) => Promise<unknown>;
  recoverSubmission: () => Promise<unknown>;
  submitApproval: (body: string) => Promise<unknown>;
};
