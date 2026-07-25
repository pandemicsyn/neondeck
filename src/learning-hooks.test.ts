import type { FlueObservation, FlueObservationSubscriber } from '@flue/runtime';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addWorkflowSummary, listWorkflowSummaries } from './modules/app-state';
import {
  extractHandledPrEvent,
  listHandledPrEventsForReview,
} from './modules/learning/reviews/pr-context';
import { recordHumanReviewSubmittedEvidence } from './modules/learning';
import {
  activateScheduledTaskWorkflowRun,
  attachScheduledTaskWorkflowRunId,
  claimDueScheduledTasks,
  readLatestScheduledTaskRun,
  upsertScheduledTask,
} from './modules/scheduled-tasks';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import {
  attachCommandRunSummaryRunId,
  installFlueObservationHandlers,
  resetFlueObservationHandlersForTests,
} from './server/learning-hooks';

const tempRoots: string[] = [];

afterEach(async () => {
  resetFlueObservationHandlersForTests();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Flue learning hooks', () => {
  it('installs one observation subscriber per runtime home', () => {
    const subscribers: unknown[] = [];
    const unsubscribers = [vi.fn<() => void>(), vi.fn<() => void>()];
    const observe = vi.fn<
      (subscriber: FlueObservationSubscriber) => () => void
    >((subscriber: FlueObservationSubscriber): (() => void) => {
      subscribers.push(subscriber);
      return unsubscribers[subscribers.length - 1] ?? vi.fn<() => void>();
    });

    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-a'), {
      observe,
    });
    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-a'), {
      observe,
    });
    installFlueObservationHandlers(runtimePaths('/tmp/neondeck-b'), {
      observe,
    });

    expect(observe).toHaveBeenCalledTimes(2);
    expect(subscribers).toHaveLength(2);

    resetFlueObservationHandlersForTests();

    expect(unsubscribers[0]).toHaveBeenCalledTimes(1);
    expect(unsubscribers[1]).toHaveBeenCalledTimes(1);
  });

  it('preserves the admitted review workflow run id for review-pr command summaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const summary = await addWorkflowSummary(
      {
        workflow: 'command:review-pr',
        runId: 'review-pr-for-human-run',
        status: 'completed',
        summary: { message: 'Queued review workflow.' },
      },
      paths,
    );

    await attachCommandRunSummaryRunId(
      commandRunEndObservation({
        workflowSummary: {
          id: summary.id,
          runId: 'review-pr-for-human-run',
        },
        data: { runId: 'review-pr-for-human-run' },
      }),
      paths,
    );

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        id: summary.id,
        workflow: 'command:review-pr',
        runId: 'review-pr-for-human-run',
      }),
    ]);
  });

  it('uses command result run id when the summary row has not been linked yet', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const summary = await addWorkflowSummary(
      {
        workflow: 'command:review-pr',
        status: 'completed',
        summary: { message: 'Queued review workflow.' },
      },
      paths,
    );

    await attachCommandRunSummaryRunId(
      commandRunEndObservation({
        workflowSummary: { id: summary.id },
        data: { runId: 'review-pr-for-human-run' },
      }),
      paths,
    );

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        id: summary.id,
        workflow: 'command:review-pr',
        runId: 'review-pr-for-human-run',
      }),
    ]);
  });

  it('uses the actual Flue run id for ci_fix_run summaries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const summary = await addWorkflowSummary(
      {
        workflow: 'ci_fix_run',
        runId: 'ci-fix-synthetic-kilo-task',
        status: 'completed',
        summary: {
          outcome: 'no-op',
          kiloTaskId: 'ci-fix-synthetic-kilo-task',
        },
      },
      paths,
    );

    await attachCommandRunSummaryRunId(
      ciFixRunEndObservation({
        workflowSummary: {
          id: summary.id,
          workflow: 'ci_fix_run',
          runId: 'ci-fix-synthetic-kilo-task',
        },
      }),
      paths,
    );

    await expect(listWorkflowSummaries(paths)).resolves.toEqual([
      expect.objectContaining({
        id: summary.id,
        workflow: 'ci_fix_run',
        runId: 'actual-fix-pr-ci-run',
      }),
    ]);
  });

  it('extracts handled PR learning events from ci_fix_run workflow results', () => {
    expect(
      extractHandledPrEvent({
        workflow: 'fix-pr-ci',
        runId: 'actual-fix-pr-ci-run',
        result: {
          ok: true,
          action: 'ci_fix_run',
          changed: true,
          message: 'Queued CI fix for pandemicsyn/neondeck#88.',
          data: {
            workflow: 'fix-pr-ci',
            outcome: 'kilo-started',
            dossier: {
              repo: 'pandemicsyn/neondeck',
              prNumber: 88,
              headSha: 'abc123',
              failedCheckCount: 1,
            },
            kiloTaskId: 'ci-fix-task-1',
            worktreeId: 'worktree-1',
          },
        },
      }),
    ).toMatchObject({
      eventType: 'ci-failure-workflow-completed',
      source: 'fix-pr-ci',
      sourceId:
        'pandemicsyn/neondeck#88:ci-failure-workflow-completed:ci-fix-task-1',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 88,
      data: expect.objectContaining({
        action: 'ci_fix_run',
        workflow: 'fix-pr-ci',
        taskId: 'ci-fix-task-1',
        worktreeId: 'worktree-1',
      }),
    });
  });

  it('extracts stable handled evidence from completed human-review preparation', () => {
    expect(
      extractHandledPrEvent({
        workflow: 'review-pr-for-human',
        runId: 'review-run-123',
        result: {
          ok: true,
          action: 'pr_review_assist',
          changed: true,
          message:
            'Prepared review assist artifacts for pandemicsyn/neondeck#123.',
          data: {
            workflow: 'review-pr-for-human',
            target: {
              repoFullName: 'pandemicsyn/neondeck',
              owner: 'pandemicsyn',
              repo: 'neondeck',
              number: 123,
            },
            headSha: 'head-123',
            findingCount: 2,
            seededCount: 1,
            reportOnlyCount: 1,
          },
        },
      }),
    ).toMatchObject({
      eventType: 'pr-review-assist-completed',
      source: 'review-pr-for-human',
      sourceId: 'pandemicsyn/neondeck#123:pr-review-assist-completed:head-123',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 123,
      data: expect.objectContaining({
        action: 'pr_review_assist',
        workflow: 'review-pr-for-human',
        headSha: 'head-123',
      }),
    });
  });

  it('records completed review-pr-for-human observations idempotently', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: '/src/neondeck',
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );
    let subscriber: FlueObservationSubscriber | undefined;
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
    });
    const result = {
      ok: true,
      action: 'pr_review_assist',
      changed: true,
      message: 'Prepared review assist artifacts for pandemicsyn/neondeck#123.',
      data: {
        workflow: 'review-pr-for-human',
        target: {
          repoFullName: 'pandemicsyn/neondeck',
          owner: 'pandemicsyn',
          repo: 'neondeck',
          number: 123,
        },
        headSha: 'head-123',
        findingCount: 2,
        seededCount: 1,
        reportOnlyCount: 1,
      },
    };
    const observation = {
      v: 3,
      type: 'run_end',
      eventIndex: 2,
      timestamp: '2026-07-25T00:00:00.000Z',
      runId: 'review-run-123',
      durationMs: 1_000,
      isError: false,
      result,
    } as unknown as FlueObservation;

    subscriber?.(observation, {} as never);
    subscriber?.(
      { ...observation, runId: 'duplicate-observation-run' },
      {} as never,
    );

    await vi.waitFor(() => {
      const events = listHandledPrEventsForReview(
        { limit: 10, sinceLastReview: false },
        paths,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.repoId).toBe('neondeck');
    });
  });

  it('extracts the submitted human verdict with GitHub review identity', () => {
    expect(
      extractHandledPrEvent({
        workflow: 'api:github_pr_review_post',
        result: {
          ok: true,
          action: 'github_pr_review_post',
          changed: true,
          message: 'Submitted PR review for pandemicsyn/neondeck#123.',
          data: {
            target: {
              repoFullName: 'pandemicsyn/neondeck',
              owner: 'pandemicsyn',
              repo: 'neondeck',
              number: 123,
            },
            draft: {
              headSha: 'head-123',
              verdict: 'request-changes',
            },
            review: {
              id: 9001,
              url: 'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
            },
          },
        },
      }),
    ).toMatchObject({
      eventType: 'human-review-submitted',
      source: 'api:github_pr_review_post',
      sourceId: 'pandemicsyn/neondeck#123:human-review-submitted:9001',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 123,
      data: expect.objectContaining({
        action: 'github_pr_review_post',
        headSha: 'head-123',
        reviewId: '9001',
        verdict: 'request-changes',
      }),
    });
  });

  it('deduplicates submitted-review evidence across submission and reconciliation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    const evidence = {
      prNumber: 123,
      headSha: 'head-123',
      reviewId: '9001',
      reviewUrl:
        'https://github.com/pandemicsyn/neondeck/pull/123#pullrequestreview-9001',
      verdict: 'request-changes' as const,
    };

    await recordHumanReviewSubmittedEvidence(
      {
        ...evidence,
        origin: 'submission',
        repoFullName: 'PandemicSyn/NeonDeck',
      },
      paths,
    );
    await recordHumanReviewSubmittedEvidence(
      {
        ...evidence,
        origin: 'reconciliation',
        repoFullName: 'pandemicsyn/neondeck',
      },
      paths,
    );

    const events = listHandledPrEventsForReview(
      { limit: 10, sinceLastReview: false },
      paths,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'api:github_pr_review_post',
      sourceId: 'pandemicsyn/neondeck#123:human-review-submitted:9001',
      repoId: null,
      prKey: 'pandemicsyn/neondeck#123',
      data: expect.objectContaining({
        eventType: 'human-review-submitted',
        data: expect.objectContaining({
          headSha: 'head-123',
          reviewId: '9001',
          verdict: 'request-changes',
          origin: 'submission',
        }),
      }),
    });
  });

  it('settles a scheduled workflow even when observation persistence fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-learning-hooks-'));
    tempRoots.push(home);
    const paths = runtimePaths(home);
    await upsertScheduledTask(
      {
        id: 'briefing:observation-failure',
        spec: { kind: 'run-briefing', briefingId: 'daily' },
        trigger: { kind: 'interval', everySeconds: 300 },
        nextRunAt: '2026-07-10T00:00:00.000Z',
      },
      paths,
    );
    const [claim] = await claimDueScheduledTasks(
      paths,
      new Date('2026-07-10T00:00:00.000Z'),
    );
    if (!claim) throw new Error('Expected the due task to be claimed.');
    await activateScheduledTaskWorkflowRun(
      {
        taskId: claim.task.id,
        runId: claim.run.id,
        claimId: claim.task.claimId ?? '',
      },
      paths,
    );
    await attachScheduledTaskWorkflowRunId(
      {
        runId: claim.run.id,
        workflowRunId: 'workflow:observation-failure',
      },
      paths,
    );

    let subscriber: FlueObservationSubscriber | undefined;
    installFlueObservationHandlers(paths, {
      observe(next) {
        subscriber = next;
        return vi.fn<() => void>();
      },
      recordFlueObservation: vi.fn<() => Promise<never>>(async () => {
        throw new Error('observation write failed');
      }),
    });

    subscriber?.(
      {
        v: 3,
        type: 'run_end',
        eventIndex: 2,
        timestamp: '2026-07-10T00:00:01.000Z',
        runId: 'workflow:observation-failure',
        workflow: 'briefing',
        durationMs: 1_000,
        isError: false,
        result: { ok: true },
      } as FlueObservation,
      {} as never,
    );

    await vi.waitFor(async () => {
      await expect(
        readLatestScheduledTaskRun(claim.task.id, paths),
      ).resolves.toMatchObject({ id: claim.run.id, status: 'completed' });
    });
  });
});

function commandRunEndObservation(result: unknown): FlueObservation {
  return {
    v: 3,
    type: 'run_end',
    eventIndex: 2,
    timestamp: '2026-07-05T20:30:00.000Z',
    runId: 'outer-command-run',
    durationMs: 1_000,
    isError: false,
    result,
  } as unknown as FlueObservation;
}

function ciFixRunEndObservation(result: unknown): FlueObservation {
  return {
    v: 3,
    type: 'run_end',
    eventIndex: 2,
    timestamp: '2026-07-05T20:30:00.000Z',
    runId: 'actual-fix-pr-ci-run',
    durationMs: 1_000,
    isError: false,
    result,
  } as unknown as FlueObservation;
}
