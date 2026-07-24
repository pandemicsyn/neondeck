import { describe, expect, it } from 'vitest';
import type { PrReviewRecord, PrReviewsResponse } from '../api';
import { applyPrReviewChange, applyPrReviewSnapshot } from './ReviewsPanel';

describe('ReviewsPanel review events', () => {
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
    current.groups.awaiting = [
      {
        pullRequest: {
          id: 42,
          repo: 'other/project',
          number: 42,
          title: 'Review this change',
          author: 'contributor',
          url: 'https://github.com/other/project/pull/42',
          state: 'open',
          draft: false,
          comments: 0,
          headSha: 'head-1',
          baseSha: 'base-1',
          baseRef: 'main',
          createdAt: '2026-07-14T19:00:00.000Z',
          updatedAt: '2026-07-14T20:01:00.000Z',
          ageDays: 0,
          stale: false,
          relations: ['review-requested'],
          checks: null,
          labels: [],
        },
        review: current.items[0]!,
      },
    ];
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
});

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
