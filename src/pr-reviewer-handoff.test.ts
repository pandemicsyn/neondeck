import { describe, expect, it } from 'vitest';
import { buildPrReviewerHandoff } from './modules/pr-reviewer';
import type { PrReviewRecord } from './modules/pr-reviews';
import type { ReportRecord } from './modules/reports';

describe('PR reviewer workflow handoff', () => {
  it('loads bounded conclusions from the completed review revision', () => {
    const review = reviewRecord();
    const handoff = buildPrReviewerHandoff(review, [
      report('old-head', 'Stale summary'),
      report(review.headSha, 'Initial review summary'),
    ]);

    expect(handoff).toMatchObject({
      available: true,
      runId: 'run-123',
      headSha: review.headSha,
      summary: 'Initial review summary',
      changeMap: [{ label: 'src/app.ts', value: 'Adds the guarded branch.' }],
      conclusions: [
        { label: 'risk 1', value: 'The fallback may hide failures.' },
        { label: 'check 1', value: 'Unit tests passed.' },
      ],
      findingCounts: { total: 2, seededDrafts: 1, reportOnly: 1 },
    });
  });

  it('reports a missing handoff without inventing review conclusions', () => {
    expect(buildPrReviewerHandoff(reviewRecord(), [])).toMatchObject({
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
    reportIds: ['overview'],
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

function report(headSha: string, summary: string): ReportRecord {
  return {
    id: `report-${headSha}`,
    kind: 'pr-review',
    title: 'PR Overview',
    repoId: 'neondeck',
    sourceRef: 'pandemicsyn/neondeck#177',
    htmlPath: `pr-review/${headSha}.html`,
    createdBy: 'review-pr-for-human',
    createdAt: '2026-07-22T12:01:00.000Z',
    summary: {
      workflow: 'review-pr-for-human',
      report: 'overview',
      headSha,
      document: {
        eyebrow: 'PR REVIEW',
        title: 'PR Overview',
        summary,
        generatedAt: '2026-07-22T12:01:00.000Z',
        sections: [
          {
            title: 'Change Map',
            body: null,
            items: [{ label: 'src/app.ts', value: 'Adds the guarded branch.' }],
          },
          {
            title: 'Checks, Risks, And Next Actions',
            body: null,
            items: [
              { label: 'risk 1', value: 'The fallback may hide failures.' },
              { label: 'check 1', value: 'Unit tests passed.' },
            ],
          },
        ],
      },
    },
  };
}
