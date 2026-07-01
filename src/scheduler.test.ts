import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { listJobs, listNotifications } from './app-state';
import {
  createScheduleBlueprint,
  runSchedulerTick,
  startSchedulerLoop,
  syncScheduledJobs,
} from './scheduler';
import { type RuntimePaths, runtimePaths } from './runtime-home';
import { addPrWatch, refreshPrWatch } from './watch-actions';

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

  it('records failed workflow admissions without leaving jobs started', async () => {
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

    await expect(
      runSchedulerTick(paths, now, {
        invokeWorkflow: async () => {
          throw new Error('admission failed');
        },
      }),
    ).rejects.toThrow('admission failed');

    await expect(listJobs(paths)).resolves.toMatchObject([
      {
        id: 'schedule:digest',
        lastOutcome: 'failed',
        lastMessage: 'Scheduler job failed: admission failed.',
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
