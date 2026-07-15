import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completePrReview,
  failPrReview,
  readPrReviewForTarget,
  reconcilePrReviewSubmission,
  releasePrReviewSubmission,
  reservePrReviewSubmission,
  startPrReview,
  submitPrReview,
  subscribePrReviewEvents,
  type PrReviewEvent,
} from './modules/pr-reviews';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import {
  linkPrReviewRunObservation,
  settlePrReviewObservation,
} from './server/learning-hooks';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('durable PR reviews', () => {
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

  it('links run_start before admission returns so early framework failures settle', async () => {
    const paths = await tempPaths();
    let releaseAdmission!: (value: { runId: string }) => void;
    let invoked!: (input: { reviewId: string; attemptId: string }) => void;
    const admission = new Promise<{ runId: string }>((resolve) => {
      releaseAdmission = resolve;
    });
    const invocation = new Promise<{ reviewId: string; attemptId: string }>(
      (resolve) => {
        invoked = resolve;
      },
    );
    const start = startPrReview(
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
        invokeWorkflow: async (input) => {
          invoked(input);
          return admission;
        },
      },
    );
    const input = await invocation;
    linkPrReviewRunObservation(
      {
        v: 3,
        type: 'run_start',
        eventIndex: 1,
        timestamp: '2026-07-14T20:29:59.000Z',
        runId: 'early-failed-run',
        workflowName: 'review-pr-for-human',
        startedAt: '2026-07-14T20:29:59.000Z',
        input,
      },
      paths,
    );
    settlePrReviewObservation(
      {
        v: 3,
        type: 'run_end',
        eventIndex: 2,
        timestamp: '2026-07-14T20:30:00.000Z',
        runId: 'early-failed-run',
        durationMs: 10,
        isError: true,
      },
      paths,
    );
    releaseAdmission({ runId: 'early-failed-run' });

    await expect(start).resolves.toMatchObject({
      review: { status: 'failed', runId: 'early-failed-run' },
    });
  });

  it('settles an owning review as failed when its Flue run ends in error', async () => {
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
        invokeWorkflow: async () => ({ runId: 'failed-flue-run' }),
      },
    );

    failPrReview(
      {
        runId: started.runId,
        message: 'Concrete action failure.',
      },
      paths,
    );
    settlePrReviewObservation(
      {
        v: 3,
        type: 'run_end',
        eventIndex: 2,
        timestamp: '2026-07-14T20:30:00.000Z',
        runId: started.runId,
        workflow: 'review-pr-for-human',
        durationMs: 10,
        isError: true,
      } as never,
      paths,
    );

    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      status: 'failed',
      runId: started.runId,
      failureMessage: 'Concrete action failure.',
    });
  });

  it('lets a framework output failure invalidate a ready action result', async () => {
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
        invokeWorkflow: async () => ({ runId: 'output-failed-run' }),
      },
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

    settlePrReviewObservation(
      {
        v: 3,
        type: 'run_end',
        eventIndex: 3,
        timestamp: '2026-07-14T20:30:01.000Z',
        runId: started.runId,
        durationMs: 11,
        isError: true,
      },
      paths,
    );

    expect(readPrReviewForTarget('other/project', 42, paths)).toMatchObject({
      status: 'failed',
      failureMessage: expect.stringContaining('Flue review workflow failed'),
    });
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
    ).toMatchObject({ status: 'ready' });
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
      review: {
        status: 'submitted',
        verdict: 'approve',
        githubReviewUrl:
          'https://github.com/other/project/pull/42#pullrequestreview-7',
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
    const released = await reconcilePrReviewSubmission(
      { reviewId: started.reviewId },
      paths,
      {
        token: 'token',
        now: () => Date.parse(secondReservation?.updatedAt ?? '') + 30_001,
        fetchLogin: async () => 'reviewer',
        fetchReviews: async () => [],
      },
    );
    expect(released).toMatchObject({
      outcome: 'ready',
      review: { status: 'ready', verdict: 'comment' },
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
