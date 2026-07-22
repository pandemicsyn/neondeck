import type {
  PrReviewMutationResponse,
  PrReviewRecord,
  PrReviewsResponse,
} from './types';
import { getJson, postJson, type ApiRequestOptions } from './http';

export function getPrReviews(
  input: { repo?: string; prNumber?: number } = {},
  options: ApiRequestOptions = {},
) {
  const params = new URLSearchParams();
  if (input.repo) params.set('repo', input.repo);
  if (input.prNumber) params.set('prNumber', String(input.prNumber));
  const query = params.toString();
  return getJson<PrReviewsResponse>(
    `/api/reviews${query ? `?${query}` : ''}`,
    options,
  );
}

export async function getPrReviewForTarget(
  input: {
    repo: string;
    prNumber: number;
  },
  options: ApiRequestOptions = {},
) {
  const response = await getPrReviews(input, options);
  return response.items[0] ?? null;
}

export function getPrReview(id: string, options: ApiRequestOptions = {}) {
  return getJson<{
    ok: boolean;
    action: string;
    changed: boolean;
    review: PrReviewRecord;
  }>(`/api/reviews/${encodeURIComponent(id)}`, options);
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

export function archivePrReview(id: string) {
  return postJson<PrReviewMutationResponse>(
    `/api/reviews/${encodeURIComponent(id)}/archive`,
    {},
  );
}

export function restorePrReview(id: string) {
  return postJson<PrReviewMutationResponse>(
    `/api/reviews/${encodeURIComponent(id)}/restore`,
    {},
  );
}
