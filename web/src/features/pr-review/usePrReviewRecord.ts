import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import {
  getPrReviewForTarget,
  openPrReviewEventStream,
  reconcilePrReviewSubmission,
  restartPrReview,
  startPrReview,
  type GitHubPullRequest,
} from '../../api';
import { queryKeys } from '../../lib/query';
import { prReviewQueryKeys } from './queries';

export function usePrReviewRecord(
  pr: Pick<GitHubPullRequest, 'number' | 'repo'>,
) {
  const { number, repo } = pr;
  const queryClient = useQueryClient();
  const reviewQueryKey = useMemo(
    () => queryKeys.prReviewTarget(repo, number),
    [number, repo],
  );
  const draftQueryKey = useMemo(
    () => prReviewQueryKeys.draft({ number, repo }),
    [number, repo],
  );
  const query = useQuery({
    queryKey: reviewQueryKey,
    queryFn: () => getPrReviewForTarget({ repo, prNumber: number }),
  });
  const review = query.data ?? null;
  const updateReview = (nextReview: NonNullable<typeof query.data>) => {
    queryClient.setQueryData(reviewQueryKey, nextReview);
  };
  const restart = useMutation({
    mutationFn: (id: string) => restartPrReview(id),
    onSuccess: (result) => updateReview(result.review),
  });
  const start = useMutation({
    mutationFn: () =>
      startPrReview({ ref: `${repo}#${number}`, origin: 'panel' }),
    onSuccess: (result) => updateReview(result.review),
  });
  const reconcileSubmission = useMutation({
    mutationFn: (id: string) => reconcilePrReviewSubmission(id),
    onSuccess: (result) => updateReview(result.review),
  });

  useEffect(
    () =>
      openPrReviewEventStream(
        (event) => {
          if (
            event.review.repoFullName.toLowerCase() === repo.toLowerCase() &&
            event.review.prNumber === number
          ) {
            queryClient.setQueryData(reviewQueryKey, event.review);
            if (
              event.review.status === 'ready' ||
              event.review.status === 'failed'
            ) {
              void queryClient.invalidateQueries({ queryKey: draftQueryKey });
            }
          }
        },
        undefined,
        () => {
          void queryClient.invalidateQueries({ queryKey: reviewQueryKey });
        },
      ),
    [draftQueryKey, number, queryClient, repo, reviewQueryKey],
  );

  return {
    isDurableReviewReady:
      query.isSuccess && (!review || review.status === 'ready'),
    query,
    reconcileSubmission,
    restart,
    review,
    start,
  };
}
