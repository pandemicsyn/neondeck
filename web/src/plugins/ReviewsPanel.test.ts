import { describe, expect, it } from 'vitest';
import type { PrReviewRecord, PrReviewsResponse } from '../api';
import {
  applyPrReviewChange,
  applyPrReviewSnapshot,
  prReviewRefKey,
  reviewRecommendationLabel,
  reviewReadyDetail,
} from './ReviewsPanel';

describe('ReviewsPanel review events', () => {
  it('uses the recommendation and receipt labels specified for panel rows', () => {
    expect(
      reviewRecommendationLabel({
        ...review('ready'),
        recommendation: 'approve',
      }),
    ).toBe('✓ RECOMMEND APPROVE');
    expect(
      reviewRecommendationLabel({
        ...review('ready'),
        recommendation: 'needs-human',
      }),
    ).toBe('! NEEDS A HUMAN');
    expect(reviewRecommendationLabel(review('submitted'))).toBe(
      '✓ APPROVED BY YOU',
    );
    expect(
      reviewRecommendationLabel({
        ...review('submitted'),
        verdict: 'request-changes',
      }),
    ).toBe('! CHANGES REQUESTED BY YOU');
  });

  it('normalizes equivalent pull request references to one target key', () => {
    expect(prReviewRefKey('Other/Project#042')).toBe('other/project#42');
    expect(
      prReviewRefKey(
        'https://github.com/OTHER/PROJECT.git/pull/42?from=reviews',
      ),
    ).toBe('other/project#42');
  });

  it('distinguishes a previous approval from pending local drafts', () => {
    const approved = {
      ...review('ready'),
      previousVerdict: 'approve' as const,
      seededCount: 2,
    };

    expect(reviewReadyDetail(approved)).toBe(
      'You previously approved this PR on GitHub. 2 local draft comments are not submitted.',
    );
    expect(
      reviewReadyDetail({
        ...approved,
        seededCount: 0,
        findingCount: 0,
        reportOnlyCount: 0,
      }),
    ).toBe(
      'You previously approved this PR on GitHub. Nothing new is pending locally.',
    );
  });

  it('removes an awaiting queue row when its durable review starts', () => {
    const current = responseWith(review('ready'));
    current.groups.awaiting = [awaitingItem(null)];

    const response = applyPrReviewChange(current, {
      ...review('reviewing'),
      repoFullName: 'Other/Project',
    });

    expect(response.groups.awaiting).toEqual([]);
    expect(response.groups.inProgress).toHaveLength(1);
  });

  it('moves one durable record through lifecycle groups without duplication', () => {
    let response = responseWith(review('reviewing'));
    response = applyPrReviewChange(response, review('ready'));
    expect(response.items).toHaveLength(1);
    expect(response.groups.inProgress).toEqual([]);
    expect(response.groups.needsAction).toMatchObject([
      { id: 'review-1', status: 'ready' },
    ]);

    response = applyPrReviewChange(response, review('submitting'));
    expect(response.items).toHaveLength(1);
    expect(response.groups.needsAction).toEqual([]);
    expect(response.groups.inProgress).toMatchObject([
      { id: 'review-1', status: 'submitting' },
    ]);

    response = applyPrReviewChange(response, review('submitted'));
    expect(response.items).toHaveLength(1);
    expect(response.groups.needsAction).toEqual([]);
    expect(response.groups.submitted).toMatchObject([
      { id: 'review-1', status: 'submitted' },
    ]);

    response = applyPrReviewChange(response, {
      ...review('submitted'),
      archivedAt: '2026-07-14T20:03:00.000Z',
    });
    expect(response.groups.submitted).toEqual([]);
    expect(response.groups.archived).toMatchObject([
      { id: 'review-1', status: 'submitted' },
    ]);
  });

  it('merges an authoritative local snapshot without losing GitHub queue context', () => {
    const current = responseWith(review('ready'));
    current.groups.awaiting = [awaitingItem(current.items[0]!)];
    current.queueIssues = ['GitHub queue warning'];
    const started = {
      ...review('reviewing'),
      id: 'review-2',
      ref: 'other/project#43',
      prNumber: 43,
      updatedAt: '2026-07-14T20:02:00.000Z',
    };
    const snapshot = responseWith(started);

    const response = applyPrReviewSnapshot(current, snapshot);

    expect(response.groups.inProgress).toEqual([started]);
    expect(response.groups.needsAction).toEqual([]);
    expect(response.groups.awaiting[0]?.review).toBeNull();
    expect(response.queueIssues).toEqual(['GitHub queue warning']);
  });

  it('removes an awaiting queue row claimed by a local snapshot', () => {
    const current = responseWith(review('ready'));
    current.groups.awaiting = [awaitingItem(null)];
    const started = {
      ...review('reviewing'),
      repoFullName: 'Other/Project',
    };

    const response = applyPrReviewSnapshot(current, responseWith(started));

    expect(response.groups.awaiting).toEqual([]);
    expect(response.groups.inProgress).toEqual([started]);
  });
});

function awaitingItem(reviewRecord: PrReviewRecord | null) {
  return {
    pullRequest: {
      id: 42,
      repo: 'other/project',
      number: 42,
      title: 'Review this change',
      author: 'contributor',
      url: 'https://github.com/other/project/pull/42',
      state: 'open' as const,
      draft: false,
      comments: 0,
      headSha: 'head-1',
      baseSha: 'base-1',
      baseRef: 'main',
      createdAt: '2026-07-14T19:00:00.000Z',
      updatedAt: '2026-07-14T20:01:00.000Z',
      ageDays: 0,
      stale: false,
      relations: ['review-requested' as const],
      checks: null,
      labels: [],
    },
    review: reviewRecord,
  };
}

function responseWith(record: PrReviewRecord): PrReviewsResponse {
  return {
    ok: true,
    action: 'pr_reviews_list',
    changed: false,
    items: [record],
    groups: {
      awaiting: [],
      inProgress:
        record.status === 'reviewing' || record.status === 'submitting'
          ? [record]
          : [],
      needsAction: [],
      submitted: [],
      archived: [],
    },
  };
}

function review(status: PrReviewRecord['status']): PrReviewRecord {
  return {
    id: 'review-1',
    ref: 'other/project#42',
    repoFullName: 'other/project',
    prNumber: 42,
    title: 'Review this change',
    author: 'contributor',
    prUrl: 'https://github.com/other/project/pull/42',
    status,
    runId: 'run-1',
    headSha: 'head-1',
    baseSha: null,
    baseRef: null,
    origin: 'chat',
    reviewUrl: '/review?repo=other%2Fproject&number=42',
    reportIds: status === 'reviewing' ? [] : ['overview', 'issues'],
    recommendation: null,
    recommendationReason: null,
    briefingOverview: null,
    findingCount: status === 'reviewing' ? 0 : 2,
    seededCount: status === 'reviewing' ? 0 : 1,
    reportOnlyCount: status === 'reviewing' ? 0 : 1,
    reportOnlyFindings: [],
    trustBoundary: 'Local drafts only.',
    verdict: status === 'submitted' ? 'approve' : null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: '2026-07-14T20:00:00.000Z',
    updatedAt:
      status === 'reviewing'
        ? '2026-07-14T20:00:00.000Z'
        : '2026-07-14T20:01:00.000Z',
    readyAt: status === 'ready' ? '2026-07-14T20:01:00.000Z' : null,
    submittedAt: status === 'submitted' ? '2026-07-14T20:02:00.000Z' : null,
    failedAt: null,
    archivedAt: null,
  };
}
