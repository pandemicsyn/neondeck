import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowAdmissionError } from '@flue/runtime';
import { addNotification, listNotifications } from '../modules/app-state';
import {
  readWorkflowObservability,
  recordFlueObservation,
} from '../modules/learning/observability';
import { runtimePaths } from '../runtime-home';
import {
  errorMessageWithCauses,
  isTransientRuntimeFailure,
  resolveTransientSchedulerWorkflowNotification,
  runObservedSchedulerTick,
  startSchedulerObservedLoop,
} from './scheduler-workflow';

describe('observed scheduler workflow', () => {
  it('expires a stale app projection before admitting a replacement tick', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduler-workflow-'));
    const paths = runtimePaths(home);
    try {
      await recordFlueObservation(
        {
          v: 3,
          type: 'run_start',
          eventIndex: 1,
          timestamp: '2026-07-10T00:00:00.000Z',
          runId: 'scheduler-run:stale',
          workflowName: 'scheduler-tick',
          input: { runtimeHome: paths.home },
        } as never,
        paths,
      );

      await expect(
        runObservedSchedulerTick(paths, {
          activeRunTtlMs: 1_000,
          now: () => new Date('2026-07-10T00:10:00.000Z'),
          listRuns: (async () => ({
            runs: [{ runId: 'scheduler-run:stale' }],
          })) as never,
          getRun: (async (runId: string) =>
            runId === 'scheduler-run:stale'
              ? {
                  runId,
                  workflowName: 'scheduler-tick',
                  status: 'active',
                  startedAt: '2026-07-10T00:00:00.000Z',
                  input: { runtimeHome: paths.home },
                }
              : {
                  runId,
                  workflowName: 'scheduler-tick',
                  status: 'completed',
                  startedAt: '2026-07-10T00:10:00.000Z',
                  completedAt: '2026-07-10T00:10:00.010Z',
                  input: { runtimeHome: paths.home },
                  result: {
                    ok: true,
                    action: 'scheduler_tick',
                    changed: false,
                    outcome: 'silent',
                    message: 'No scheduled tasks were due.',
                  },
                }) as never,
          invokeWorkflow: async () =>
            ({ runId: 'scheduler-run:replacement' }) as never,
        }),
      ).resolves.toMatchObject({
        ok: true,
        runId: 'scheduler-run:replacement',
      });

      await expect(readWorkflowObservability(paths)).resolves.toMatchObject({
        activeRuns: [],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('preserves nested workflow admission causes for diagnostics', () => {
    expect(
      errorMessageWithCauses(
        new Error('Workflow admission failed.', {
          cause: new Error('database is locked'),
        }),
      ),
    ).toBe('Workflow admission failed.: database is locked');
  });

  it('quietly falls back when the local runtime is reloading', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduler-workflow-'));
    const paths = runtimePaths(home);
    try {
      const runtimeUnavailable = Object.assign(
        new Error('The local runtime is temporarily unavailable.'),
        { type: 'runtime_unavailable' },
      );

      await expect(
        runObservedSchedulerTick(paths, {
          listRuns: (async () => ({ runs: [] })) as never,
          invokeWorkflow: async () => {
            throw new WorkflowAdmissionError({
              workflow: 'scheduler-tick',
              cause: runtimeUnavailable,
            });
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        changed: false,
        outcome: 'silent',
        extra: {
          workflowObservationFallback: true,
          workflowRuntimeUnavailable: true,
        },
      });
      await expect(listNotifications(paths)).resolves.toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recognizes a nested runtime-unavailable admission cause', () => {
    expect(
      isTransientRuntimeFailure(
        new WorkflowAdmissionError({
          workflow: 'scheduler-tick',
          cause: Object.assign(new Error('reloading'), {
            type: 'runtime_unavailable',
          }),
        }),
      ),
    ).toBe(true);
  });

  it('resolves the persisted transient scheduler alert on startup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-scheduler-workflow-'));
    const paths = runtimePaths(home);
    try {
      const notification = await addNotification(
        {
          level: 'attention',
          title: 'Scheduler workflow observation failed',
          message: 'The direct scheduler tick still ran.',
          source: 'scheduler',
          sourceId: 'scheduler-tick:workflow-observation-fallback',
          data: {
            error:
              'Workflow admission failed.: The local runtime is temporarily unavailable.',
          },
        },
        paths,
      );

      await expect(
        resolveTransientSchedulerWorkflowNotification(paths),
      ).resolves.toBe(true);
      await expect(listNotifications(paths)).resolves.toEqual([]);
      await expect(
        listNotifications(paths, { includeResolved: true }),
      ).resolves.toMatchObject([
        { id: notification.id, resolvedAt: expect.any(String) },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('replaces the previous scheduler loop for the same runtime home', async () => {
    vi.useFakeTimers();
    const paths = runtimePaths('/tmp/neondeck-scheduler-loop-test');
    const previousTick = vi.fn<
      (paths: ReturnType<typeof runtimePaths>) => Promise<void>
    >(async () => undefined);
    const replacementTick = vi.fn<
      (paths: ReturnType<typeof runtimePaths>) => Promise<void>
    >(async () => undefined);
    const refreshGitHubQueue = vi.fn<
      (paths: ReturnType<typeof runtimePaths>) => Promise<void>
    >(async () => undefined);
    const refreshPrReviews = vi.fn<
      (paths: ReturnType<typeof runtimePaths>) => Promise<void>
    >(async () => undefined);

    startSchedulerObservedLoop(
      paths,
      1_000,
      previousTick,
      refreshGitHubQueue,
      refreshPrReviews,
    );
    const replacement = startSchedulerObservedLoop(
      paths,
      1_000,
      replacementTick,
      refreshGitHubQueue,
      refreshPrReviews,
    );
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(previousTick).not.toHaveBeenCalled();
      expect(replacementTick).toHaveBeenCalledTimes(1);
      expect(refreshGitHubQueue).toHaveBeenCalledTimes(1);
      expect(refreshPrReviews).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(replacement);
      vi.useRealTimers();
    }
  });
});
