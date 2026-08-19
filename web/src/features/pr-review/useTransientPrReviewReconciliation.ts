import { useEffect, useMemo, useRef } from 'react';
import { getPrReview, type PrReviewRecord } from '../../api';

export const transientPrReviewPollMs = 5_000;

export function isTransientPrReview(review: PrReviewRecord) {
  return review.status === 'reviewing' || review.status === 'submitting';
}

export function useTransientPrReviewReconciliation(
  reviews: readonly PrReviewRecord[],
  onReview: (review: PrReviewRecord) => void,
  intervalMs = transientPrReviewPollMs,
) {
  const onReviewRef = useRef(onReview);
  const transientReviews = useMemo(
    () => reviews.filter(isTransientPrReview),
    [reviews],
  );

  useEffect(() => {
    onReviewRef.current = onReview;
  }, [onReview]);

  useEffect(() => {
    if (transientReviews.length === 0) return;

    const controller = new AbortController();
    const observedVersions = new Map(
      transientReviews.map((review) => [review.id, reviewVersion(review)]),
    );
    let polling = false;
    let reportedFailure = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const results = await Promise.allSettled(
          transientReviews.map((review) =>
            getPrReview(review.id, { signal: controller.signal }),
          ),
        );
        if (controller.signal.aborted) return;

        let failed = false;
        for (const result of results) {
          if (result.status === 'rejected') {
            failed = true;
            continue;
          }
          const review = result.value.review;
          if (observedVersions.get(review.id) === reviewVersion(review)) {
            continue;
          }
          onReviewRef.current(review);
        }
        if (failed && !reportedFailure) {
          reportedFailure = true;
          console.warn(
            '[neondeck] transient PR review reconciliation failed; retrying',
          );
        } else if (!failed) {
          reportedFailure = false;
        }
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [intervalMs, transientReviews]);
}

function reviewVersion(review: PrReviewRecord) {
  return `${review.status}:${review.updatedAt}`;
}
