import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  getPrReview,
  openPrReviewEventStream,
  type NeonCommandResult,
  type PrReviewRecord,
} from '../../../api';
import { Badge, Button } from '../../../components/ui';
import { useDashboardEventConnectionState } from '../../../lib/dashboard-connection';
import { queryErrorMessage } from '../../../lib/query';
import { PrReviewBriefingOverlay } from '../../pr-review/PrReviewBriefing';

export function CommandResultSummary({
  event,
  onAsk,
}: {
  event: {
    input: string;
    status: 'running' | 'completed' | 'failed';
    result?: (NeonCommandResult & { flueRunId?: string }) | null;
  };
  onAsk?: () => void;
}) {
  const reviewId = reviewIdFromResult(event.result);
  if (reviewId) {
    return (
      <PrReviewCommandCard fallbackStatus={event.status} reviewId={reviewId} />
    );
  }
  const failed = event.result?.ok === false || event.status === 'failed';
  return (
    <section className="border border-line bg-soft px-3 py-2 font-mono text-[10.5px] leading-4">
      <div className="flex items-center justify-between gap-3">
        <span
          className={
            failed
              ? 'min-w-0 truncate text-accent'
              : 'min-w-0 truncate text-primary'
          }
        >
          {event.input}
        </span>
        <Badge>{event.status}</Badge>
      </div>
      {event.result ? (
        <div className="mt-1 flex items-start justify-between gap-3 text-muted">
          <p className="min-w-0">{event.result.message}</p>
          {onAsk ? (
            <Button
              className="min-h-[24px] shrink-0 bg-transparent px-1.5 py-0 text-[10px]"
              onClick={onAsk}
              type="button"
            >
              ask Neon
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-1 text-muted">Command workflow is running.</p>
      )}
    </section>
  );
}

function PrReviewCommandCard({
  fallbackStatus,
  reviewId,
}: {
  fallbackStatus: 'running' | 'completed' | 'failed';
  reviewId: string;
}) {
  const queryClient = useQueryClient();
  const eventConnection = useDashboardEventConnectionState();
  const queryKey = ['pr-review', reviewId] as const;
  const { data, error } = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      (await getPrReview(reviewId, { signal })).review,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return eventConnection !== 'open' &&
        (status === 'reviewing' || status === 'submitting')
        ? 5_000
        : false;
    },
  });

  useEffect(
    () =>
      openPrReviewEventStream((event) => {
        if (event.review.id === reviewId) {
          queryClient.setQueryData(['pr-review', reviewId], event.review);
        }
      }),
    [queryClient, reviewId],
  );

  const review = data;
  const status = review?.status ?? fallbackStatus;
  return (
    <section className="border border-line bg-soft px-3 py-2 text-[10.5px] leading-4">
      <div className="flex items-center justify-between gap-3 font-mono">
        <span className="min-w-0 truncate text-primary">
          {review ? `${review.repoFullName}#${review.prNumber}` : 'PR review'}
        </span>
        <Badge>{status}</Badge>
      </div>
      {error ? (
        <p className="mt-1 font-mono text-accent">{queryErrorMessage(error)}</p>
      ) : review ? (
        <ReviewCommandResult review={review} />
      ) : (
        <p className="mt-1 text-muted">Hydrating the durable review record.</p>
      )}
    </section>
  );
}

function ReviewCommandResult({ review }: { review: PrReviewRecord }) {
  const [briefingOpen, setBriefingOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <p className="text-muted">
        {review.status === 'reviewing'
          ? 'Neon is reviewing the pull request.'
          : review.status === 'submitting'
            ? 'Submitting the review to GitHub…'
            : review.status === 'ready'
              ? `${review.findingCount} findings · ${review.seededCount} local drafts${review.reportOnlyCount ? ` · ${review.reportOnlyCount} report-only` : ''}`
              : review.status === 'submitted'
                ? `Submitted as ${review.verdict ?? 'review'}.`
                : review.failureMessage || 'Review failed.'}
      </p>
      {review.status === 'ready' ? (
        <p className="mt-1 text-muted">{review.trustBoundary}</p>
      ) : null}
      <div className="mt-1.5 flex flex-wrap justify-end gap-1.5 font-mono text-[10px]">
        {review.briefingOverview ? (
          <button
            className="border border-line px-1.5 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            onClick={() => setBriefingOpen(true)}
            type="button"
          >
            briefing
          </button>
        ) : null}
        {(review.status === 'ready' || review.status === 'submitted') && (
          <a
            className="border border-primary px-2 py-1 text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            href={review.reviewUrl}
            rel="noreferrer"
            target="_blank"
          >
            open review
          </a>
        )}
      </div>
      {briefingOpen ? (
        <PrReviewBriefingOverlay
          onClose={() => setBriefingOpen(false)}
          review={review}
        />
      ) : null}
    </div>
  );
}

function reviewIdFromResult(
  result: (NeonCommandResult & { flueRunId?: string }) | null | undefined,
) {
  if (!result || result.command !== 'review-pr') return null;
  if (
    !result.data ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data)
  ) {
    return null;
  }
  const reviewId = (result.data as { reviewId?: unknown }).reviewId;
  return typeof reviewId === 'string' && reviewId.trim() ? reviewId : null;
}
