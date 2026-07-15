import type {
  PrReviewMutationResponse,
  PrReviewRecord,
  PrReviewsResponse,
} from './types';
import { getJson, postJson } from './http';

export function getPrReviews(input: { repo?: string; prNumber?: number } = {}) {
  const params = new URLSearchParams();
  if (input.repo) params.set('repo', input.repo);
  if (input.prNumber) params.set('prNumber', String(input.prNumber));
  const query = params.toString();
  return getJson<PrReviewsResponse>(`/api/reviews${query ? `?${query}` : ''}`);
}

export async function getPrReviewForTarget(input: {
  repo: string;
  prNumber: number;
}) {
  const response = await getPrReviews(input);
  return response.items[0] ?? null;
}

export function getPrReview(id: string) {
  return getJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    review: PrReviewRecord;
  }>(`/api/reviews/${encodeURIComponent(id)}`);
}

export function startPrReview(input: {
  ref: string;
  origin?: 'panel' | 'api';
}) {
  return postJson<PrReviewMutationResponse>('/api/reviews', input);
}

export function restartPrReview(id: string) {
  return postJson<PrReviewMutationResponse>(
    `/api/reviews/${encodeURIComponent(id)}/review`,
    {},
  );
}

export function reconcilePrReviewSubmission(id: string) {
  return postJson<PrReviewMutationResponse>(
    `/api/reviews/${encodeURIComponent(id)}/reconcile`,
    {},
  );
}
