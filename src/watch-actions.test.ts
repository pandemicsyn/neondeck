import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { JsonValue } from '@flue/runtime';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  listScheduledTasks,
  readLatestScheduledTaskRun,
} from './modules/scheduled-tasks';
import {
  addRefWatch,
  addPrWatch as addPrWatchWithoutBaseline,
  bindWatchAutopilotOwner,
  canonicalizePrWatchRepoId,
  deleteWatch as deleteWatchRecord,
  listRefWatches,
  listPrWatches,
  parseWatchRefReference,
  parseWatchPrReference,
  refreshRefWatch,
  refreshPrWatch,
  removePrWatch,
  readWatch,
  setPrWatchPolling,
  transitionWatchAutopilot,
  updateWatch,
} from './modules/watches';
import { runtimePaths, type RuntimePaths } from './runtime-home';
import type {
  GitHubCheckSummary,
  GitHubPullRequestDetail,
} from './modules/github';
import { emptyPrWatchInitialEventBaseline } from './testing/pr-watch-event-baseline';
import { openDb } from './lib/sqlite';
import {
  recordWorktreeCreating,
  updateWorktreeStatus,
} from './modules/worktrees/store';
import type { WorktreeLifecycleStatus } from './modules/worktrees';

const addPrWatch = (...args: Parameters<typeof addPrWatchWithoutBaseline>) =>
  addPrWatchWithoutBaseline(
    args[0],
    args[1],
    args[2],
    args[3],
    emptyPrWatchInitialEventBaseline,
  );

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR watch actions', () => {
  it('parses supported PR watch reference forms', () => {
    const registry = {
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
      ],
    };

    expect(
      parseWatchPrReference('pandemicsyn/neondeck#123', registry),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'pandemicsyn/neondeck#123',
        repoId: 'neondeck',
        desiredTerminalState: 'checks',
      },
    });
    expect(
      parseWatchPrReference(
        'https://github.com/pandemicsyn/neondeck/pull/123',
        registry,
      ),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'pandemicsyn/neondeck#123',
        repoId: 'neondeck',
      },
    });
    expect(parseWatchPrReference('#123', registry)).toMatchObject({
      ok: true,
      reference: { id: 'pandemicsyn/neondeck#123' },
    });
    expect(
      parseWatchPrReference('external/example#42', registry),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'external/example#42',
        repoId: 'external/example',
      },
    });
  });

  it('requires repo context for bare PR numbers when registry is ambiguous', () => {
    const registry = {
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
        {
          id: 'flue',
          github: { owner: 'pandemicsyn', name: 'flue' },
          path: '/src/flue',
          defaultBranch: 'main',
        },
      ],
    };

    expect(parseWatchPrReference('#123', registry)).toMatchObject({
      ok: false,
      result: { requires: ['repo'] },
    });
  });

  it('repairs a legacy full-name repo id before local Autopilot work', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());
    const watch = readWatch(paths, 'pandemicsyn/neondeck#123');
    expect(watch).toBeDefined();
    const legacyWatch = {
      ...watch!,
      repoId: 'pandemicsyn/neondeck',
      updatedAt: '2026-07-21T21:00:00.000Z',
    };
    expect(updateWatch(paths, legacyWatch, watch!)).toBe(true);

    await expect(
      canonicalizePrWatchRepoId(paths, legacyWatch.id),
    ).resolves.toMatchObject({ repoId: 'neondeck' });
    expect(readWatch(paths, legacyWatch.id)).toMatchObject({
      repoId: 'neondeck',
    });
  });

  it('adds, lists, silently refreshes, and removes PR watches', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    const detail = prDetail({
      state: 'open',
      updatedAt: '2026-06-27T20:00:00Z',
    });
    const fetcher = async () => detail;

    await expect(
      addPrWatch({ ref: 'neondeck#123' }, paths, fetcher),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      message: expect.stringContaining(
        'Current feedback was baselined; only later changes will run.',
      ),
      watch: {
        id: 'pandemicsyn/neondeck#123',
        status: 'watching',
        prState: 'open',
        createdBy: null,
      },
    });

    await expect(listPrWatches(paths)).resolves.toMatchObject({
      ok: true,
      changed: false,
      watches: [{ id: 'pandemicsyn/neondeck#123' }],
    });
    await expect(listScheduledTasks(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          spec: { kind: 'poll-pr-watch', watchId: 'pandemicsyn/neondeck#123' },
          trigger: { kind: 'interval', everySeconds: 300 },
          enabled: true,
        }),
      ]),
    );

    await expect(
      refreshPrWatch({ id: 'pandemicsyn/neondeck#123' }, paths, fetcher),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });

    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['confirm'],
    });
    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'removed',
    });
    await expect(listScheduledTasks(paths)).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'watch:pandemicsyn/neondeck#123' }),
      ]),
    );
  });

  it('skips malformed persisted watch and scheduled-task rows', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare('UPDATE pr_watches SET status = ? WHERE id = ?;')
        .run('legacy-status', 'pandemicsyn/neondeck#123');
    } finally {
      database.close();
    }

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(listPrWatches(paths)).resolves.toMatchObject({ watches: [] });
    expect(warning).toHaveBeenCalledWith(
      '[neondeck] skipped malformed persisted PR watch row',
      expect.any(Error),
    );
    warning.mockRestore();

    const taskDatabase = openDb(paths.neondeckDatabase);
    try {
      taskDatabase
        .prepare(
          `INSERT INTO scheduled_task_runs (
             id, task_id, status, outcome, message,
             started_at, completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          'valid-run',
          'watch:pandemicsyn/neondeck#123',
          'completed',
          'recorded',
          'valid run',
          '2026-08-21T00:00:00.000Z',
          '2026-08-21T00:00:01.000Z',
          '2026-08-21T00:00:00.000Z',
          '2026-08-21T00:00:01.000Z',
        );
      taskDatabase
        .prepare(
          `INSERT INTO scheduled_task_runs (
             id, task_id, status, outcome, message,
             started_at, completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          'malformed-run',
          'watch:pandemicsyn/neondeck#123',
          'completed',
          'recorded',
          'malformed run',
          '2026-08-21T00:01:00.000Z',
          '2026-08-21T00:01:01.000Z',
          '2026-08-21T00:01:00.000Z',
          '2026-08-21T00:01:01.000Z',
        );
      taskDatabase
        .prepare('UPDATE scheduled_task_runs SET result_json = ? WHERE id = ?;')
        .run('{', 'malformed-run');
      taskDatabase
        .prepare('UPDATE scheduled_tasks SET trigger_json = ? WHERE id = ?;')
        .run('{', 'watch:pandemicsyn/neondeck#123');
    } finally {
      taskDatabase.close();
    }
    await expect(
      readLatestScheduledTaskRun('watch:pandemicsyn/neondeck#123', paths),
    ).resolves.toMatchObject({ id: 'valid-run' });
    await expect(listScheduledTasks(paths)).resolves.toEqual([]);
  });

  it('ignores refreshed check observation timestamps for unchanged merged PRs', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    const detail = prDetail({
      state: 'closed',
      merged: true,
      mergeCommitSha: 'merge123',
      updatedAt: '2026-06-27T20:00:00Z',
    });

    await addPrWatch(
      { ref: 'neondeck#123' },
      paths,
      async () => detail,
      async () => checkSummary('success', '2026-06-27T20:05:30Z'),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () => detail,
        async () => checkSummary('success', '2026-06-27T21:05:30Z'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });
  });

  it('requires Autopilot cleanup before removing an owner-bound watch', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch(
      { ref: 'neondeck#123' },
      paths,
      async () => prDetail(),
      async () => checkSummary('pending'),
    );
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'owner-123',
      worktreeId: 'worktree-123',
    });

    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['stopAutopilot'],
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toBeTruthy();
  });

  it('removes a completed Autopilot watch while retaining its adopted worktree', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch(
      { ref: 'neondeck#123' },
      paths,
      async () => prDetail(),
      async () => checkSummary('pending'),
    );
    recordAutopilotWorktree(paths, {
      id: 'adopted-worktree-123',
      adopted: true,
      status: 'ready',
    });
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'owner-123',
      worktreeId: 'adopted-worktree-123',
    });
    expect(
      transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
        from: 'watching',
        to: 'complete',
      }),
    ).toBeTruthy();

    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'removed',
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toBeUndefined();
  });

  it('retains a completed watch when managed worktree cleanup failed', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch(
      { ref: 'neondeck#123' },
      paths,
      async () => prDetail(),
      async () => checkSummary('pending'),
    );
    recordAutopilotWorktree(paths, {
      id: 'cleanup-failed-worktree-123',
      adopted: false,
      status: 'cleanup-pending',
    });
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'owner-123',
      worktreeId: 'cleanup-failed-worktree-123',
    });
    expect(
      transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
        from: 'watching',
        to: 'complete',
      }),
    ).toBeTruthy();

    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['completeWorktreeCleanup'],
      message: expect.stringContaining('finishes cleanup'),
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toBeTruthy();
  });

  it('keeps a rearmed watch and polling task when removal loses its state fence', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch(
      { ref: 'neondeck#123' },
      paths,
      async () => prDetail(),
      async () => checkSummary('pending'),
    );
    expect(
      transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
        from: 'watching',
        to: 'complete',
      }),
    ).toBeTruthy();

    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths, {
        deleteWatch(deletePaths, id, expected) {
          expect(
            transitionWatchAutopilot(deletePaths, id, {
              from: 'complete',
              to: 'watching',
            }),
          ).toBeTruthy();
          return deleteWatchRecord(deletePaths, id, expected);
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentWatchState'],
      watch: { autopilotStatus: 'watching' },
    });
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toMatchObject({
      autopilotStatus: 'watching',
    });
    expect(
      (await listScheduledTasks(paths)).some(
        (task) => task.id === 'watch:pandemicsyn/neondeck#123',
      ),
    ).toBe(true);
  });

  it('rolls back watch removal when polling task cleanup fails', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);
    await addPrWatch(
      { ref: 'neondeck#123' },
      paths,
      async () => prDetail(),
      async () => checkSummary('pending'),
    );
    const database = openDb(paths.neondeckDatabase);
    try {
      database.exec(`
        CREATE TRIGGER reject_watch_polling_task_delete
        BEFORE DELETE ON scheduled_tasks
        WHEN OLD.id = 'watch:pandemicsyn/neondeck#123'
        BEGIN
          SELECT RAISE(ABORT, 'polling task cleanup failed');
        END;
      `);
    } finally {
      database.close();
    }

    await expect(
      removePrWatch({ id: 'pandemicsyn/neondeck#123', confirm: true }, paths),
    ).rejects.toThrow('polling task cleanup failed');
    expect(readWatch(paths, 'pandemicsyn/neondeck#123')).toBeTruthy();
    expect(
      (await listScheduledTasks(paths)).some(
        (task) => task.id === 'watch:pandemicsyn/neondeck#123',
      ),
    ).toBe(true);
  });

  it('returns an existing PR watch as an idempotent no-op with attribution preserved', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      addPrWatch(
        { ref: 'neondeck#123', createdBy: 'external:codex' },
        paths,
        async () => prDetail(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        createdBy: 'external:codex',
      },
    });

    await expect(
      addPrWatch(
        { ref: 'neondeck#123', createdBy: 'external:claude-code' },
        paths,
        async () => {
          throw new Error('duplicate registrations must not fetch');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
      message: expect.stringContaining(
        'Current feedback was baselined; only later changes will run.',
      ),
      watch: {
        id: 'pandemicsyn/neondeck#123',
        createdBy: 'external:codex',
      },
    });
  });

  it('fails closed when a process-existing baseline is empty or truncated', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      addPrWatchWithoutBaseline(
        { ref: 'neondeck#123', processExisting: false },
        paths,
        async () => prDetail(),
        undefined,
        async () => [],
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['completePrEventFacts'],
      errors: [expect.stringContaining('missing categories')],
    });
    expect(await listPrWatches(paths)).toMatchObject({ watches: [] });
    expect(await listScheduledTasks(paths)).toEqual([]);

    await expect(
      addPrWatchWithoutBaseline(
        { ref: 'neondeck#123', processExisting: false },
        paths,
        async () => prDetail(),
        undefined,
        async (reference, watchId) =>
          (await emptyPrWatchInitialEventBaseline(reference, watchId)).map(
            (watermark) =>
              watermark.category === 'conversation_comments'
                ? {
                    ...watermark,
                    value: { truncated: true, comments: [] },
                  }
                : watermark,
          ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['completePrEventFacts'],
      errors: [expect.stringContaining('conversation_comments')],
    });
    expect(await listPrWatches(paths)).toMatchObject({ watches: [] });
    expect(await listScheduledTasks(paths)).toEqual([]);

    await expect(
      addPrWatchWithoutBaseline(
        { ref: 'neondeck#123', processExisting: false },
        paths,
        async () => prDetail(),
        undefined,
        async (reference, watchId) =>
          (await emptyPrWatchInitialEventBaseline(reference, watchId)).map(
            (watermark) =>
              watermark.category === 'review_threads'
                ? {
                    ...watermark,
                    value: {
                      truncated: false,
                      threads: [{ commentsTruncated: true }],
                    },
                  }
                : watermark,
          ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['completePrEventFacts'],
      errors: [expect.stringContaining('review_threads')],
    });
    expect(await listPrWatches(paths)).toMatchObject({ watches: [] });
    expect(await listScheduledTasks(paths)).toEqual([]);

    const itemTruncationCases: Array<{
      category: string;
      value: JsonValue;
    }> = [
      {
        category: 'review_threads',
        value: {
          truncated: false,
          threads: [
            {
              commentsTruncated: false,
              comments: [{ bodyTruncated: true }],
            },
          ],
        },
      },
      {
        category: 'requested_changes_reviews',
        value: {
          truncated: false,
          reviews: [{ bodyTruncated: true }],
        },
      },
    ];
    for (const itemTruncation of itemTruncationCases) {
      await expect(
        addPrWatchWithoutBaseline(
          { ref: 'neondeck#123', processExisting: false },
          paths,
          async () => prDetail(),
          undefined,
          async (reference, watchId) =>
            (await emptyPrWatchInitialEventBaseline(reference, watchId)).map(
              (watermark) =>
                watermark.category === itemTruncation.category
                  ? { ...watermark, value: itemTruncation.value }
                  : watermark,
            ),
        ),
      ).resolves.toMatchObject({
        ok: false,
        changed: false,
        requires: ['completePrEventFacts'],
        errors: [expect.stringContaining(itemTruncation.category)],
      });
      expect(await listPrWatches(paths)).toMatchObject({ watches: [] });
      expect(await listScheduledTasks(paths)).toEqual([]);
    }
  });

  it('updates existing PR watch targets and polling intervals without refetching', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      addPrWatch(
        { ref: 'neondeck#123' },
        paths,
        async () => prDetail(),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        desiredTerminalState: 'checks',
      },
    });

    await expect(
      addPrWatch(
        {
          ref: 'neondeck#123',
          desiredTerminalState: 'merged',
          intervalSeconds: 120,
        },
        paths,
        async () => {
          throw new Error('existing watch updates must not fetch');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        id: 'pandemicsyn/neondeck#123',
        desiredTerminalState: 'merged',
        status: 'watching',
        lastOutcome: 'updated',
      },
    });

    await expect(listPrWatches(paths)).resolves.toMatchObject({
      watches: [
        {
          id: 'pandemicsyn/neondeck#123',
          desiredTerminalState: 'merged',
          pollIntervalSeconds: 120,
        },
      ],
    });
    await expect(listScheduledTasks(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          trigger: { kind: 'interval', everySeconds: 120 },
        }),
      ]),
    );
  });

  it('marks refresh changed when PR state changes', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
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
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'green',
        mergeCommitSha: 'abc123',
        lastSnapshot: {
          checks: { status: 'success' },
        },
      },
    });
  });

  it('marks an approved open PR watch ready', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            reviewDecision: 'APPROVED',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('success'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'ready',
        lastSnapshot: { reviewDecision: 'APPROVED' },
      },
    });
  });

  it('marks merged PR watches attention-needed when checks fail', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('failure'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'attention-needed',
        mergeCommitSha: 'abc123',
        lastSnapshot: {
          checks: { status: 'failure' },
        },
      },
    });
  });

  it('keeps default checks watches active while merge checks are pending', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'watching',
        mergeCommitSha: 'abc123',
        lastSnapshot: {
          checks: { status: 'pending' },
        },
      },
    });
  });

  it('marks explicit merged-target watches ready when the PR merges', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123 until merged' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await expect(
      refreshPrWatch(
        { id: 'pandemicsyn/neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:05:00Z',
          }),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        desiredTerminalState: 'merged',
        status: 'merged',
        mergeCommitSha: 'abc123',
      },
    });
  });

  it('re-arms terminal PR watches when watch-pr is run again', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );
    await refreshPrWatch(
      { id: 'pandemicsyn/neondeck#123' },
      paths,
      async () =>
        prDetail({
          state: 'closed',
          merged: false,
          updatedAt: '2026-06-27T20:05:00Z',
        }),
      async () => checkSummary('none'),
    );

    await expect(
      addPrWatch(
        { ref: 'neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'open',
            merged: false,
            updatedAt: '2026-06-27T20:10:00Z',
          }),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'watching',
        prState: 'open',
        lastSnapshot: {
          checks: null,
        },
      },
    });
  });

  it('re-arms an explicitly stopped watch with fresh owner bindings', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );
    bindWatchAutopilotOwner(paths, 'pandemicsyn/neondeck#123', {
      ownerInstanceId: 'owner-before-stop',
      worktreeId: 'worktree-before-stop',
    });
    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#123', {
      from: 'watching',
      to: 'complete',
      eventFingerprint: 'handled-before-stop',
    });
    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: false },
      paths,
    );

    await expect(
      addPrWatch(
        { ref: 'neondeck#123' },
        paths,
        async () =>
          prDetail({ state: 'open', updatedAt: '2026-06-27T20:10:00Z' }),
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        autopilotStatus: 'watching',
        ownerInstanceId: null,
        worktreeId: null,
        lastEventFingerprint: null,
      },
    });
    await expect(listPrWatches(paths)).resolves.toMatchObject({
      watches: [{ pollingEnabled: true }],
    });
  });

  it('re-arms green PR watches when watch-pr is run again', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
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
      addPrWatch(
        { ref: 'neondeck#123' },
        paths,
        async () =>
          prDetail({
            state: 'closed',
            merged: true,
            mergeCommitSha: 'abc123',
            updatedAt: '2026-06-27T20:10:00Z',
          }),
        async () => checkSummary('success'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        status: 'green',
        prState: 'closed',
        lastSnapshot: {
          checks: { status: 'success' },
          updatedAt: '2026-06-27T20:10:00Z',
        },
      },
    });
  });

  it('pauses and resumes the single PR polling task', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addPrWatch({ ref: 'neondeck#123' }, paths, async () =>
      prDetail({ state: 'open', updatedAt: '2026-06-27T20:00:00Z' }),
    );

    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: false },
      paths,
    );

    await expect(listScheduledTasks(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          enabled: false,
        }),
      ]),
    );

    await setPrWatchPolling(
      { id: 'pandemicsyn/neondeck#123', enabled: true },
      paths,
    );

    await expect(listScheduledTasks(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'watch:pandemicsyn/neondeck#123',
          enabled: true,
        }),
      ]),
    );
  });
});

