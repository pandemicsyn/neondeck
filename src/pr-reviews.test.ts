import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlueObservation } from '@flue/runtime';
import {
  archivePrReview,
  beginPrReviewSubmissionAttempt,
  clearPrReviewRemoteRefreshForTests,
  completePrReview,
  failPrReview,
  prReviewRemoteRefreshIntervalMs,
  readPrReviewAdmissionBinding,
  readPrReviewForTarget,
  recentPrReviews,
  refreshPrReviewRemoteState,
  reconcilePrReviewSubmission,
  releasePrReviewSubmission,
  restorePrReview,
  reservePrReviewSubmission,
  startBoundPrReview,
  startPrReview,
  submitPrReview,
  subscribePrReviewEvents,
  type StartPrReviewDependencies,
  type PrReviewEvent,
} from './modules/pr-reviews';
import {
  reconcilePrReviewAssistSettlement,
  recoverInterruptedPrReviewAssists,
  settlePrReviewAssistObservation,
  watchPrReviewAssistSettlement,
  type PrReviewAssistAdmission,
} from './modules/pr-review-assist';
import { openDb } from './lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { createGitHubRoutes } from './server/routes/github';
import { createReviewRoutes } from './server/routes/reviews';

const roots: string[] = [];

afterEach(async () => {
  clearPrReviewRemoteRefreshForTests();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('durable PR reviews', () => {
  it('recovers an admitted attempt whose submission id was not attached', async () => {
    const paths = await tempPaths();
    const started = await startPrReview(
      { ref: 'https://github.com/Other/Project/pull/42', origin: 'api' },
      paths,
      {
        resolveTarget: async () => ({
          repoFullName: 'Other/Project',
          owner: 'Other',
          repo: 'Project',
          number: 42,
        }),
        fetchDetail: async () => detail('head-1'),
        invokeWorkflow: async () => ({ runId: 'submission:lost-attachment' }),
      },
    );
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare('UPDATE pr_reviews SET run_id = NULL WHERE id = ?;')
        .run(started.reviewId);
    } finally {
      database.close();
    }
    const admit = vi.fn<PrReviewAssistAdmission>(async () => ({
      runId: 'submission:recovered',
    }));

    await expect(
      recoverInterruptedPrReviewAssists(
        paths,
        async () => ({ failed: false }),
        admit,
      ),
    ).resolves.toMatchObject({
      recovered: [started.reviewId],
      failed: [],
    });
    expect(admit).toHaveBeenCalledWith({
      ref: 'other/project#42',
      reviewId: started.reviewId,
      attemptId: expect.any(String),
      repoFullName: 'other/project',
      prNumber: 42,
      headSha: 'head-1',
      baseSha: 'base',
      baseRef: 'main',
    });
    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      status: 'reviewing',
      runId: 'submission:recovered',
    });
  });

  it('freezes the admitted PR revision in Flue initial data', async () => {
    const paths = await tempPaths();
    const invokeWorkflow = vi.fn<
      NonNullable<StartPrReviewDependencies['invokeWorkflow']>
    >(async () => ({ runId: 'revision-run' }));

    await startPrReview(
      { ref: 'https://github.com/Other/Project/pull/42', origin: 'api' },
      paths,
      {
        resolveTarget: async () => ({
          repoFullName: 'Other/Project',
          owner: 'Other',
          repo: 'Project',
          number: 42,
        }),
        fetchDetail: async () => detail('exact-head'),
        invokeWorkflow,
      },
    );

    expect(invokeWorkflow).toHaveBeenCalledWith({
      ref: 'other/project#42',
      reviewId: expect.any(String),
      attemptId: expect.any(String),
      repoFullName: 'other/project',
      prNumber: 42,
      headSha: 'exact-head',
      baseSha: 'base',
      baseRef: 'main',
    });
  });

  it('retries transient settlement reads until the bound attempt settles', async () => {
    const paths = await tempPaths();
    const started = await startPrReview(
      { ref: 'other/project#42', origin: 'api' },
      paths,
      {
        resolveTarget: async () => ({
          repoFullName: 'other/project',
          owner: 'other',
          repo: 'project',
          number: 42,
        }),
        fetchDetail: async () => detail('head-1'),
        invokeWorkflow: async () => ({ runId: 'submission:transient-read' }),
      },
    );
    const readSettlement = vi
      .fn<() => Promise<{ failed: boolean }>>()
      .mockRejectedValueOnce(new Error('temporary read outage'))
      .mockResolvedValueOnce({ failed: true });
    const attemptId = readPrReviewAdmissionBinding(
      started.reviewId,
      paths,
    )?.attemptId;
    if (!attemptId) throw new Error('Review attempt was not persisted.');

    await watchPrReviewAssistSettlement(
      {
        reviewId: started.reviewId,
        attemptId,
        submissionId: started.runId,
      },
      paths,
      readSettlement,
      { retryDelayMs: 0 },
    );

    expect(readSettlement).toHaveBeenCalledTimes(2);
    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      status: 'failed',
    });
  });

  it('fails reviewing and ready attempts when their Flue submission fails', async () => {
    const paths = await tempPaths();
    const dependencies = {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => detail('head-1'),
      invokeWorkflow: async () => ({ runId: 'submission:review:failed' }),
    };
    const started = await startPrReview(
      { ref: 'other/project#42', origin: 'api' },
      paths,
      dependencies,
    );
    completePrReview(
      {
        reviewId: started.reviewId,
        runId: started.runId,
        headSha: 'head-1',
        reportIds: ['overview'],
        reviewUrl: started.review.reviewUrl,
        findingCount: 0,
        seededCount: 0,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );

    const settled = settlePrReviewAssistObservation(
      {
        type: 'submission_settled',
        v: 3,
        eventIndex: 1,
        timestamp: new Date().toISOString(),
        agentName: 'pr-review-assistant',
        instanceId: 'pr-review:test',
        submissionId: started.runId,
        outcome: 'failed',
        error: { message: 'provider failed' },
      } as Extract<FlueObservation, { type: 'submission_settled' }>,
      paths,
    );
    expect(settled).toMatchObject({
      status: 'failed',
      failureMessage: 'provider failed',
    });

    const restarted = await startPrReview(
      { ref: 'other/project#42', origin: 'api' },
      paths,
      {
        ...dependencies,
        invokeWorkflow: async () => ({ runId: 'submission:review:restart' }),
      },
    );
    await expect(
      reconcilePrReviewAssistSettlement(
        {
          reviewId: restarted.reviewId,
          attemptId: readAttemptId(restarted.reviewId, paths),
          submissionId: restarted.runId,
        },
        paths,
        async ({ instanceId, submissionId }) => {
          expect(instanceId).toBe(
            `pr-review:${restarted.reviewId}:${readAttemptId(restarted.reviewId, paths)}`,
          );
          expect(submissionId).toBe(restarted.runId);
          return { failed: true };
        },
      ),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('publishes reviewing, ready, submitted, and same-record re-review transitions', async () => {
    const paths = await tempPaths();
    const events: PrReviewEvent[] = [];
    const unsubscribe = subscribePrReviewEvents((event) => events.push(event));
    const dependencies = {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => detail('head-1'),
      invokeWorkflow: async () => ({ runId: 'review-run-1' }),
    };

    const started = await startPrReview(
      { ref: 'https://github.com/other/project/pull/42', origin: 'chat' },
      paths,
      dependencies,
    );

    expect(started).toMatchObject({
      reviewId: started.review.id,
      runId: 'review-run-1',
      review: {
        repoFullName: 'other/project',
        prNumber: 42,
        status: 'reviewing',
        runId: 'review-run-1',
        origin: 'chat',
        headSha: 'head-1',
      },
    });
    expect(events.map((event) => event.review.status)).toEqual([
      'reviewing',
      'reviewing',
    ]);

    const ready = completePrReview(
      {
        reviewId: started.reviewId,
        runId: started.runId,
        headSha: 'head-1',
        reportIds: ['overview', 'issues'],
        reviewUrl: '/review?repo=other%2Fproject&number=42',
        findingCount: 3,
        seededCount: 2,
        reportOnlyCount: 1,
        reportOnlyFindings: [
          {
            severity: 'minor',
            path: 'src/app.ts',
            line: null,
            summary: 'Could not anchor this finding.',
            suggestedFix: 'Inspect the surrounding function.',
            reason: 'unanchorable',
          },
        ],
      },
      paths,
    );
    expect(ready).toMatchObject({
      status: 'ready',
      reportIds: ['overview', 'issues'],
      findingCount: 3,
      seededCount: 2,
      reportOnlyCount: 1,
    });
    expect(
      completePrReview(
        {
          reviewId: started.reviewId,
          runId: started.runId,
          headSha: 'late-head',
          reportIds: ['late'],
          reviewUrl: ready?.reviewUrl ?? '',
          findingCount: 99,
          seededCount: 99,
          reportOnlyCount: 0,
          reportOnlyFindings: [],
        },
        paths,
      ),
    ).toBeNull();
    expect(
      failPrReview(
        {
          reviewId: started.reviewId,
          runId: started.runId,
          message: 'late action failure',
        },
        paths,
      ),
    ).toBeNull();

    const reserved = reservePrReviewSubmission(
      {
        repoFullName: 'other/project',
        prNumber: 42,
        headSha: 'head-1',
        verdict: 'approve',
      },
      paths,
    );
    expect(reserved).toMatchObject({ status: 'submitting' });
    const submitted = submitPrReview(
      {
        reviewId: reserved?.id ?? '',
        verdict: 'approve',
        githubReviewUrl: 'https://github.com/other/project/pull/42#review',
      },
      paths,
    );
    expect(submitted).toMatchObject({
      id: started.reviewId,
      status: 'submitted',
      verdict: 'approve',
    });
    expect(
      failPrReview(
        {
          runId: started.runId,
          allowReady: true,
          message: 'late framework failure',
        },
        paths,
      ),
    ).toBeNull();

    const restarted = await startPrReview(
      { ref: 'other/project#42', origin: 'panel' },
      paths,
      {
        ...dependencies,
        resolveTarget: async () => ({
          repoFullName: 'Other/Project',
          owner: 'Other',
          repo: 'Project',
          number: 42,
        }),
        fetchDetail: async () => detail('head-2'),
        invokeWorkflow: async () => ({ runId: 'review-run-2' }),
      },
    );
    expect(restarted.review).toMatchObject({
      id: started.reviewId,
      status: 'reviewing',
      runId: 'review-run-2',
      headSha: 'head-2',
      verdict: null,
      previousVerdict: 'approve',
      reportIds: [],
      findingCount: 0,
      seededCount: 0,
      reportOnlyCount: 0,
      reportOnlyFindings: [],
    });
    expect(readPrReviewForTarget('OTHER/PROJECT', 42, paths)).toMatchObject({
      id: started.reviewId,
    });
    unsubscribe();
  });

  it('archives settled reviews, restores them, and unarchives on re-review', async () => {
    const paths = await tempPaths();
    const dependencies = {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => detail('head-1'),
      invokeWorkflow: async () => ({ runId: 'archive-run-1' }),
    };
    const started = await startPrReview(
      { ref: 'other/project#42', origin: 'panel' },
      paths,
      dependencies,
    );

    expect(() =>
      archivePrReview({ reviewId: started.reviewId }, paths),
    ).toThrow('An active review cannot be archived.');
    failPrReview({ runId: started.runId, message: 'Review timed out.' }, paths);

    const archived = archivePrReview({ reviewId: started.reviewId }, paths);
    expect(archived).toMatchObject({
      changed: true,
      review: { status: 'failed', archivedAt: expect.any(String) },
    });
    expect(
      archivePrReview({ reviewId: started.reviewId }, paths),
    ).toMatchObject({ changed: false });
    expect(recentPrReviews(paths)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: started.reviewId,
          archivedAt: expect.any(String),
        }),
      ]),
    );

    expect(
      restorePrReview({ reviewId: started.reviewId }, paths),
    ).toMatchObject({
      changed: true,
      review: { archivedAt: null, status: 'failed' },
    });
    archivePrReview({ reviewId: started.reviewId }, paths);
    const restarted = await startPrReview(
      { ref: 'other/project#42', origin: 'panel' },
      paths,
      {
        ...dependencies,
        fetchDetail: async () => detail('head-2'),
        invokeWorkflow: async () => ({ runId: 'archive-run-2' }),
      },
    );
    expect(restarted.review).toMatchObject({
      id: started.reviewId,
      status: 'reviewing',
      archivedAt: null,
    });
  });

  it('records the current reviewer verdict and refreshes it at most every three minutes', async () => {
    const paths = await tempPaths();
    const ready = await startReadyReview(paths, 'remote-state-run');
    let now = new Date('2026-07-24T17:00:00.000Z');
    let detailCalls = 0;
    const dependencies = {
      token: 'token',
      now: () => now,
      fetchLogin: async () => 'reviewer',
      fetchDetail: async () => {
        detailCalls += 1;
        return detail('head-1');
      },
      fetchReviews: async () => [
        {
          id: 99,
          nodeId: 'review-node-99',
          state: 'APPROVED',
          authorLogin: 'Reviewer',
          submittedAt: '2026-07-24T16:00:00.000Z',
          commitId: 'head-1',
          url: 'https://github.com/other/project/pull/42#review-99',
          body: null,
        },
      ],
    };

    await expect(
      refreshPrReviewRemoteState(paths, dependencies),
    ).resolves.toMatchObject({
      changed: 1,
      inspected: 1,
      errors: [],
      skipped: false,
    });
    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      id: ready.reviewId,
      status: 'ready',
      previousVerdict: 'approve',
    });

    now = new Date(now.getTime() + prReviewRemoteRefreshIntervalMs - 1);
    await expect(
      refreshPrReviewRemoteState(paths, dependencies),
    ).resolves.toMatchObject({ skipped: true });
    expect(detailCalls).toBe(1);
  });

  it('automatically archives a settled review after its pull request closes', async () => {
    const paths = await tempPaths();
    const ready = await startReadyReview(paths, 'merged-review-run');

    await expect(
      refreshPrReviewRemoteState(
        paths,
        {
          token: 'token',
          fetchLogin: async () => 'reviewer',
          fetchDetail: async () => ({
            ...detail('head-1'),
            state: 'closed',
            merged: true,
            mergeCommitSha: 'merge-sha',
          }),
          fetchReviews: async () => {
            throw new Error('Closed reviews do not need review history.');
          },
        },
        { force: true },
      ),
    ).resolves.toMatchObject({
      changed: 1,
      inspected: 1,
      errors: [],
    });
    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      id: ready.reviewId,
      status: 'ready',
      archivedAt: expect.any(String),
    });
  });

  it('physically deletes submitted review rows after fourteen days', async () => {
    const paths = await tempPaths();
    const started = await startPrReview(
      { ref: 'other/project#42', origin: 'api' },
      paths,
      {
        resolveTarget: async () => ({
          repoFullName: 'other/project',
          owner: 'other',
          repo: 'project',
          number: 42,
        }),
        fetchDetail: async () => detail('head-1'),
        invokeWorkflow: async () => ({ runId: 'retention-run' }),
      },
    );
    completePrReview(
      {
        reviewId: started.reviewId,
        runId: started.runId,
        headSha: 'head-1',
        reportIds: ['overview'],
        reviewUrl: started.review.reviewUrl,
        findingCount: 0,
        seededCount: 0,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );
    reservePrReviewSubmission(
      {
        repoFullName: 'other/project',
        prNumber: 42,
        headSha: 'head-1',
        verdict: 'comment',
      },
      paths,
    );
    submitPrReview(
      { reviewId: started.reviewId, verdict: 'comment', githubReviewUrl: null },
      paths,
    );

    const now = Date.parse('2026-07-21T18:00:00.000Z');
    setSubmittedAt(paths.neondeckDatabase, started.reviewId, now, 13);
    recentPrReviews(paths, now);
    expect(readPrReviewForTarget('other/project', 42, paths)).not.toBeNull();

    setSubmittedAt(paths.neondeckDatabase, started.reviewId, now, 15);
    recentPrReviews(paths, now);
    expect(readPrReviewForTarget('other/project', 42, paths)).toBeNull();
  });

  it('rejects overlapping starts before a second workflow can create artifacts', async () => {
    const paths = await tempPaths();
    const attempts: string[] = [];
    let releaseFirst!: (value: { runId: string }) => void;
    let markFirstInvoked!: () => void;
    const firstAdmission = new Promise<{ runId: string }>((resolve) => {
      releaseFirst = resolve;
    });
    const firstInvoked = new Promise<void>((resolve) => {
      markFirstInvoked = resolve;
    });
    const dependencies = {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => detail('head-1'),
      invokeWorkflow: async (input: { attemptId: string }) => {
        attempts.push(input.attemptId);
        if (attempts.length === 1) markFirstInvoked();
        return attempts.length === 1
          ? firstAdmission
          : { runId: `run-${attempts.length}` };
      },
    };

    const firstStart = startPrReview(
      { ref: 'other/project#42', origin: 'chat' },
      paths,
      dependencies,
    );
    await firstInvoked;
    await expect(
      startPrReview(
        { ref: 'OTHER/PROJECT#42', origin: 'panel' },
        paths,
        dependencies,
      ),
    ).rejects.toThrow(/already in progress/);
    expect(attempts).toHaveLength(1);
    releaseFirst({ runId: 'run-1' });
    const started = await firstStart;
    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      status: 'reviewing',
      runId: started.runId,
      headSha: 'head-1',
    });
  });

  it('atomically admits one bound re-review when both requests finish fetching together', async () => {
    const paths = await tempPaths();
    const target = async () => ({
      repoFullName: 'other/project',
      owner: 'other',
      repo: 'project',
      number: 42,
    });
    const original = await startPrReview(
      { ref: 'other/project#42', origin: 'panel' },
      paths,
      {
        resolveTarget: target,
        fetchDetail: async () => detail('head-1'),
        invokeWorkflow: async () => ({ runId: 'run-original' }),
      },
    );
    completePrReview(
      {
        reviewId: original.reviewId,
        runId: original.runId,
        headSha: 'head-1',
        reportIds: [],
        reviewUrl: original.review.reviewUrl,
        findingCount: 0,
        seededCount: 0,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );

    let fetched = 0;
    let releaseFetches!: () => void;
    const bothFetched = new Promise<void>((resolve) => {
      releaseFetches = resolve;
    });
    let releaseAdmission!: (value: { runId: string }) => void;
    const admission = new Promise<{ runId: string }>((resolve) => {
      releaseAdmission = resolve;
    });
    const attempts: string[] = [];
    const dependencies = {
      resolveTarget: target,
      fetchDetail: async () => {
        fetched += 1;
        if (fetched === 2) releaseFetches();
        await bothFetched;
        return detail('head-2');
      },
      invokeWorkflow: async (input: { attemptId: string }) => {
        attempts.push(input.attemptId);
        return admission;
      },
    };
    const input = {
      ref: 'other/project#42',
      origin: 'chat' as const,
      expectedReview: { id: original.reviewId, headSha: 'head-1' },
      returnExistingInProgress: true as const,
    };

    const first = startBoundPrReview(input, paths, dependencies);
    const second = startBoundPrReview(input, paths, dependencies);
    await vi.waitFor(() => expect(attempts).toHaveLength(1));
    releaseAdmission({ runId: 'run-rereview' });
    const results = await Promise.all([first, second]);

    expect(attempts).toHaveLength(1);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ started: true, runId: 'run-rereview' }),
        expect.objectContaining({ started: false }),
      ]),
    );
    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      status: 'reviewing',
      runId: 'run-rereview',
      headSha: 'head-2',
    });
  });

  it('returns a typed bound-start result when submission wins during detail fetch', async () => {
    const paths = await tempPaths();
    const target = async () => ({
      repoFullName: 'other/project',
      owner: 'other',
      repo: 'project',
      number: 42,
    });
    const original = await startPrReview(
      { ref: 'other/project#42', origin: 'panel' },
      paths,
      {
        resolveTarget: target,
        fetchDetail: async () => detail('head-1'),
        invokeWorkflow: async () => ({ runId: 'run-original' }),
      },
    );
    completePrReview(
      {
        reviewId: original.reviewId,
        runId: original.runId,
        headSha: 'head-1',
        reportIds: [],
        reviewUrl: original.review.reviewUrl,
        findingCount: 0,
        seededCount: 0,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );
    const invokeWorkflow =
      vi.fn<NonNullable<StartPrReviewDependencies['invokeWorkflow']>>();

    await expect(
      startBoundPrReview(
        {
          ref: 'other/project#42',
          origin: 'chat',
          expectedReview: { id: original.reviewId, headSha: 'head-1' },
          returnExistingInProgress: true,
        },
        paths,
        {
          resolveTarget: target,
          fetchDetail: async () => {
            const database = openDb(paths.neondeckDatabase);
            try {
              database
                .prepare(
                  `UPDATE pr_reviews SET status = 'submitting' WHERE id = ?;`,
                )
                .run(original.reviewId);
            } finally {
              database.close();
            }
            return detail('head-2');
          },
          invokeWorkflow,
        },
      ),
    ).resolves.toMatchObject({
      reviewId: original.reviewId,
      runId: null,
      started: false,
      reason: 'submitting',
      review: { status: 'submitting' },
    });
    expect(invokeWorkflow).not.toHaveBeenCalled();
  });

  it('reserves a submit against concurrent re-review and can release failures', async () => {
    const paths = await tempPaths();
    const dependencies = {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => detail('head-1'),
      invokeWorkflow: async () => ({ runId: 'submit-race-run-1' }),
    };
    const started = await startPrReview(
      { ref: 'other/project#42', origin: 'api' },
      paths,
      dependencies,
    );
    completePrReview(
      {
        reviewId: started.reviewId,
        runId: started.runId,
        headSha: 'head-1',
        reportIds: ['overview'],
        reviewUrl: started.review.reviewUrl,
        findingCount: 1,
        seededCount: 1,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );
    const reserved = reservePrReviewSubmission(
      {
        repoFullName: 'other/project',
        prNumber: 42,
        headSha: 'head-1',
        verdict: 'comment',
      },
      paths,
    );
    expect(reserved).toMatchObject({ status: 'submitting' });
    await expect(
      startPrReview({ ref: 'other/project#42', origin: 'panel' }, paths, {
        ...dependencies,
        invokeWorkflow: async () => ({ runId: 'submit-race-run-2' }),
      }),
    ).rejects.toThrow(/being submitted/);

    expect(
      releasePrReviewSubmission(
        { reviewId: reserved?.id ?? '', headSha: 'head-1' },
        paths,
      ),
    ).toMatchObject({ status: 'ready', verdict: null });
    expect(
      reservePrReviewSubmission(
        {
          repoFullName: 'other/project',
          prNumber: 42,
          headSha: 'head-1',
          verdict: 'comment',
        },
        paths,
      ),
    ).toMatchObject({ status: 'submitting' });

    expect(
      submitPrReview(
        {
          reviewId: reserved?.id ?? '',
          verdict: 'comment',
          githubReviewUrl:
            'https://github.com/other/project/pull/42#pullrequestreview-1',
        },
        paths,
      ),
    ).toMatchObject({ status: 'submitted', verdict: 'comment' });
  });

  it('reconciles interrupted submissions from GitHub or releases a stale reservation', async () => {
    const paths = await tempPaths();
    const dependencies = {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => detail('head-1'),
      invokeWorkflow: async () => ({ runId: 'reconcile-run-1' }),
    };
    const started = await startPrReview(
      { ref: 'other/project#42', origin: 'api' },
      paths,
      dependencies,
    );
    completePrReview(
      {
        reviewId: started.reviewId,
        runId: started.runId,
        headSha: 'head-1',
        reportIds: ['overview'],
        reviewUrl: started.review.reviewUrl,
        findingCount: 1,
        seededCount: 1,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );
    const reserved = reservePrReviewSubmission(
      {
        repoFullName: 'other/project',
        prNumber: 42,
        headSha: 'head-1',
        verdict: 'approve',
      },
      paths,
    );
    expect(reserved).toMatchObject({
      status: 'submitting',
      verdict: 'approve',
    });

    const recovered = await reconcilePrReviewSubmission(
      { reviewId: started.reviewId },
      paths,
      {
        token: 'token',
        fetchLogin: async () => 'reviewer',
        fetchReviews: async () => [
          {
            id: 7,
            nodeId: 'review-node',
            state: 'APPROVED',
            authorLogin: 'Reviewer',
            submittedAt: reserved?.updatedAt ?? null,
            commitId: 'head-1',
            url: 'https://github.com/other/project/pull/42#pullrequestreview-7',
          },
        ],
      },
    );
    expect(recovered).toMatchObject({
      outcome: 'submitted',
      githubReviewId: '7',
      review: {
        status: 'submitted',
        verdict: 'approve',
        githubReviewUrl:
          'https://github.com/other/project/pull/42#pullrequestreview-7',
      },
    });
    await expect(
      reconcilePrReviewSubmission({ reviewId: started.reviewId }, paths, {
        fetchLogin: async () => {
          throw new Error(
            'Already-submitted reconciliation must not query GitHub.',
          );
        },
        fetchReviews: async () => {
          throw new Error(
            'Already-submitted reconciliation must not query GitHub.',
          );
        },
      }),
    ).resolves.toMatchObject({
      outcome: 'submitted-existing',
      githubReviewId: '7',
      review: {
        status: 'submitted',
        verdict: 'approve',
      },
    });

    const restarted = await startPrReview(
      { ref: 'other/project#42', origin: 'panel' },
      paths,
      {
        ...dependencies,
        invokeWorkflow: async () => ({ runId: 'reconcile-run-2' }),
      },
    );
    completePrReview(
      {
        reviewId: restarted.reviewId,
        runId: restarted.runId,
        headSha: 'head-1',
        reportIds: ['overview-2'],
        reviewUrl: restarted.review.reviewUrl,
        findingCount: 0,
        seededCount: 0,
        reportOnlyCount: 0,
        reportOnlyFindings: [],
      },
      paths,
    );
    const secondReservation = reservePrReviewSubmission(
      {
        repoFullName: 'other/project',
        prNumber: 42,
        headSha: 'head-1',
        verdict: 'comment',
      },
      paths,
    );
    const endSubmissionAttempt = beginPrReviewSubmissionAttempt(
      secondReservation?.id ?? '',
    );
    const active = await reconcilePrReviewSubmission(
      { reviewId: started.reviewId },
      paths,
      {
        token: 'token',
        now: () => Date.parse(secondReservation?.updatedAt ?? '') + 30_001,
        fetchLogin: async () => {
          throw new Error('Active attempts must not query GitHub.');
        },
        fetchReviews: async () => {
          throw new Error('Active attempts must not query GitHub.');
        },
      },
    );
    expect(active).toMatchObject({
      outcome: 'pending',
      review: { status: 'submitting', verdict: 'comment' },
    });
    endSubmissionAttempt();
    let signalFirstLookup!: () => void;
    const firstLookupStarted = new Promise<void>((resolve) => {
      signalFirstLookup = resolve;
    });
    let allowFirstLookup!: () => void;
    const firstLookupGate = new Promise<void>((resolve) => {
      allowFirstLookup = resolve;
    });
    const firstRecovery = reconcilePrReviewSubmission(
      { reviewId: started.reviewId },
      paths,
      {
        token: 'token',
        now: () => Date.parse(secondReservation?.updatedAt ?? '') + 30_001,
        fetchLogin: async () => {
          signalFirstLookup();
          await firstLookupGate;
          return 'reviewer';
        },
        fetchReviews: async () => [],
      },
    );
    await firstLookupStarted;
    const concurrentRecovery = await reconcilePrReviewSubmission(
      { reviewId: started.reviewId },
      paths,
      {
        token: 'token',
        fetchLogin: async () => {
          throw new Error('Concurrent recovery must not query GitHub.');
        },
        fetchReviews: async () => {
          throw new Error('Concurrent recovery must not query GitHub.');
        },
      },
    );
    expect(concurrentRecovery).toMatchObject({
      outcome: 'pending',
      review: { status: 'submitting', verdict: 'comment' },
    });
    allowFirstLookup();
    const released = await firstRecovery;
    expect(released).toMatchObject({
      outcome: 'ready',
      review: { status: 'ready', verdict: null },
    });
  });

  it('awaits handled verdict backfill when reconciliation recovers GitHub acceptance', async () => {
    const paths = await tempPaths();
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recordHandled = vi.fn(async () => {
      recording.resolve();
      await release.promise;
      return { recorded: true };
    });
    const routes = createReviewRoutes(paths, {
      reconcilePrReviewSubmission: vi.fn(async () => ({
        outcome: 'submitted' as const,
        githubReviewId: '9001',
        review: {
          id: 'review-local-1',
          repoFullName: 'other/project',
          prNumber: 42,
          headSha: 'head-1',
          verdict: 'request-changes' as const,
          githubReviewUrl:
            'https://github.com/other/project/pull/42#pullrequestreview-9001',
          status: 'submitted' as const,
          runId: 'review-run-1',
        },
      })) as never,
      recordHumanReviewSubmittedApiEvidence: recordHandled as never,
    });

    let responseSettled = false;
    const responsePromise = Promise.resolve(
      routes.request('/reviews/review-local-1/reconcile', { method: 'POST' }),
    ).then((response) => {
      responseSettled = true;
      return response;
    });
    await recording.promise;
    await Promise.resolve();
    expect(responseSettled).toBe(false);
    release.resolve();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(recordHandled).toHaveBeenCalledWith(paths, {
      origin: 'reconciliation',
      repoFullName: 'other/project',
      prNumber: 42,
      headSha: 'head-1',
      reviewId: '9001',
      reviewUrl:
        'https://github.com/other/project/pull/42#pullrequestreview-9001',
      verdict: 'request-changes',
    });
  });

  it('backfills handled verdict evidence for an already-submitted review', async () => {
    const paths = await tempPaths();
    const recordHandled = vi.fn(async () => ({ recorded: true }));
    const routes = createReviewRoutes(paths, {
      reconcilePrReviewSubmission: vi.fn(async () => ({
        outcome: 'submitted-existing' as const,
        githubReviewId: '9001',
        review: {
          id: 'review-local-1',
          repoFullName: 'other/project',
          prNumber: 42,
          headSha: 'head-1',
          verdict: 'approve' as const,
          githubReviewUrl:
            'https://github.com/other/project/pull/42#pullrequestreview-9001',
          status: 'submitted' as const,
          runId: 'review-run-1',
        },
      })) as never,
      recordHumanReviewSubmittedApiEvidence: recordHandled as never,
    });

    const response = await routes.request('/reviews/review-local-1/reconcile', {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changed: false,
      message:
        'Confirmed the submitted review and reconciled its learning evidence.',
    });
    expect(recordHandled).toHaveBeenCalledWith(paths, {
      origin: 'reconciliation',
      repoFullName: 'other/project',
      prNumber: 42,
      headSha: 'head-1',
      reviewId: '9001',
      reviewUrl:
        'https://github.com/other/project/pull/42#pullrequestreview-9001',
      verdict: 'approve',
    });
  });

  it('settles and records a GitHub-accepted review when delivery verification is ambiguous', async () => {
    const paths = await tempPaths();
    const started = await startReadyReview(paths, 'review-run-ambiguous');
    const recording = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recordHandled = vi.fn(async () => {
      recording.resolve();
      await release.promise;
      return { recorded: true };
    });
    const routes = createGitHubRoutes(paths, {
      putGitHubPrReviewDraft: vi.fn(async () => ({
        ok: true,
        action: 'github_pr_review_draft_put',
        changed: true,
        message: 'Saved review draft.',
        data: {
          draft: {
            id: 'draft-ambiguous',
            headSha: 'head-1',
            verdict: 'approve',
          },
        },
      })) as never,
      postGitHubPrReview: vi.fn(async () => ({
        ok: false,
        action: 'github_pr_review_post',
        changed: true,
        message:
          'Submitted PR review but could not uniquely verify its durable delivery identity.',
        data: {
          target: { repoFullName: 'other/project', number: 42 },
          draft: {
            id: 'draft-ambiguous',
            headSha: 'head-1',
            verdict: 'approve',
          },
          review: {
            id: 9001,
            url: 'https://github.com/other/project/pull/42#pullrequestreview-9001',
          },
          deliveryIdentityVerified: false,
        },
        requires: ['deliveryIdentity'],
      })) as never,
      recordHumanReviewSubmittedApiEvidence: recordHandled as never,
    });

    const responsePromise = routes.request('/prs/other/project/42/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headSha: 'head-1', verdict: 'approve' }),
    });
    await recording.promise;
    expect(readPrReviewForTarget('other/project', 42, paths)?.status).toBe(
      'submitting',
    );
    release.resolve();
    const response = await responsePromise;

    expect(response.status).toBe(409);
    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      id: started.reviewId,
      status: 'submitted',
      verdict: 'approve',
      githubReviewUrl:
        'https://github.com/other/project/pull/42#pullrequestreview-9001',
    });
    expect(recordHandled).toHaveBeenCalledWith(paths, {
      origin: 'submission',
      repoFullName: 'other/project',
      prNumber: 42,
      headSha: 'head-1',
      reviewId: '9001',
      reviewUrl:
        'https://github.com/other/project/pull/42#pullrequestreview-9001',
      verdict: 'approve',
    });
  });
});

