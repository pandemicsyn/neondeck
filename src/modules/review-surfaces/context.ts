import type { NeonReviewFinding } from '../../../shared/review-finding';
import {
  reviewSurfaceContextPageLimits,
  type ActiveReviewSurface,
  type ReviewSurfaceContextPage,
  type ReviewSurfaceContextPageRequest,
  type ReviewSurfaceContextWindow,
} from '../../../shared/review-surface';

export function createReviewSurfaceContextPage(
  surface: ActiveReviewSurface,
  findings: NeonReviewFinding[],
  request: Omit<ReviewSurfaceContextPageRequest, 'surfaceId'> = {},
) {
  const offset = clampInteger(
    request.offset ?? 0,
    0,
    reviewSurfaceContextPageLimits.maxOffset,
  );
  const limit = clampInteger(
    request.limit ?? reviewSurfaceContextPageLimits.defaultLimit,
    1,
    reviewSurfaceContextPageLimits.maxLimit,
  );
  const { files, ...source } = surface.source;
  const { reviewOrder, source: _source, ...surfaceSummary } = surface;
  const page: ReviewSurfaceContextPage = {
    files: window(files, offset, limit),
    reviewOrder: window(reviewOrder, offset, limit),
    findings: window(findings, offset, limit),
  };
  return {
    ok: true as const,
    summary: {
      ...surfaceSummary,
      source,
      counts: {
        files: files.length,
        reviewOrder: reviewOrder.length,
        findings: findings.length,
      },
    },
    page,
  };
}

function window<T>(
  values: readonly T[],
  offset: number,
  limit: number,
): ReviewSurfaceContextWindow<T> {
  const items = values.slice(offset, offset + limit);
  return {
    items,
    offset,
    limit,
    total: values.length,
    nextOffset: offset + items.length < values.length ? offset + limit : null,
  };
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
