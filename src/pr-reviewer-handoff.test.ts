import { describe, expect, it } from 'vitest';
import { buildPrReviewerHandoff } from './modules/pr-reviewer';
import type { PrReviewRecord } from './modules/pr-reviews';

describe('PR reviewer workflow handoff', () => {
  it('loads bounded guidance from the persisted briefing overview', () => {
    const review = reviewRecord();
    const handoff = buildPrReviewerHandoff(review);

    expect(handoff).toMatchObject({
      available: true,
      runId: 'run-123',
      headSha: review.headSha,
      summary: 'Initial review summary',
      changeMap: [{ label: 'src/app.ts', value: 'Adds the guarded branch.' }],
      conclusions: [
        { label: 'risk 1', value: 'The fallback may hide failures.' },
      ],
      findingCounts: { total: 2, seededDrafts: 1, reportOnly: 1 },
    });
  });

  it('reports a missing handoff without reading legacy report ids', () => {
    const review = reviewRecord();
    review.briefingOverview = null;
    review.recommendation = null;
    review.recommendationReason = null;
    expect(buildPrReviewerHandoff(review)).toMatchObject({
      available: false,
      summary: null,
      changeMap: [],
      conclusions: [],
    });
  });
});

function reviewRecord(): PrReviewRecord {
  return {
    id: 'review-123',
    ref: 'pandemicsyn/neondeck#177',
    repoFullName: 'pandemicsyn/neondeck',
    prNumber: 177,
    title: 'Improve reviewer handoff',
    author: 'pandemicsyn',
    prUrl: 'https://github.com/pandemicsyn/neondeck/pull/177',
    status: 'ready',
    runId: 'run-123',
    headSha: 'new-head',
    baseSha: 'base-sha',
    baseRef: 'main',
    origin: 'panel',
    reviewUrl: '/review?repo=pandemicsyn%2Fneondeck&number=177',
    reportIds: ['legacy-overview'],
    recommendation: 'needs-human',
    recommendationReason: 'A major finding requires human review.',
    briefingOverview: {
      schemaVersion: 1,
      recommendation: 'needs-human',
      recommendationReason: 'A major finding requires human review.',
      summary: 'Initial review summary',
      changeMap: [{ path: 'src/app.ts', summary: 'Adds the guarded branch.' }],
      risks: ['The fallback may hide failures.'],
    },
    findingCount: 2,
    seededCount: 1,
    reportOnlyCount: 1,
    reportOnlyFindings: [],
    trustBoundary: 'Local drafts only.',
    verdict: null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: '2026-07-22T12:00:00.000Z',
    updatedAt: '2026-07-22T12:01:00.000Z',
    readyAt: '2026-07-22T12:01:00.000Z',
    submittedAt: null,
    failedAt: null,
    archivedAt: null,
  };
}
