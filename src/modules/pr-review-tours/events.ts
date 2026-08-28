import type { ReviewTourChangeEvent } from '../../../shared/pr-review-tour';

type ReviewTourEventListener = (event: ReviewTourChangeEvent) => void;

const listeners = new Set<ReviewTourEventListener>();

export function publishReviewTourEvent(event: ReviewTourChangeEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      listeners.delete(listener);
      console.error('[neondeck] review tour event listener failed', error);
    }
  }
}

export function subscribeReviewTourEvents(listener: ReviewTourEventListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatReviewTourServerSentEvent(event: ReviewTourChangeEvent) {
  return [
    'event: review-tour-change',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
