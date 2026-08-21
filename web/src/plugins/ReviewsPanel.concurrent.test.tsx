// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PrReviewMutationResponse,
  PrReviewRecord,
  PrReviewsResponse,
} from '../api';

type ApiModule = typeof import('../api');

const api = vi.hoisted(() => ({
  getPrReviews: vi.fn<ApiModule['getPrReviews']>(),
  startPrReview: vi.fn<ApiModule['startPrReview']>(),
  openPrReviewEventStream: vi.fn<ApiModule['openPrReviewEventStream']>(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getPrReviews: api.getPrReviews,
  startPrReview: api.startPrReview,
  openPrReviewEventStream: api.openPrReviewEventStream,
}));

import { ReviewsPanelPlugin } from './ReviewsPanel';

let container: HTMLDivElement;
let root: Root;

describe('ReviewsPanel concurrent row mutations', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    api.getPrReviews.mockResolvedValue(reviewsResponse());
    api.openPrReviewEventStream.mockReturnValue(() => {});
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps earlier rows pending while a later start is still running', async () => {
    const firstStart = deferred<PrReviewMutationResponse>();
    const secondStart = deferred<PrReviewMutationResponse>();
    let startCount = 0;
    api.startPrReview.mockImplementation(() => {
      startCount += 1;
      return startCount === 1 ? firstStart.promise : secondStart.promise;
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        mutations: { retry: false },
        queries: { retry: false },
      },
    });
    const Component = ReviewsPanelPlugin.Component;

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Component />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(reviewButtons()).toHaveLength(2);

    await act(async () => {
      reviewButtons()[0]!.click();
    });
    await settle();

    let buttons = reviewButtons();
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[0]?.textContent).toBe('starting…');
    expect(buttons[1]?.disabled).toBe(false);

    await act(async () => {
      buttons[1]!.click();
    });
    await settle();

    buttons = reviewButtons();
    expect(api.startPrReview).toHaveBeenCalledTimes(2);
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[0]?.textContent).toBe('starting…');
    expect(buttons[1]?.disabled).toBe(true);
    expect(buttons[1]?.textContent).toBe('starting…');

    await act(async () => {
      firstStart.resolve(startedResponse('owner/project', 1));
    });
    await settle();

    expect(reviewButtons()).toHaveLength(1);
    const remaining = reviewButtons()[0];
    expect(remaining?.disabled).toBe(true);
    expect(remaining?.textContent).toBe('starting…');

    await act(async () => {
      secondStart.resolve(startedResponse('owner/project', 2));
    });
    await settle();

    expect(reviewButtons()).toHaveLength(0);
  });
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });
}

function reviewButtons() {
  return [...container.querySelectorAll('button')].filter(
    (button) =>
      button.textContent === 'review' || button.textContent === 'starting…',
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function startedResponse(
  repo: string,
  number: number,
): PrReviewMutationResponse {
  return {
    ok: true,
    action: 'pr_review_start',
    changed: true,
    message: 'started',
    reviewId: `review-${number}`,
    runId: `run-${number}`,
    review: reviewingRecord(repo, number),
  };
}

function reviewingRecord(repo: string, number: number): PrReviewRecord {
  return {
    id: `review-${number}`,
    ref: `${repo}#${number}`,
    repoFullName: repo,
    prNumber: number,
    title: 'Review this change',
    author: 'contributor',
    prUrl: `https://github.com/${repo}/pull/${number}`,
    status: 'reviewing',
    runId: `run-${number}`,
    headSha: 'head-1',
    baseSha: null,
    baseRef: null,
    origin: 'panel',
    reviewUrl: `/review?repo=${encodeURIComponent(repo)}&number=${number}`,
    reportIds: [],
    findingCount: 0,
    seededCount: 0,
    reportOnlyCount: 0,
    reportOnlyFindings: [],
    trustBoundary: 'Local drafts only.',
    verdict: null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: '2026-08-21T12:00:00.000Z',
    updatedAt: '2026-08-21T12:00:00.000Z',
    readyAt: null,
    submittedAt: null,
    failedAt: null,
    archivedAt: null,
  };
}

function reviewsResponse(): PrReviewsResponse {
  return {
    ok: true,
    action: 'pr_reviews_list',
    changed: false,
    items: [],
    groups: {
      awaiting: [awaitingItem(1), awaitingItem(2)],
      inProgress: [],
      needsAction: [],
      submitted: [],
      archived: [],
    },
  };
}

function awaitingItem(number: number) {
  return {
    pullRequest: {
      id: number,
      repo: 'owner/project',
      number,
      title: 'Review this change',
      author: 'contributor',
      url: `https://github.com/owner/project/pull/${number}`,
      state: 'open' as const,
      draft: false,
      comments: 0,
      headSha: 'head-1',
      baseSha: 'base-1',
      baseRef: 'main',
      createdAt: '2026-08-21T11:00:00.000Z',
      updatedAt: '2026-08-21T11:30:00.000Z',
      ageDays: 0,
      stale: false,
      relations: ['review-requested' as const],
      checks: null,
      labels: [],
    },
    review: null,
  };
}
