import type {
  PrReviewTour,
  ReviewTourChangeEvent,
} from '../../../shared/pr-review-tour';
import { getJson, postJson, type ApiRequestOptions } from './http';

export function getPrReviewTour(
  conversationId: string,
  options: ApiRequestOptions = {},
) {
  return getJson<{
    ok: true;
    action: 'pr_review_tour_read';
    changed: false;
    tour: PrReviewTour | null;
  }>(`/api/review-tours/${encodeURIComponent(conversationId)}`, options);
}

export function publishPrReviewTourPresentation(
  event:
    | Omit<
        Extract<ReviewTourChangeEvent, { action: 'tour-activated' }>,
        'id' | 'changedAt'
      >
    | Omit<
        Extract<ReviewTourChangeEvent, { action: 'tour-closed' }>,
        'id' | 'changedAt'
      >,
) {
  return postJson<{
    ok: boolean;
    action: 'pr_review_tour_presentation';
    changed: boolean;
    message: string;
  }>('/api/review-tours/presentation', event);
}
