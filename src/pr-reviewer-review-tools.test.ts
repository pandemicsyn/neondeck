import { describe, expect, it, vi } from 'vitest';
import { createPrReviewerReReviewTool } from './modules/pr-reviewer';
import { startBoundPrReview, type PrReviewRecord } from './modules/pr-reviews';
import { runtimePaths } from './runtime-home';

describe('PR reviewer re-review tool', () => {
  it('starts a fresh review for the bound target and latest GitHub head', async () => {
    const review = reviewRecord();
    const restarted = {
      ...review,
      status: 'reviewing' as const,
      origin: 'chat' as const,
      headSha: 'b'.repeat(40),
      runId: 'review-run-2',
    };
    const startReview = vi.fn<typeof startBoundPrReview>(() =>
      Promise.resolve({
        review: restarted,
        reviewId: restarted.id,
        runId: restarted.runId!,
        started: true,
        reason: null,
      }),
    );
    const tool = createPrReviewerReReviewTool(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-review-tools'),
      {
        readReview: () => review,
        startReview,
      },
    );

    await expect(
      tool.run({ data: {}, step: immediateStep() } as never),
    ).resolves.toMatchObject({
      output: {
        ok: true,
        action: 'neondeck_pr_review_restart',
        changed: true,
        data: {
          reviewId: review.id,
          previousHeadSha: review.headSha,
          headSha: restarted.headSha,
          revisionChanged: true,
          status: 'reviewing',
        },
      },
    });
    expect(tool).toMatchObject({ durable: true });
    expect(startReview).toHaveBeenCalledWith(
      {
        ref: review.ref,
        origin: 'chat',
        expectedReview: { id: review.id, headSha: review.headSha },
        returnExistingInProgress: true,
      },
      expect.any(Object),
    );
  });

  it('refuses a stale conversation after another review has settled', async () => {
    const review = reviewRecord();
    const startReview = vi.fn<typeof startBoundPrReview>();
    const tool = createPrReviewerReReviewTool(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-review-tools'),
      {
        readReview: () => ({ ...review, headSha: 'b'.repeat(40) }),
        startReview,
      },
    );

    await expect(
      tool.run({ data: {}, step: immediateStep() } as never),
    ).resolves.toMatchObject({
      output: {
        ok: false,
        changed: false,
        requires: ['currentReviewRevision'],
      },
    });
    expect(startReview).not.toHaveBeenCalled();
  });

  it('treats an in-progress review as an idempotent success', async () => {
    const review = {
      ...reviewRecord(),
      status: 'reviewing' as const,
      headSha: 'b'.repeat(40),
      runId: 'review-run-2',
    };
    const startReview = vi.fn<typeof startBoundPrReview>();
    const tool = createPrReviewerReReviewTool(
      { reviewId: review.id, headSha: 'a'.repeat(40) },
      runtimePaths('/tmp/neondeck-reviewer-review-tools'),
      {
        readReview: () => review,
        startReview,
      },
    );

    await expect(
      tool.run({ data: {}, step: immediateStep() } as never),
    ).resolves.toMatchObject({
      output: {
        ok: true,
        changed: false,
        message: expect.stringContaining('already in progress'),
        data: {
          headSha: review.headSha,
          revisionChanged: true,
        },
      },
    });
    expect(startReview).not.toHaveBeenCalled();
  });

  it('returns a structured failure when submission wins after the initial read', async () => {
    const review = reviewRecord();
    const submitting = { ...review, status: 'submitting' as const };
    const startReview = vi.fn<typeof startBoundPrReview>(() =>
      Promise.resolve({
        review: submitting,
        reviewId: submitting.id,
        runId: null,
        started: false,
        reason: 'submitting',
      }),
    );
    const tool = createPrReviewerReReviewTool(
      { reviewId: review.id, headSha: review.headSha },
      runtimePaths('/tmp/neondeck-reviewer-review-tools'),
      {
        readReview: () => review,
        startReview,
      },
    );

    await expect(
      tool.run({ data: {}, step: immediateStep() } as never),
    ).resolves.toMatchObject({
      output: {
        ok: false,
        changed: false,
        requires: ['settledReviewSubmission'],
      },
    });
    expect(startReview).toHaveBeenCalledOnce();
  });
});

function immediateStep() {
  return {
    do: async <T>(_name: string, effect: () => T | Promise<T>) => effect(),
  };
}

function reviewRecord(): PrReviewRecord {
  return {
    id: 'review-1',
    ref: 'example/repo#42',
    repoFullName: 'example/repo',
    prNumber: 42,
    title: 'Review new changes',
    author: 'contributor',
    prUrl: 'https://github.com/example/repo/pull/42',
    status: 'ready',
    runId: 'review-run-1',
    headSha: 'a'.repeat(40),
    baseSha: 'base-sha',
    baseRef: 'main',
    origin: 'panel',
    reviewUrl: '/review?repo=example%2Frepo&number=42',
    reportIds: [],
    recommendation: null,
    recommendationReason: null,
    briefingOverview: null,
    findingCount: 1,
    seededCount: 1,
    reportOnlyCount: 0,
    reportOnlyFindings: [],
    trustBoundary: 'Local drafts only.',
    verdict: null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    readyAt: '2026-08-20T12:00:00.000Z',
    submittedAt: null,
    failedAt: null,
    archivedAt: null,
  };
}
