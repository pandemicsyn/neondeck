// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PrReviewMutationResponse,
  PrReviewChangeEvent,
  PrReviewRecord,
  PrReviewsResponse,
} from '../api';

type ApiModule = typeof import('../api');

const api = vi.hoisted(() => ({
  getPrReview: vi.fn<ApiModule['getPrReview']>(),
  getPrReviews: vi.fn<ApiModule['getPrReviews']>(),
  startPrReview: vi.fn<ApiModule['startPrReview']>(),
  openPrReviewEventStream: vi.fn<ApiModule['openPrReviewEventStream']>(),
}));
const reviewDraftQueries = vi.hoisted(() => ({
  useGitHubPrReviewDraft: vi.fn(),
}));
const reviewActions = vi.hoisted(() => ({
  submitApproval: vi.fn(),
  usePrReviewBriefingActions: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getPrReview: api.getPrReview,
  getPrReviews: api.getPrReviews,
  startPrReview: api.startPrReview,
  openPrReviewEventStream: api.openPrReviewEventStream,
}));
vi.mock('../features/pr-review/PrReviewArtifactsOverlay', () => ({
  PrReviewArtifactsOverlay: ({
    onClose,
    review,
  }: {
    onClose: () => void;
    review: PrReviewRecord;
  }) => (
    <div data-testid="briefing-overlay">
      <span>{review.status}</span>
      <button onClick={onClose} type="button">
        close briefing
      </button>
    </div>
  ),
}));
vi.mock('../features/pr-review/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../features/pr-review/queries')>()),
  useGitHubPrReviewDraft: reviewDraftQueries.useGitHubPrReviewDraft,
}));
vi.mock('../features/pr-review/usePrReviewBriefingActions', () => ({
  synchronizePrReviewSubmissionLock: vi.fn(),
  usePrReviewBriefingActions: reviewActions.usePrReviewBriefingActions,
}));

import { ReviewsPanelPlugin } from './ReviewsPanel';

let container: HTMLDivElement;
let root: Root;
let reviewEventListener: ((event: PrReviewChangeEvent) => void) | null;

