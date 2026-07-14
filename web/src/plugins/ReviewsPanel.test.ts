import { describe, expect, it } from 'vitest';
import type { PrReviewRecord, PrReviewsResponse } from '../api';
import { applyPrReviewChange } from './ReviewsPanel';

describe('ReviewsPanel review events', () => {
  it('moves one durable record through lifecycle groups without duplication', () => {
    let response = responseWith(review('reviewing'));
    response = applyPrReviewChange(response, review('ready'));
    expect(response.items).toHaveLength(1);
    expect(response.groups.inProgress).toEqual([]);
    expect(response.groups.needsAction).toMatchObject([
      { id: 'review-1', status: 'ready' },
    ]);

    response = applyPrReviewChange(response, review('submitted'));
    expect(response.items).toHaveLength(1);
    expect(response.groups.needsAction).toEqual([]);
    expect(response.groups.submitted).toMatchObject([
      { id: 'review-1', status: 'submitted' },
    ]);
  });
});

function responseWith(record: PrReviewRecord): PrReviewsResponse {
  return {
    ok: true,
    action: 'pr_reviews_list',
    changed: false,
    items: [record],
    groups: {
      awaiting: [],
      inProgress: record.status === 'reviewing' ? [record] : [],
      needsAction: [],
      submitted: [],
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
    origin: 'chat',
    reviewUrl: '/review?repo=other%2Fproject&number=42',
    reportIds: status === 'reviewing' ? [] : ['overview', 'issues'],
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
  };
}