describe('ref watch actions', () => {
  it('parses supported ref watch reference forms', () => {
    const registry = {
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
      ],
    };

    expect(
      parseWatchRefReference(
        { target: 'pandemicsyn/neondeck@feature/scheduler' },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'pandemicsyn/neondeck@feature/scheduler',
        repoId: 'neondeck',
        ref: 'feature/scheduler',
      },
    });
    expect(
      parseWatchRefReference({ target: 'neondeck@abc123' }, registry),
    ).toMatchObject({
      ok: true,
      reference: {
        repoId: 'neondeck',
        id: 'pandemicsyn/neondeck@abc123',
      },
    });
    expect(
      parseWatchRefReference(
        {
          target:
            'https://github.com/pandemicsyn/neondeck/tree/feature%2Fscheduler',
        },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'pandemicsyn/neondeck@feature/scheduler',
        repoId: 'neondeck',
        ref: 'feature/scheduler',
      },
    });
    expect(
      parseWatchRefReference(
        { target: 'external/example@feature/scheduler' },
        registry,
      ),
    ).toMatchObject({
      ok: true,
      reference: {
        id: 'external/example@feature/scheduler',
        repoId: 'external/example',
      },
    });
  });

  it('adds, lists, and silently refreshes ref watches', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      addRefWatch(
        { repo: 'neondeck', ref: 'feature/scheduler' },
        paths,
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'created',
      watch: {
        id: 'pandemicsyn/neondeck@feature/scheduler',
        status: 'watching',
        ref: 'feature/scheduler',
      },
    });

    await expect(listRefWatches(paths)).resolves.toMatchObject({
      ok: true,
      changed: false,
      watches: [{ id: 'pandemicsyn/neondeck@feature/scheduler' }],
    });
    await expect(listScheduledTasks(paths)).resolves.toEqual([]);

    await expect(
      refreshRefWatch(
        { id: 'pandemicsyn/neondeck@feature/scheduler' },
        paths,
        async () => checkSummary('pending'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      outcome: 'silent',
    });
  });

  it('marks ref refresh changed when checks change', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await addRefWatch(
      { target: 'neondeck@feature/scheduler' },
      paths,
      async () => checkSummary('pending'),
    );

    await expect(
      refreshRefWatch(
        { target: 'neondeck@feature/scheduler' },
        paths,
        async () => checkSummary('success'),
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      outcome: 'updated',
      watch: {
        id: 'pandemicsyn/neondeck@feature/scheduler',
        status: 'green',
        lastSnapshot: {
          checks: { status: 'success' },
        },
      },
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

function recordAutopilotWorktree(
  paths: RuntimePaths,
  input: {
    id: string;
    adopted: boolean;
    status: WorktreeLifecycleStatus;
  },
) {
  const now = new Date().toISOString();
  recordWorktreeCreating(
    {
      id: input.id,
      repo: {
        id: 'neondeck',
        github: { owner: 'pandemicsyn', name: 'neondeck' },
        path: '/src/neondeck',
        defaultBranch: 'main',
      },
      prNumber: 123,
      baseRef: 'main',
      headOwner: 'pandemicsyn',
      headName: 'neondeck',
      headRef: 'feature/autopilot',
      headSha: 'head123',
      localPath: `/tmp/${input.id}`,
      storageKind: 'home',
      workflowRunId: null,
      cleanupPolicy: {
        retainFailed: true,
        retainPreparedDiff: true,
        successfulGraceHours: 24,
        staleAgeHours: 168,
      },
      directPushAllowed: false,
      adopted: input.adopted,
      createdBy: input.adopted ? 'user' : 'neondeck',
      now,
    },
    paths,
  );
  updateWorktreeStatus(input.id, input.status, paths);
}

function prDetail(
  overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail {
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

function checkSummary(
  status: GitHubCheckSummary['status'],
  checkedAt = '2026-06-27T20:05:30Z',
): GitHubCheckSummary {
  return {
    status,
    total: 1,
    successful: status === 'success' ? 1 : 0,
    failed: status === 'failure' ? 1 : 0,
    pending: status === 'pending' ? 1 : 0,
    checkedAt,
  };
}
