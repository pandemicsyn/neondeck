// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrReviewRecord } from '../../api';
import { useTransientPrReviewReconciliation } from './useTransientPrReviewReconciliation';

describe('useTransientPrReviewReconciliation', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('repairs a missed terminal update from the local record and then stops polling', async () => {
    const ready = review('ready');
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            action: 'pr_review_read',
            changed: false,
            review: ready,
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onReview = vi.fn<(review: PrReviewRecord) => void>();

    await act(async () => {
      root.render(
        <Harness
          intervalMs={25}
          onReview={onReview}
          reviews={[review('reviewing')]}
        />,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onReview).toHaveBeenCalledWith(ready);

    act(() => {
      root.render(
        <Harness intervalMs={25} onReview={onReview} reviews={[ready]} />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function Harness({
  intervalMs,
  onReview,
  reviews,
}: {
  intervalMs: number;
  onReview: (review: PrReviewRecord) => void;
  reviews: PrReviewRecord[];
}) {
  useTransientPrReviewReconciliation(reviews, onReview, intervalMs);
  return null;
}

function review(status: PrReviewRecord['status']): PrReviewRecord {
  return {
    id: 'review-1',
    ref: 'owner/repo#42',
    repoFullName: 'owner/repo',
    prNumber: 42,
    title: 'Review this change',
    author: 'contributor',
    prUrl: 'https://github.com/owner/repo/pull/42',
    status,
    runId: 'run-1',
    headSha: 'head-1',
    baseSha: null,
    baseRef: null,
    origin: 'panel',
    reviewUrl: '/review?repo=owner%2Frepo&number=42',
    reportIds: status === 'ready' ? ['overview'] : [],
    findingCount: 0,
    seededCount: 0,
    reportOnlyCount: 0,
    reportOnlyFindings: [],
    trustBoundary: 'Local drafts only.',
    verdict: null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt:
      status === 'ready'
        ? '2026-07-22T00:01:00.000Z'
        : '2026-07-22T00:00:00.000Z',
    readyAt: status === 'ready' ? '2026-07-22T00:01:00.000Z' : null,
    submittedAt: null,
    failedAt: null,
    archivedAt: null,
  };
}