async function tempPaths() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-pr-reviews-'));
  roots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

async function startReadyReview(
  paths: Awaited<ReturnType<typeof tempPaths>>,
  runId: string,
) {
  const started = await startPrReview(
    { ref: 'other/project#42', origin: 'panel' },
    paths,
    {
      resolveTarget: async () => ({
        repoFullName: 'other/project',
        owner: 'other',
        repo: 'project',
        number: 42,
      }),
      fetchDetail: async () => detail('head-1'),
      invokeWorkflow: async () => ({ runId }),
    },
  );
  completePrReview(
    {
      reviewId: started.reviewId,
      runId: started.runId,
      headSha: 'head-1',
      reportIds: ['overview', 'issues'],
      reviewUrl: started.review.reviewUrl,
      findingCount: 0,
      seededCount: 0,
      reportOnlyCount: 0,
      reportOnlyFindings: [],
    },
    paths,
  );
  return started;
}

function readAttemptId(
  reviewId: string,
  paths: Awaited<ReturnType<typeof tempPaths>>,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT attempt_id FROM pr_reviews WHERE id = ?;')
      .get(reviewId) as { attempt_id?: unknown } | undefined;
    if (typeof row?.attempt_id !== 'string') {
      throw new Error('Review attempt id was not persisted.');
    }
    return row.attempt_id;
  } finally {
    database.close();
  }
}

function detail(headSha: string) {
  return {
    number: 42,
    title: 'Review this change',
    body: null,
    repo: 'other/project',
    url: 'https://github.com/other/project/pull/42',
    state: 'open',
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

function setSubmittedAt(
  databasePath: string,
  reviewId: string,
  now: number,
  ageDays: number,
) {
  const database = openDb(databasePath);
  try {
    database
      .prepare('UPDATE pr_reviews SET submitted_at = ? WHERE id = ?;')
      .run(
        new Date(now - ageDays * 24 * 60 * 60 * 1_000).toISOString(),
        reviewId,
      );
  } finally {
    database.close();
  }
}
