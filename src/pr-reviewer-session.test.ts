import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parsePrReviewerConversationId,
  prReviewerConversationId,
} from '../shared/pr-reviewer-session';
import { createPrReviewerRoute } from './agents/pr-reviewer';
import { completePrReview, startPrReview } from './modules/pr-reviews';
import { prReviewBriefingFixture } from './testing/pr-review-draft-fixtures';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('PR reviewer conversation IDs', () => {
  it('binds a conversation to one reviewed head revision', () => {
    const reviewId = 'review-123';
    const headSha = 'a'.repeat(40);

    expect(
      parsePrReviewerConversationId(
        prReviewerConversationId(reviewId, headSha),
      ),
    ).toEqual({ reviewId, headSha });
  });

  it('rejects an old revision before Flue admits another reviewer turn', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-reviewer-route-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const dependencies = {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => reviewDetail('a'.repeat(40)),
      invokeWorkflow: async () => ({ runId: 'review-old' }),
    };
    const first = await startPrReview(
      { ref: 'other/project#42', origin: 'api' },
      paths,
      dependencies,
    );
    completePrReview(
      {
        reviewId: first.reviewId,
        runId: first.runId,
        headSha: 'a'.repeat(40),
        reportIds: [],
        reviewUrl: first.review.reviewUrl,
        briefingOverview: prReviewBriefingFixture(),
        findingCount: 0,
        seededCount: 0,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );
    await startPrReview({ ref: 'other/project#42', origin: 'panel' }, paths, {
      ...dependencies,
      fetchDetail: async () => reviewDetail('b'.repeat(40)),
      invokeWorkflow: async () => ({ runId: 'review-current' }),
    });
    const app = new Hono();
    app.use('/api/flue/agents/pr-reviewer/*', createPrReviewerRoute(paths));
    app.post('/api/flue/agents/pr-reviewer/:id', (context) =>
      context.json({ admitted: true }, 202),
    );

    const staleId = prReviewerConversationId(first.reviewId, 'a'.repeat(40));
    const stale = await app.request(
      `http://localhost/api/flue/agents/pr-reviewer/${encodeURIComponent(staleId)}`,
      { method: 'POST' },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: {
        type: 'review_revision_stale',
        meta: {
          conversationHeadSha: 'a'.repeat(40),
          currentHeadSha: 'b'.repeat(40),
        },
      },
    });

    const currentId = prReviewerConversationId(first.reviewId, 'b'.repeat(40));
    const current = await app.request(
      `http://localhost/api/flue/agents/pr-reviewer/${encodeURIComponent(currentId)}`,
      { method: 'POST' },
    );
    expect(current.status).toBe(202);
  });

  it('rejects unversioned message admission without blocking conversation reads or controls', async () => {
    const app = new Hono();
    app.use('/api/flue/agents/pr-reviewer/*', createPrReviewerRoute());
    app.all('/api/flue/agents/pr-reviewer/*', (context) =>
      context.json({ passedThrough: true }),
    );
    const conversationUrl =
      'http://localhost/api/flue/agents/pr-reviewer/review-123';

    const admission = await app.request(conversationUrl, { method: 'POST' });
    expect(admission.status).toBe(409);
    await expect(admission.json()).resolves.toMatchObject({
      error: {
        type: 'review_revision_required',
        meta: { reviewId: 'review-123' },
      },
    });

    for (const request of [
      { url: `${conversationUrl}?view=history`, method: 'GET' },
      { url: `${conversationUrl}/attachments/image-1`, method: 'GET' },
      { url: `${conversationUrl}/abort`, method: 'POST' },
    ]) {
      const response = await app.request(request.url, {
        method: request.method,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ passedThrough: true });
    }
  });
});

function reviewDetail(headSha: string) {
  return {
    number: 42,
    title: 'Review this change',
    body: null,
    repo: 'other/project',
    url: 'https://github.com/other/project/pull/42',
    state: 'open' as const,
    draft: false,
    author: 'contributor',
    labels: [],
    comments: 0,
    merged: false,
    mergeCommitSha: null,
    headSha,
    headRef: 'feature',
    headOwner: 'other',
    headName: 'project',
    headRepoFullName: 'other/project',
    baseRef: 'main',
    baseSha: 'base',
    baseRepoFullName: 'other/project',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    createdAt: '2026-07-14T20:00:00.000Z',
    updatedAt: '2026-07-14T20:00:00.000Z',
  };
}