describe('ReviewsPanel concurrent row mutations', () => {
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    reviewEventListener = null;
    api.getPrReviews.mockResolvedValue(reviewsResponse());
    api.getPrReview.mockReturnValue(new Promise(() => {}));
    api.openPrReviewEventStream.mockImplementation((listener) => {
      reviewEventListener = listener;
      return () => {};
    });
    reviewDraftQueries.useGitHubPrReviewDraft.mockReturnValue({
      data: null,
      error: null,
      isError: false,
      isLoading: false,
      isRefetchError: false,
      refetch: vi.fn(),
    });
    reviewActions.submitApproval.mockResolvedValue(undefined);
    reviewActions.usePrReviewBriefingActions.mockReturnValue({
      busy: false,
      submitting: false,
      submitApproval: reviewActions.submitApproval,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows one briefing action for new reviews and no report actions for legacy reviews', async () => {
    const briefing = readyRecord('owner/project', 1, true);
    const legacy = readyRecord('owner/project', 2, false);
    api.getPrReviews.mockResolvedValue({
      ...reviewsResponse(),
      items: [briefing, legacy],
      groups: {
        awaiting: [],
        inProgress: [],
        needsAction: [briefing, legacy],
        submitted: [],
        archived: [],
      },
    });

    await renderPanel();

    expect(
      [...container.querySelectorAll('button')].filter(
        (button) => button.textContent === 'briefing',
      ),
    ).toHaveLength(1);
    expect(container.textContent).not.toContain('overview');
    expect(container.textContent).not.toContain('issues');
  });

  it('shows recommendation reasoning and quick approval only for approve rows', async () => {
    const approve = readyRecord('owner/project', 1, true);
    const needsHuman = {
      ...readyRecord('owner/project', 2, true),
      recommendation: 'needs-human' as const,
      recommendationReason: 'A correctness risk still needs a human decision.',
      briefingOverview: {
        ...readyRecord('owner/project', 2, true).briefingOverview!,
        recommendation: 'needs-human' as const,
        recommendationReason:
          'A correctness risk still needs a human decision.',
      },
    };
    api.getPrReviews.mockResolvedValue({
      ...reviewsResponse(),
      items: [approve, needsHuman],
      groups: {
        awaiting: [],
        inProgress: [],
        needsAction: [approve, needsHuman],
        submitted: [],
        archived: [],
      },
    });

    await renderPanel();

    expect(container.textContent).toContain('✓ RECOMMEND APPROVE');
    expect(container.textContent).toContain('! NEEDS A HUMAN');
    expect(container.textContent).toContain(
      'A correctness risk still needs a human decision.',
    );
    expect(
      [...container.querySelectorAll('button')].filter((button) =>
        button.textContent?.startsWith('approve & submit'),
      ),
    ).toHaveLength(1);
    expect(container.textContent).toContain('no quick approve');
  });

  it('submits an approve recommendation from the row with no review body', async () => {
    const approve = readyRecord('owner/project', 1, true);
    api.getPrReviews.mockResolvedValue({
      ...reviewsResponse(),
      items: [approve],
      groups: {
        awaiting: [],
        inProgress: [],
        needsAction: [approve],
        submitted: [],
        archived: [],
      },
    });
    await renderPanel();

    await act(async () => buttonWithText('approve & submit 0').click());

    expect(reviewActions.submitApproval).toHaveBeenCalledWith('');
  });

  it('turns a submitted row into a durable receipt with its GitHub link', async () => {
    const submitted = {
      ...readyRecord('owner/project', 1, true),
      status: 'submitted' as const,
      verdict: 'approve' as const,
      submissionDraftId: 'draft-1',
      githubReviewUrl:
        'https://github.com/owner/project/pull/1#pullrequestreview-42',
      submittedAt: '2026-08-22T18:05:00.000Z',
    };
    reviewDraftQueries.useGitHubPrReviewDraft.mockReturnValue({
      data: { status: 'submitted', comments: [{ id: 'one' }, { id: 'two' }] },
      error: null,
      isError: false,
      isLoading: false,
      isRefetchError: false,
      refetch: vi.fn(),
    });
    api.getPrReviews.mockResolvedValue({
      ...reviewsResponse(),
      items: [submitted],
      groups: {
        awaiting: [],
        inProgress: [],
        needsAction: [],
        submitted: [submitted],
        archived: [],
      },
    });

    await renderPanel();
    act(() => container.querySelector('summary')?.click());

    expect(container.textContent).toContain('receipt recorded');
    expect(container.textContent).not.toContain('comments sent');
    expect(container.textContent).not.toContain('briefing');
    expect(container.textContent).not.toContain('open review');
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="pullrequestreview"]')
        ?.textContent,
    ).toBe('view on GitHub');
  });

  it('keeps the receipt link available after a submitted review is archived', async () => {
    const archived = {
      ...readyRecord('owner/project', 1, true),
      status: 'submitted' as const,
      verdict: 'approve' as const,
      githubReviewUrl:
        'https://github.com/owner/project/pull/1#pullrequestreview-42',
      submittedAt: '2026-08-22T18:05:00.000Z',
      archivedAt: '2026-08-22T18:10:00.000Z',
    };
    api.getPrReviews.mockResolvedValue({
      ...reviewsResponse(),
      items: [archived],
      groups: {
        awaiting: [],
        inProgress: [],
        needsAction: [],
        submitted: [],
        archived: [archived],
      },
    });

    await renderPanel();

    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="pullrequestreview"]')
        ?.textContent,
    ).toBe('view on GitHub');
    expect(container.textContent).toContain('receipt recorded');
  });

  it('exposes the quick-approval failure reason to assistive technology', async () => {
    const approve = readyRecord('owner/project', 1, true);
    reviewDraftQueries.useGitHubPrReviewDraft.mockReturnValue({
      data: null,
      error: new Error('draft service unavailable'),
      isError: true,
      isLoading: false,
      isRefetchError: false,
      refetch: vi.fn(),
    });
    api.getPrReviews.mockResolvedValue({
      ...reviewsResponse(),
      items: [approve],
      groups: {
        awaiting: [],
        inProgress: [],
        needsAction: [approve],
        submitted: [],
        archived: [],
      },
    });

    await renderPanel();

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    const button = buttonWithText('approve & submit —');
    expect(alert?.textContent).toContain('draft service unavailable');
    expect(button.getAttribute('aria-describedby')).toBe(alert?.id);
    expect(button.disabled).toBe(true);
  });

  it('keeps the selected briefing open as its review moves between groups', async () => {
    const ready = readyRecord('owner/project', 1, true);
    api.getPrReviews.mockResolvedValue({
      ...reviewsResponse(),
      items: [ready],
      groups: {
        awaiting: [],
        inProgress: [],
        needsAction: [ready],
        submitted: [],
        archived: [],
      },
    });
    await renderPanel();

    act(() => buttonWithText('briefing').click());
    expect(
      container.querySelector('[data-testid="briefing-overlay"]')?.textContent,
    ).toContain('ready');

    const submitting = { ...ready, status: 'submitting' as const };
    await act(async () => reviewEventListener?.(reviewEvent(submitting)));
    await settle();
    expect(
      container.querySelector('[data-testid="briefing-overlay"]')?.textContent,
    ).toContain('submitting');

    const submitted = {
      ...ready,
      status: 'submitted' as const,
      verdict: 'approve' as const,
      githubReviewUrl: 'https://github.com/owner/project/pull/1#review-1',
      submittedAt: '2026-08-22T18:05:00.000Z',
    };
    await act(async () => reviewEventListener?.(reviewEvent(submitted)));
    await settle();
    expect(
      container.querySelector('[data-testid="briefing-overlay"]')?.textContent,
    ).toContain('submitted');
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

  it('keeps an earlier concurrent failure visible after a later start succeeds', async () => {
    const firstStart = deferred<PrReviewMutationResponse>();
    const secondStart = deferred<PrReviewMutationResponse>();
    let startCount = 0;
    api.startPrReview.mockImplementation(() => {
      startCount += 1;
      return startCount === 1 ? firstStart.promise : secondStart.promise;
    });
    await renderPanel();

    await act(async () => {
      reviewButtons()[0]!.click();
    });
    await settle();
    await act(async () => {
      reviewButtons()[1]!.click();
    });
    await settle();

    await act(async () => {
      firstStart.reject(new Error('First review failed'));
    });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'First review failed',
    );
    expect(reviewButtons()[0]?.disabled).toBe(false);
    expect(reviewButtons()[1]?.disabled).toBe(true);

    await act(async () => {
      secondStart.resolve(startedResponse('owner/project', 2));
    });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'First review failed',
    );
  });

  it('matches a pending GitHub URL to its canonical awaiting row', async () => {
    const start = deferred<PrReviewMutationResponse>();
    api.startPrReview.mockReturnValue(start.promise);
    await renderPanel();

    await act(async () => {
      buttonWithText('+ review a PR').click();
    });
    const input = container.querySelector('input')!;
    await act(async () => {
      setInputValue(
        input,
        'https://github.com/OWNER/PROJECT/pull/1?from=reviews',
      );
    });
    await settle();
    await act(async () => {
      buttonWithText('start').click();
    });
    await settle();

    expect(api.startPrReview).toHaveBeenCalledWith({
      origin: 'panel',
      ref: 'https://github.com/OWNER/PROJECT/pull/1?from=reviews',
    });
    expect(reviewButtons()[0]?.disabled).toBe(true);
    expect(reviewButtons()[0]?.textContent).toBe('starting…');
    expect(reviewButtons()[1]?.disabled).toBe(false);
    expect(buttonWithText('starting').disabled).toBe(true);

    await act(async () => {
      start.resolve(startedResponse('owner/project', 1));
    });
    await settle();
  });
});

async function renderPanel() {
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
}

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

function buttonWithText(text: string) {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('HTMLInputElement value setter not found.');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
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
    recommendation: null,
    recommendationReason: null,
    briefingOverview: null,
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

function readyRecord(
  repo: string,
  number: number,
  withBriefing: boolean,
): PrReviewRecord {
  return {
    ...reviewingRecord(repo, number),
    status: 'ready',
    reportIds: withBriefing ? [] : ['legacy-overview', 'legacy-issues'],
    recommendation: withBriefing ? 'approve' : null,
    recommendationReason: withBriefing
      ? 'The bounded change appears safe.'
      : null,
    briefingOverview: withBriefing
      ? {
          schemaVersion: 1,
          recommendation: 'approve',
          recommendationReason: 'The bounded change appears safe.',
          summary: 'The change is bounded and covered.',
          changeMap: [],
          risks: [],
        }
      : null,
    readyAt: '2026-08-21T12:01:00.000Z',
  };
}

function reviewEvent(review: PrReviewRecord): PrReviewChangeEvent {
  return {
    id: `event:${review.id}:${review.status}`,
    action: 'changed',
    review,
    changedAt: review.updatedAt,
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
