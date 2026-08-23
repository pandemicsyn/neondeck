import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getPrReview, openPrReviewEventStream } from '../../api';
import { BootState } from '../../components/ui';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import type { PrReviewRecord } from '../../api';
import { PrReviewBriefing } from './PrReviewBriefing';
import { prReviewDraftQueryOptions, useGitHubPrReviewDraft } from './queries';
import { usePrReviewBriefingActions } from './usePrReviewBriefingActions';
import {
  isTransientPrReview,
  transientPrReviewPollMs,
} from './useTransientPrReviewReconciliation';

export function PrReviewBriefingPage({ reviewId }: { reviewId: string }) {
  const queryClient = useQueryClient();
  const reviewQuery = useQuery({
    queryKey: queryKeys.prReview(reviewId),
    queryFn: async ({ signal }) =>
      (await getPrReview(reviewId, { signal })).review,
    refetchInterval: (query) => {
      const current = query.state.data;
      return current && isTransientPrReview(current)
        ? transientPrReviewPollMs
        : false;
    },
    refetchIntervalInBackground: true,
  });
  const review = reviewQuery.data;
  const draftQuery = useGitHubPrReviewDraft(
    {
      repo: review?.repoFullName ?? '',
      number: review?.prNumber ?? 0,
    },
    prReviewDraftQueryOptions(review),
  );

  useEffect(
    () =>
      openPrReviewEventStream((event) => {
        if (event.review.id === reviewId) {
          queryClient.setQueryData(queryKeys.prReview(reviewId), event.review);
        }
      }),
    [queryClient, reviewId],
  );

  if (reviewQuery.error) {
    return (
      <BootState
        detail={queryErrorMessage(reviewQuery.error)}
        title="Review briefing unavailable"
        tone="alert"
      />
    );
  }
  if (!review) {
    return (
      <BootState
        detail="Loading the persisted overview and live review draft."
        title="Loading review briefing"
      />
    );
  }
  if (!review.briefingOverview) {
    return (
      <BootState
        detail="This review predates persisted briefings. Open the review workbench to inspect it."
        title="No briefing for this review"
      />
    );
  }

  return <LoadedPrReviewBriefing draftQuery={draftQuery} review={review} />;
}

function LoadedPrReviewBriefing({
  draftQuery,
  review,
}: {
  draftQuery: ReturnType<typeof useGitHubPrReviewDraft>;
  review: PrReviewRecord;
}) {
  const actions = usePrReviewBriefingActions(review, draftQuery);
  return (
    <section className="h-screen w-screen overflow-hidden border border-line bg-panel">
      <PrReviewBriefing
        actions={actions}
        draft={draftQuery.data}
        draftError={draftQuery.error}
        draftLoading={draftQuery.isLoading}
        review={review}
      />
    </section>
  );
}
