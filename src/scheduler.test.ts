import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listJobs, listNotifications } from './app-state';
import {
  createScheduleBlueprint,
  runSchedulerTick,
  syncScheduledJobs,
} from './scheduler';
import { runtimePaths } from './runtime-home';
import { addPrWatch, refreshPrWatch } from './watch-actions';

const tempRoots: string[] = [];

afterEach(async () => {
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

    await expect(runSchedulerTick(paths, new Date())).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      notifications: [{ title: 'Review queue digest due' }],
    });
    await expect(listNotifications(paths)).resolves.toMatchObject([
      { title: 'Review queue digest due', level: 'info' },
    ]);
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

  it('reports scheduled watch refresh failures instead of staying silent', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());
    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'watch-neondeck-123',
            type: 'watch-pr',
            enabled: true,
            preset: 'watch-pr',
            config: {
              id: 'pandemicsyn/neondeck#123',
              intervalSeconds: 60,
            },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);

    await expect(runSchedulerTick(paths, new Date())).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      notifications: [{ title: 'PR watch refresh failed' }],
    });
  });

  it('scheduled watch jobs stay silent when refresh has no changes', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());
    await writeFile(
      paths.schedules,
      `${JSON.stringify({
        schedules: [
          {
            id: 'watch-neondeck-123',
            type: 'watch-pr',
            enabled: true,
            preset: 'watch-pr',
            config: {
              id: 'pandemicsyn/neondeck#123',
              intervalSeconds: 60,
            },
          },
        ],
      })}\n`,
    );
    await syncScheduledJobs(paths);

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

function prDetail() {
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
  };
}
