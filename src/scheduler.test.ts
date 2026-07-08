import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { listJobs, listNotifications, updateJobRun } from './modules/app-state';
import {
  createScheduleBlueprint,
  runSchedulerTick,
  startSchedulerLoop,
  syncScheduledJobs,
} from './modules/scheduler';
import {
  ensureRuntimeHome,
  type RuntimePaths,
  runtimePaths,
} from './runtime-home';
import { addPrWatch, refreshPrWatch } from './modules/watches';
import {
  runObservedSchedulerTick,
  startSchedulerObservedLoop,
} from './server/scheduler-workflow';
import type { PrEventActionResult } from './modules/pr-events';
import type { AutopilotConcurrencyDecision } from './modules/autopilot-policy';

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

type SchedulerPrDetail = {
  number: number;
  title: string;
  repo: string;
  url: string;
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  baseRef: string;
  updatedAt: string;
};
type TestSchedulerLease = {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
};
type TestSchedulerWorkflowLease = TestSchedulerLease & {
  runtimeHome: string;
  runId: string | null;
};

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('scheduler', () => {
  it('syncs configured schedules into durable jobs', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'morning',
            type: 'morning-briefing',
            enabled: true,
            preset: 'morning-briefing',
            config: { intervalSeconds: 600 },
          },
        ],
      })}\n`,
    );

    await expect(syncScheduledJobs(paths)).resolves.toMatchObject([
      {
        id: 'schedule:morning',
        type: 'morning-briefing',
        intervalSeconds: 600,
      },
    ]);
  });

  it('disables durable jobs for schedules that no longer exist', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'morning',
            type: 'morning-briefing',
            enabled: true,
            preset: 'morning-briefing',
            config: { intervalSeconds: 600 },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);

    await writeFile(paths.schedules, '{"schedules":[]}\n');
    await syncScheduledJobs(paths);

    await expect(listJobs(paths)).resolves.toMatchObject([
      {
        id: 'schedule:morning',
        enabled: false,
      },
    ]);
  });

  it('runs due jobs and creates notifications', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'digest',
            type: 'review-queue-digest',
            enabled: true,
            preset: 'review-queue-digest',
            config: { intervalSeconds: 60 },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);

    await expect(
      runSchedulerTick(paths, new Date(), {
        invokeWorkflow: async () => ({ runId: 'run_review_queue' }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      notifications: [{ title: 'Review queue digest due' }],
    });
    await expect(listNotifications(paths)).resolves.toMatchObject([
      { title: 'Review queue digest due', level: 'info' },
    ]);
  });

  it('skips concurrent ticks instead of admitting the same workflow twice', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const firstWorkflow = deferred<void>();
    let admissions = 0;

    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'digest',
            type: 'review-queue-digest',
            enabled: true,
            preset: 'review-queue-digest',
            config: { intervalSeconds: 60 },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);
    const now = new Date(Date.now() + 1_000);

    const firstTick = runSchedulerTick(paths, now, {
      tickLeaseTtlMs: 50,
      invokeWorkflow: async () => {
        admissions += 1;
        await firstWorkflow.promise;
        return { runId: 'run_first' };
      },
    });
    await waitUntil(() => admissions === 1);
    await delay(120);

    await expect(
      runSchedulerTick(paths, new Date(), {
        tickLeaseTtlMs: 50,
        invokeWorkflow: async () => {
          throw new Error('second tick should not execute jobs');
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
      message: 'Scheduler tick skipped because another tick is active.',
      extra: { lease: 'active' },
    });

    firstWorkflow.resolve();
    await expect(firstTick).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [{ title: 'Review queue digest due' }],
    });
    expect(admissions).toBe(1);
    expect(readSchedulerLease(paths)).toBeUndefined();
  });

  it('respects an active durable tick lease', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const now = new Date();

    await syncScheduledJobs(paths);
    writeSchedulerLease(paths, {
      owner: 'other-process',
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    await expect(
      runSchedulerTick(paths, now, {
        invokeWorkflow: async () => {
          throw new Error('active lease should skip execution');
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
      message: 'Scheduler tick skipped because another tick is active.',
      extra: { lease: 'active' },
    });
    expect(readSchedulerLease(paths)).toMatchObject({ owner: 'other-process' });
  });

  it('uses wall clock time for tick lease expiry instead of logical schedule time', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const leaseTime = new Date();

    await syncScheduledJobs(paths);
    writeSchedulerLease(paths, {
      owner: 'wall-clock-active',
      acquiredAt: leaseTime.toISOString(),
      expiresAt: new Date(leaseTime.getTime() + 60_000).toISOString(),
    });

    await expect(
      runSchedulerTick(paths, new Date(leaseTime.getTime() + 3_600_000), {
        invokeWorkflow: async () => {
          throw new Error('future logical now should not steal lease');
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
      extra: { lease: 'active' },
    });
    expect(readSchedulerLease(paths)).toMatchObject({
      owner: 'wall-clock-active',
    });
  });

  it('replaces stale durable tick leases', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'digest',
            type: 'review-queue-digest',
            enabled: true,
            preset: 'review-queue-digest',
            config: { intervalSeconds: 60 },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);
    const now = new Date(Date.now() + 1_000);
    writeSchedulerLease(paths, {
      owner: 'stale-process',
      acquiredAt: new Date(now.getTime() - 120_000).toISOString(),
      expiresAt: new Date(now.getTime() - 60_000).toISOString(),
    });

    await expect(
      runSchedulerTick(paths, now, {
        invokeWorkflow: async () => ({ runId: 'run_after_stale' }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [{ title: 'Review queue digest due' }],
    });
    expect(readSchedulerLease(paths)).toBeUndefined();
  });

  it('stops remaining jobs when tick lease ownership is lost', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    let admissions = 0;

    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'digest-one',
            type: 'review-queue-digest',
            enabled: true,
            preset: 'review-queue-digest',
            config: { intervalSeconds: 60 },
          },
          {
            id: 'digest-two',
            type: 'review-queue-digest',
            enabled: true,
            preset: 'review-queue-digest',
            config: { intervalSeconds: 60 },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);
    const now = new Date(Date.now() + 1_000);

    await expect(
      runSchedulerTick(paths, now, {
        invokeWorkflow: async () => {
          admissions += 1;
          writeSchedulerLease(paths, {
            owner: 'stolen-by-another-tick',
            acquiredAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
          return { runId: `run_${admissions}` };
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      message:
        'Scheduler tick stopped because it no longer owns the active lease.',
    });

    expect(admissions).toBe(1);
    expect(readSchedulerLease(paths)).toMatchObject({
      owner: 'stolen-by-another-tick',
    });
  });

  it('records failed workflow admissions and continues the tick', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'digest',
            type: 'review-queue-digest',
            enabled: true,
            preset: 'review-queue-digest',
            config: { intervalSeconds: 60 },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);
    const now = new Date(Date.now() + 1_000);
    await updateJobRun(
      'schedule:digest',
      {
        outcome: 'silent',
        message: 'Previous digest run.',
        result: { watermark: '2026-06-01T00:00:00Z' },
        nextRunAt: now.toISOString(),
      },
      paths,
    );

    await expect(
      runSchedulerTick(paths, now, {
        invokeWorkflow: async () => {
          throw new Error('admission failed');
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [{ title: 'Scheduler job failed' }],
    });

    await expect(listJobs(paths)).resolves.toMatchObject([
      {
        id: 'schedule:digest',
        lastOutcome: 'failed',
        lastMessage: 'Scheduler job failed: admission failed.',
        lastResult: { watermark: '2026-06-01T00:00:00Z' },
        nextRunAt: now.toISOString(),
      },
    ]);
    expect(readSchedulerLease(paths)).toBeUndefined();
  });

  it('does not start overlapping interval loop ticks in one process', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const activeTick = deferred<void>();
    let ticks = 0;

    const timer = startSchedulerLoop(paths, 5, async () => {
      ticks += 1;
      await activeTick.promise;
      return {
        ok: true,
        action: 'scheduler_tick',
        changed: false,
        outcome: 'silent',
        message: 'done',
      };
    });

    try {
      await waitUntil(() => ticks === 1);
      await delay(25);
      expect(ticks).toBe(1);
      activeTick.resolve();
    } finally {
      clearInterval(timer);
    }
  });

  it('does not start overlapping observed scheduler workflow ticks in one process', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const activeTick = deferred<void>();
    let ticks = 0;

    const timer = startSchedulerObservedLoop(paths, 5, async () => {
      ticks += 1;
      await activeTick.promise;
      return {
        ok: true,
        action: 'scheduler_tick',
        changed: false,
        outcome: 'silent',
        message: 'done',
      };
    });

    try {
      await waitUntil(() => ticks === 1);
      await delay(25);
      expect(ticks).toBe(1);
      activeTick.resolve();
    } finally {
      clearInterval(timer);
    }
  });

  it('deduplicates concurrent observed scheduler workflow admissions', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const completedRun = deferred<void>();
    let invokes = 0;
    const result = {
      ok: true,
      action: 'scheduler_tick',
      changed: false,
      outcome: 'silent',
      message: 'done',
    };
    const dependencies = {
      listRuns: async () => ({ runs: [] }),
      invokeWorkflow: async () => {
        invokes += 1;
        return { runId: 'run-scheduler-1' };
      },
      getRun: async () => {
        await completedRun.promise;
        return {
          runId: 'run-scheduler-1',
          workflowName: 'scheduler-tick',
          status: 'completed' as const,
          startedAt: '2026-07-06T00:00:00.000Z',
          result,
        };
      },
      sleep: async () => undefined,
    };

    const first = runObservedSchedulerTick(paths, dependencies);
    await waitUntil(() => invokes === 1);
    const second = runObservedSchedulerTick(paths, dependencies);
    await delay(25);
    expect(invokes).toBe(1);
    completedRun.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ runId: 'run-scheduler-1' }),
      expect.objectContaining({ runId: 'run-scheduler-1' }),
    ]);
    expect(invokes).toBe(1);
  });

  it('keeps observed scheduler workflow admission guards scoped by runtime home', async () => {
    const firstHome = await tempHome();
    const secondHome = await tempHome();
    const firstPaths = runtimePaths(firstHome);
    const secondPaths = runtimePaths(secondHome);
    const completedRun = deferred<void>();
    const invokedHomes: string[] = [];
    const dependencies = {
      listRuns: async () => ({ runs: [] }),
      invokeWorkflow: async (paths: RuntimePaths) => {
        invokedHomes.push(paths.home);
        return {
          runId: paths.home === firstHome ? 'run-first' : 'run-second',
        };
      },
      getRun: async (runId: string) => {
        await completedRun.promise;
        return {
          runId,
          workflowName: 'scheduler-tick',
          status: 'completed' as const,
          startedAt: '2026-07-06T00:00:00.000Z',
          result: {
            ok: true,
            action: 'scheduler_tick',
            changed: false,
            outcome: 'silent',
            message: `done ${runId}`,
          },
        };
      },
      sleep: async () => undefined,
    };

    const first = runObservedSchedulerTick(firstPaths, dependencies);
    const second = runObservedSchedulerTick(secondPaths, dependencies);
    await waitUntil(() => invokedHomes.length === 2);
    completedRun.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-first',
        message: 'done run-first',
      }),
      expect.objectContaining({
        runId: 'run-second',
        message: 'done run-second',
      }),
    ]);
    expect(invokedHomes).toHaveLength(2);
    expect(invokedHomes).toEqual(
      expect.arrayContaining([firstHome, secondHome]),
    );
  });

  it('waits for matching active observed scheduler workflow runs', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const completedRun = deferred<void>();
    let matchingReads = 0;
    let invoked = false;

    const result = runObservedSchedulerTick(paths, {
      listRuns: async () => ({
        runs: [
          {
            runId: 'run-other',
            workflowName: 'scheduler-tick',
            status: 'active' as const,
            startedAt: '2026-07-06T00:00:00.000Z',
          },
          {
            runId: 'run-matching',
            workflowName: 'scheduler-tick',
            status: 'active' as const,
            startedAt: '2026-07-06T00:00:01.000Z',
          },
        ],
      }),
      invokeWorkflow: async () => {
        invoked = true;
        throw new Error('should not admit another run');
      },
      getRun: async (runId: string) => {
        if (runId === 'run-other') {
          return {
            runId,
            workflowName: 'scheduler-tick',
            status: 'active' as const,
            startedAt: '2026-07-06T00:00:00.000Z',
            input: { runtimeHome: '/tmp/other-neondeck-home' },
          };
        }
        matchingReads += 1;
        if (matchingReads === 1) {
          return {
            runId,
            workflowName: 'scheduler-tick',
            status: 'active' as const,
            startedAt: '2026-07-06T00:00:01.000Z',
            input: { runtimeHome: paths.home },
          };
        }
        await completedRun.promise;
        return {
          runId,
          workflowName: 'scheduler-tick',
          status: 'completed' as const,
          startedAt: '2026-07-06T00:00:01.000Z',
          input: { runtimeHome: paths.home },
          result: {
            ok: true,
            action: 'scheduler_tick',
            changed: true,
            outcome: 'updated',
            message: 'active run completed',
          },
        };
      },
      now: () => new Date('2026-07-06T00:00:05.000Z'),
      sleep: async () => undefined,
    });

    await waitUntil(() => matchingReads === 2);
    expect(invoked).toBe(false);
    completedRun.resolve();
    await expect(result).resolves.toMatchObject({
      runId: 'run-matching',
      changed: true,
      outcome: 'updated',
      message: 'active run completed',
    });
    expect(invoked).toBe(false);
  });

  it('respects an active durable observed scheduler workflow admission lease', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    writeSchedulerWorkflowLease(paths, {
      owner: 'other-process',
      runtimeHome: paths.home,
      runId: null,
      acquiredAt: '2026-07-06T00:00:00.000Z',
      expiresAt: '2026-07-06T00:10:00.000Z',
    });
    let invoked = false;

    await expect(
      runObservedSchedulerTick(paths, {
        listRuns: async () => ({ runs: [] }),
        invokeWorkflow: async () => {
          invoked = true;
          throw new Error('active admission lease should skip execution');
        },
        now: () => new Date('2026-07-06T00:01:00.000Z'),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
      extra: { admissionLease: 'active' },
    });
    expect(invoked).toBe(false);
  });

  it('ignores stale active observed scheduler workflow runs', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    let invoked = false;

    await expect(
      runObservedSchedulerTick(paths, {
        listRuns: async () => ({
          runs: [
            {
              runId: 'run-stale',
              workflowName: 'scheduler-tick',
              status: 'active' as const,
              startedAt: '2026-07-06T00:00:00.000Z',
            },
          ],
        }),
        getRun: async (runId: string) => {
          if (runId === 'run-stale') {
            return {
              runId,
              workflowName: 'scheduler-tick',
              status: 'active' as const,
              startedAt: '2026-07-06T00:00:00.000Z',
              input: { runtimeHome: paths.home },
            };
          }
          return {
            runId,
            workflowName: 'scheduler-tick',
            status: 'completed' as const,
            startedAt: '2026-07-06T00:10:00.000Z',
            input: { runtimeHome: paths.home },
            result: {
              ok: true,
              action: 'scheduler_tick',
              changed: false,
              outcome: 'silent',
              message: 'new run completed',
            },
          };
        },
        invokeWorkflow: async () => {
          invoked = true;
          return { runId: 'run-new' };
        },
        now: () => new Date('2026-07-06T00:10:00.000Z'),
        activeRunTtlMs: 60_000,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      runId: 'run-new',
      outcome: 'silent',
      message: 'new run completed',
    });
    expect(invoked).toBe(true);
  });

  it('falls back to a direct tick when observed scheduler workflow admission fails', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await expect(
      runObservedSchedulerTick(paths, {
        listRuns: async () => ({ runs: [] }),
        invokeWorkflow: async () => {
          throw new Error('Flue unavailable');
        },
        now: () => new Date('2026-07-06T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'scheduler_tick',
      changed: true,
      outcome: 'silent',
      extra: {
        workflowObservationFallback: true,
        workflowObservationPhase: 'admission',
        workflowAdmissionFailed: true,
        workflowAdmissionError: 'Flue unavailable',
      },
    });
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'Scheduler workflow observation failed',
          source: 'scheduler',
          sourceId: 'scheduler-tick:workflow-observation-fallback',
        }),
      ]),
    );
  });

  it('falls back to a direct tick when observed scheduler workflow inspection fails', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await expect(
      runObservedSchedulerTick(paths, {
        listRuns: async () => {
          throw new Error('run store unavailable');
        },
        now: () => new Date('2026-07-06T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'scheduler_tick',
      changed: true,
      outcome: 'silent',
      extra: {
        workflowObservationFallback: true,
        workflowObservationPhase: 'inspection',
        workflowInspectionFailed: true,
        workflowInspectionError: 'run store unavailable',
      },
    });
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'Scheduler workflow observation failed',
          source: 'scheduler',
          sourceId: 'scheduler-tick:workflow-observation-fallback',
        }),
      ]),
    );
  });

  it('falls back to a direct tick when an admitted observed scheduler run cannot be inspected', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await expect(
      runObservedSchedulerTick(paths, {
        listRuns: async () => ({ runs: [] }),
        invokeWorkflow: async () => ({ runId: 'run-admitted' }),
        getRun: async () => {
          throw new Error('admitted run store unavailable');
        },
        now: () => new Date('2026-07-06T00:00:00.000Z'),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'scheduler_tick',
      changed: true,
      outcome: 'silent',
      extra: {
        workflowObservationFallback: true,
        workflowObservationPhase: 'inspection',
        workflowInspectionFailed: true,
        workflowInspectionError: 'admitted run store unavailable',
      },
    });
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'Scheduler workflow observation failed',
          source: 'scheduler',
          sourceId: 'scheduler-tick:workflow-observation-fallback',
        }),
      ]),
    );
  });

  it('falls back to a direct tick when an active admission lease run cannot be inspected', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    writeSchedulerWorkflowLease(paths, {
      owner: 'other-process',
      runtimeHome: paths.home,
      runId: 'run-other-process',
      acquiredAt: '2026-07-06T00:00:00.000Z',
      expiresAt: '2026-07-06T00:10:00.000Z',
    });

    await expect(
      runObservedSchedulerTick(paths, {
        listRuns: async () => ({ runs: [] }),
        getRun: async () => {
          throw new Error('leased run store unavailable');
        },
        invokeWorkflow: async () => {
          throw new Error('active admission lease should skip execution');
        },
        now: () => new Date('2026-07-06T00:01:00.000Z'),
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'scheduler_tick',
      changed: true,
      outcome: 'silent',
      extra: {
        workflowObservationFallback: true,
        workflowObservationPhase: 'inspection',
        workflowInspectionFailed: true,
        workflowInspectionError: 'leased run store unavailable',
      },
    });
    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          title: 'Scheduler workflow observation failed',
          source: 'scheduler',
          sourceId: 'scheduler-tick:workflow-observation-fallback',
        }),
      ]),
    );
  });

  it('creates blueprint schedules and syncs jobs', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      createScheduleBlueprint(
        {
          blueprint: 'release-watch',
          repo: 'neondeck',
          intervalSeconds: 900,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
    });

    const schedules = JSON.parse(await readFile(paths.schedules, 'utf8')) as {
      schedules: Array<{ id: string; type: string }>;
    };
    expect(schedules.schedules[0]).toMatchObject({
      type: 'release-watch',
      preset: 'release-watch',
    });
  });

  it('creates busywork report blueprint schedules with defaults', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      createScheduleBlueprint(
        { blueprint: 'docs-drift', repo: 'neondeck' },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true, outcome: 'created' });
    await expect(
      createScheduleBlueprint(
        { blueprint: 'issue-triage', repo: 'neondeck' },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true, outcome: 'created' });
    await expect(
      createScheduleBlueprint({ blueprint: 'hygiene' }, paths),
    ).resolves.toMatchObject({ ok: true, outcome: 'created' });

    await expect(listJobs(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'docs-drift',
          intervalSeconds: 604_800,
        }),
        expect.objectContaining({
          type: 'issue-triage',
          intervalSeconds: 86_400,
        }),
        expect.objectContaining({
          type: 'hygiene',
          intervalSeconds: 604_800,
        }),
      ]),
    );
  });

  it('rejects release-watch blueprints for unknown repos', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      createScheduleBlueprint(
        { blueprint: 'release-watch', repo: 'missing' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['repo'],
    });
  });

  it('requires PR references for watch-pr blueprints', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);

    await expect(
      createScheduleBlueprint({ blueprint: 'watch-pr' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['ref'],
    });
  });

  it('does not create watch-pr schedules when watch creation fails', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      createScheduleBlueprint(
        { blueprint: 'watch-pr', ref: 'neondeck#123' },
        paths,
        {
          addPrWatch: async () => ({
            ok: false,
            action: 'watch_pr_add',
            changed: false,
            message: 'Could not fetch GitHub PR state.',
            requires: ['GITHUB_TOKEN'],
          }),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['GITHUB_TOKEN'],
    });

    const schedules = JSON.parse(await readFile(paths.schedules, 'utf8')) as {
      schedules: unknown[];
    };
    expect(schedules.schedules).toEqual([]);
  });

  it('creates one durable polling job for watch-pr blueprints', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      createScheduleBlueprint(
        { blueprint: 'watch-pr', ref: 'neondeck#123', intervalSeconds: 120 },
        paths,
        {
          addPrWatch: (input, runtimePaths) =>
            addPrWatch(input, runtimePaths, async () => prDetail()),
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      jobs: [
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          type: 'watch-pr',
          intervalSeconds: 120,
        }),
      ],
    });

    await expect(listJobs(paths)).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'schedule:watch-pr-neondeck-123' }),
      ]),
    );
    const schedules = JSON.parse(await readFile(paths.schedules, 'utf8')) as {
      schedules: unknown[];
    };
    expect(schedules.schedules).toEqual([]);
  });

  it('reports watch refresh failures instead of staying silent', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(runSchedulerTick(paths, new Date())).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      notifications: [{ title: 'PR watch refresh failed' }],
    });
  });

  it('watch jobs stay silent when refresh has no changes', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(
      runSchedulerTick(paths, new Date(), {
        refreshPrWatch: (input, runtimePaths) =>
          refreshPrWatch(input, runtimePaths, async () => prDetail()),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });
  });

  it('notifies on PR review feedback deltas in notify-only mode', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(
      runSchedulerTick(paths, new Date(), {
        refreshPrWatch: async () => noChangeWatchRefresh(),
        listPrWatchEventWatermarks: async () => emptyWatermarks(),
        refreshPrWatchEventState: async () => reviewThreadEventRefresh(),
        invokeWorkflow: async () => {
          throw new Error('notify-only should not admit triage');
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      notifications: [
        expect.objectContaining({
          title: 'PR watch review feedback',
          level: 'attention',
          source: 'watch-pr-events',
        }),
      ],
    });

    await expect(listNotifications(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'PR watch review feedback',
          source: 'watch-pr-events',
          sourceId:
            'pandemicsyn/neondeck#123:review_threads:2026-06-27T20:10:00Z',
        }),
      ]),
    );
  });

  it('admits triage for PR event deltas when autopilot mode prepares fixes', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    const invocations: Array<{ workflow: string; input: unknown }> = [];
    await writeRepoRegistry(paths.repos);
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        autopilot: { defaultMode: 'draft-fix' },
      })}\n`,
    );
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(
      runSchedulerTick(paths, new Date(), {
        refreshPrWatch: async () => noChangeWatchRefresh(),
        listPrWatchEventWatermarks: async () => emptyWatermarks(),
        refreshPrWatchEventState: async () => reviewThreadEventRefresh(),
        checkAutopilotConcurrency: async () =>
          concurrencyDecision({ allowed: true }),
        invokeWorkflow: async (workflow, input) => {
          invocations.push({ workflow, input });
          return { runId: 'run-triage' };
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
    });

    expect(invocations).toEqual([
      {
        workflow: 'triage-pr-event',
        input: expect.objectContaining({
          repoId: 'neondeck',
          repoFullName: 'pandemicsyn/neondeck',
          prNumber: 123,
          watchId: 'pandemicsyn/neondeck#123',
          source: 'watch',
          autopilotMode: 'draft-fix',
          deltas: [
            expect.objectContaining({
              type: 'review-comment',
              actionable: true,
            }),
          ],
        }),
      },
    ]);
  });

  it('blocks triage admission when autopilot concurrency is exhausted', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await writeFile(
      paths.config,
      `${JSON.stringify({
        version: 1,
        autopilot: { defaultMode: 'draft-fix' },
      })}\n`,
    );
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(
      runSchedulerTick(paths, new Date(), {
        refreshPrWatch: async () => noChangeWatchRefresh(),
        listPrWatchEventWatermarks: async () => emptyWatermarks(),
        refreshPrWatchEventState: async () => reviewThreadEventRefresh(),
        checkAutopilotConcurrency: async () =>
          concurrencyDecision({
            allowed: false,
            message: 'Autopilot concurrency blocks admission.',
            reasons: ['Active autopilot workflow limit reached (3/3).'],
          }),
        invokeWorkflow: async () => {
          throw new Error('blocked triage should not invoke workflow');
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      notifications: [
        expect.objectContaining({ title: 'PR watch review feedback' }),
        expect.objectContaining({
          title: 'Autopilot triage blocked',
          source: 'autopilot',
        }),
      ],
    });
  });

  it('notifies when an auto-polled watch turns green', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(
      runSchedulerTick(paths, new Date(), {
        refreshPrWatch: async () => ({
          ok: true,
          action: 'watch_pr_refresh',
          changed: true,
          outcome: 'updated',
          message: 'Updated watch "pandemicsyn/neondeck#123".',
          watch: {
            id: 'pandemicsyn/neondeck#123',
            status: 'green',
          },
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [{ title: 'PR watch green', level: 'ready' }],
    });
  });

  it('notifies when an auto-polled watch needs attention', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    await expect(
      runSchedulerTick(paths, new Date(), {
        refreshPrWatch: async () => ({
          ok: true,
          action: 'watch_pr_refresh',
          changed: true,
          outcome: 'updated',
          message: 'Updated watch "pandemicsyn/neondeck#123".',
          watch: {
            id: 'pandemicsyn/neondeck#123',
            status: 'attention-needed',
          },
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [
        { title: 'PR watch needs attention', level: 'attention' },
      ],
    });
  });

  it('notifies when release watch default branch checks are green', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await createScheduleBlueprint(
      { blueprint: 'release-watch', repo: 'neondeck', intervalSeconds: 120 },
      paths,
    );

    await expect(
      runSchedulerTick(paths, new Date(), {
        fetchCheckSummary: async () => checkSummary('success'),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [{ title: 'Release watch main green', level: 'ready' }],
    });
  });

  it('keeps linked release watches silent until the source PR watch merges', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123 until prod' }, paths, async () =>
      prDetail(),
    );

    await expect(
      runSchedulerTick(paths, new Date(), {
        fetchCheckSummary: async () => checkSummary('success'),
        refreshPrWatch: (input, runtimePaths) =>
          refreshPrWatch(input, runtimePaths, async () => prDetail()),
        refreshPrWatchEventState: async () => noEventChanges(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });
  });

  it('checks the source PR merge SHA for linked release watches', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const refs: string[] = [];
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123 until prod' }, paths, async () =>
      prDetail(),
    );
    await refreshPrWatch(
      { id: 'pandemicsyn/neondeck#123' },
      paths,
      async () =>
        prDetail({
          state: 'closed',
          merged: true,
          mergeCommitSha: 'abc123',
          updatedAt: '2026-06-27T20:05:00Z',
        }),
      async () => checkSummary('success'),
    );

    await expect(
      runSchedulerTick(paths, new Date(), {
        fetchCheckSummary: async (input) => {
          refs.push(input.ref);
          return checkSummary('success');
        },
        refreshPrWatch: async () => ({
          ok: true,
          action: 'watch_pr_refresh',
          changed: false,
          outcome: 'silent',
          message: 'No change for watch "pandemicsyn/neondeck#123".',
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [
        { title: 'Release watch merge commit green', level: 'ready' },
      ],
    });
    expect(refs).toEqual(['abc123']);
  });

  it('does not notify repeatedly when release watch status is unchanged', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await createScheduleBlueprint(
      { blueprint: 'release-watch', repo: 'neondeck', intervalSeconds: 120 },
      paths,
    );
    await runSchedulerTick(paths, new Date('2026-06-27T20:00:00Z'), {
      fetchCheckSummary: async () => checkSummary('success'),
    });

    await expect(
      runSchedulerTick(paths, new Date('2026-06-27T20:03:00Z'), {
        fetchCheckSummary: async () => checkSummary('success'),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });
  });

  it('marks release watch failures urgent', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await createScheduleBlueprint(
      { blueprint: 'release-watch', repo: 'neondeck', intervalSeconds: 120 },
      paths,
    );

    await expect(
      runSchedulerTick(paths, new Date(), {
        fetchCheckSummary: async () => checkSummary('failure'),
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      notifications: [
        { title: 'Release watch needs attention', level: 'urgent' },
      ],
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  tempRoots.push(home);
  return home;
}

async function writeRepoRegistry(path: string) {
  await writeFile(
    path,
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
}

function prDetail(overrides: Partial<SchedulerPrDetail> = {}) {
  return {
    number: 123,
    title: 'Test PR',
    repo: 'pandemicsyn/neondeck',
    url: 'https://github.com/pandemicsyn/neondeck/pull/123',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    headSha: 'head123',
    baseRef: 'main',
    updatedAt: '2026-06-27T20:00:00Z',
    ...overrides,
  };
}

function checkSummary(status: 'success' | 'failure' | 'pending' | 'none') {
  return {
    status,
    total: status === 'none' ? 0 : 1,
    successful: status === 'success' ? 1 : 0,
    failed: status === 'failure' ? 1 : 0,
    pending: status === 'pending' ? 1 : 0,
    checkedAt: '2026-06-27T20:05:30Z',
  };
}

function noChangeWatchRefresh() {
  return {
    ok: true,
    action: 'watch_pr_refresh',
    changed: false,
    outcome: 'silent' as const,
    message: 'No change for watch "pandemicsyn/neondeck#123".',
    watch: {
      id: 'pandemicsyn/neondeck#123',
      repoId: 'neondeck',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 123,
      status: 'watching',
    },
  };
}

function emptyWatermarks(): PrEventActionResult {
  return {
    ok: true,
    action: 'pr_watch_event_watermarks_list',
    changed: false,
    message: 'Listed 0 PR watch event watermark(s).',
    data: { watermarks: [] },
  };
}

function reviewThreadEventRefresh(): PrEventActionResult {
  return {
    ok: true,
    action: 'pr_watch_event_state_refresh',
    changed: true,
    message: 'Updated 1 PR event watermark(s) for pandemicsyn/neondeck#123.',
    data: {
      watchId: 'pandemicsyn/neondeck#123',
      changedCategories: ['review_threads'],
      watermarks: [
        {
          watchId: 'pandemicsyn/neondeck#123',
          category: 'review_threads',
          watermark: {
            total: 1,
            unresolvedThreadIds: ['thread-1'],
            resolvedThreadIds: [],
            outdatedThreadIds: [],
            latestCommentUpdatedAt: '2026-06-27T20:10:00Z',
            threads: [
              {
                id: 'thread-1',
                isResolved: false,
                isOutdated: false,
                path: 'src/app.ts',
                line: 12,
                commentIds: ['comment-1'],
                latestCommentUpdatedAt: '2026-06-27T20:10:00Z',
              },
            ],
          },
          sourceUpdatedAt: '2026-06-27T20:10:00Z',
          checkedAt: '2026-06-27T20:10:30Z',
          createdAt: '2026-06-27T20:10:30Z',
          updatedAt: '2026-06-27T20:10:30Z',
        },
        {
          watchId: 'pandemicsyn/neondeck#123',
          category: 'mergeability',
          watermark: {
            state: 'open',
            merged: false,
            mergeable: true,
            mergeableState: 'clean',
            mergeCommitSha: null,
            headSha: 'head123',
            baseSha: 'base123',
          },
          sourceUpdatedAt: '2026-06-27T20:10:30Z',
          checkedAt: '2026-06-27T20:10:30Z',
          createdAt: '2026-06-27T20:10:30Z',
          updatedAt: '2026-06-27T20:10:30Z',
        },
      ],
    } as unknown as PrEventActionResult['data'],
  };
}

function noEventChanges(): PrEventActionResult {
  return {
    ok: true,
    action: 'pr_watch_event_state_refresh',
    changed: false,
    message: 'No PR event watermark changes for pandemicsyn/neondeck#123.',
    data: {
      watchId: 'pandemicsyn/neondeck#123',
      changedCategories: [],
      watermarks: [],
    },
  };
}

function concurrencyDecision(input: {
  allowed: boolean;
  message?: string;
  reasons?: string[];
}): AutopilotConcurrencyDecision {
  return {
    ok: input.allowed,
    action: 'autopilot_concurrency_check' as const,
    changed: false,
    message:
      input.message ??
      (input.allowed
        ? 'Autopilot concurrency allows admission.'
        : 'Autopilot concurrency blocks admission.'),
    allowed: input.allowed,
    repoId: 'neondeck',
    prNumber: 123,
    workflow: 'triage-pr-event',
    mutation: false,
    limits: {
      maxAutonomousJobs: 3,
      maxActiveWorkflowRuns: 3,
      maxPerRepoAutonomousJobs: 1,
      singleMutationPerPr: true,
      localExecutionLimit: 1,
    },
    usage: {
      autonomousJobs: input.allowed ? 0 : 3,
      activeWorkflowRuns: input.allowed ? 0 : 3,
      perRepoAutonomousJobs: 0,
      samePrMutationWorkflows: 0,
      localExecutions: 0,
    },
    reasons: input.reasons ?? [],
  };
}

function writeSchedulerLease(paths: RuntimePaths, lease: TestSchedulerLease) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  const updatedAt = lease.acquiredAt;

  try {
    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run('scheduler.tick.lease', JSON.stringify(lease), updatedAt);
  } finally {
    database.close();
  }
}

function writeSchedulerWorkflowLease(
  paths: RuntimePaths,
  lease: TestSchedulerWorkflowLease,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  const updatedAt = lease.acquiredAt;

  try {
    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        'scheduler.tick.workflow.admission.lease',
        JSON.stringify(lease),
        updatedAt,
      );
  } finally {
    database.close();
  }
}

function readSchedulerLease(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    const row = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get('scheduler.tick.lease');
    if (!row || typeof row !== 'object' || !('value' in row)) return;
    return JSON.parse(String(row.value)) as TestSchedulerLease;
  } finally {
    database.close();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }
    await delay(5);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
