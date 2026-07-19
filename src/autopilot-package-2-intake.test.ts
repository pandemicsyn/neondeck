import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { subscribeNotificationEvents } from './modules/app-state';
import { listPrWatchEventWatermarks } from './modules/pr-events';
import {
  categoryWatermark,
  upsertWatermarks,
} from './modules/pr-events/watermarks';
import { refreshWatchJobEvents } from './modules/scheduler/pr-watch-events';
import { addPrWatch, listPrWatchRecords } from './modules/watches';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { emptyPrWatchInitialEventBaseline } from './testing/pr-watch-event-baseline';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Package 2 process-existing intake', () => {
  it('retries a persisted first-poll baseline after policy recovery and admits it exactly once', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );

    let refreshCount = 0;
    const refreshPrWatchEventState = async () => {
      refreshCount += 1;
      upsertWatermarks(paths, watchId, [
        categoryWatermark(
          watchId,
          'requested_changes_reviews',
          '2026-07-19T00:00:00.000Z',
          {
            total: 1,
            truncated: false,
            reviewIds: [9001],
            reviews: [
              {
                id: 9001,
                authorLogin: 'reviewer',
                body: 'Please cover the restart path.',
                bodyTruncated: false,
                actionable: true,
                fingerprint: 'review-fingerprint',
              },
            ],
          },
        ),
      ]);
      const listed = await listPrWatchEventWatermarks({ watchId }, paths);
      return {
        ok: true,
        action: 'pr_watch_event_state_refresh',
        changed: refreshCount === 1,
        message: 'refreshed',
        data: {
          ...(listed.data as Record<string, unknown>),
          changedCategories:
            refreshCount === 1 ? ['requested_changes_reviews'] : [],
        },
      };
    };
    const target = [{ watch: { id: watchId } }] as never;

    // Simulate a first-poll race where the watch exists before its repository
    // policy is available. The baseline is durable, but processing is not.
    await writeRepoRegistry(paths, false);
    const first = await refreshWatchJobEvents(
      target,
      paths,
      { refreshPrWatchEventState: refreshPrWatchEventState as never },
      null,
    );
    expect(first).toEqual([
      expect.objectContaining({
        ok: false,
        message: expect.stringContaining('policy is unavailable'),
      }),
    ]);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });

    await writeRepoRegistry(paths, true);
    let invocationCount = 0;
    const dependencies = {
      refreshPrWatchEventState: refreshPrWatchEventState as never,
      invokeWorkflow: async () => {
        invocationCount += 1;
        return { runId: `run-${invocationCount}` };
      },
    };
    const second = await refreshWatchJobEvents(
      target,
      paths,
      dependencies,
      null,
    );
    expect(second).toEqual([
      expect.objectContaining({
        ok: true,
        changed: true,
        message: expect.stringContaining('Durably admitted'),
      }),
    ]);
    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));

    await refreshWatchJobEvents(target, paths, dependencies, null);
    expect(invocationCount).toBe(1);
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => {
          throw new Error('idempotent true mode must not refetch detail');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      message: expect.stringContaining(
        'Current actionable feedback was selected for processing and its initial state has already been handled.',
      ),
    });
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM autopilot_admissions WHERE watch_id = ?;',
          )
          .get(watchId),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('admits only feedback created after watch configuration on the true first poll', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: false },
        paths,
        async () => prDetail(),
        undefined,
        async (reference, baselineWatchId) => [
          ...(
            await emptyPrWatchInitialEventBaseline(reference, baselineWatchId)
          ).filter(
            (watermark) => watermark.category !== 'conversation_comments',
          ),
          categoryWatermark(
            watchId,
            'conversation_comments',
            '2026-07-19T05:00:00.000Z',
            {
              total: 1,
              truncated: false,
              comments: [
                {
                  id: 7001,
                  authorLogin: 'maintainer',
                  body: 'This feedback predates watch configuration.',
                  createdAt: '2026-07-19T05:00:00.000Z',
                  updatedAt: '2026-07-19T05:00:00.000Z',
                  bodyTruncated: false,
                  actionable: true,
                  fingerprint: 'pre-watch-comment',
                },
              ],
            },
          ),
        ],
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Current feedback was baselined'),
    });

    let refreshCount = 0;
    const refreshPrWatchEventState = async () => {
      refreshCount += 1;
      upsertWatermarks(paths, watchId, [
        categoryWatermark(
          watchId,
          'conversation_comments',
          '2026-07-19T05:00:00.000Z',
          {
            total: 2,
            truncated: false,
            comments: [
              {
                id: 7001,
                authorLogin: 'maintainer',
                body: 'This feedback predates watch configuration.',
                createdAt: '2026-07-19T05:00:00.000Z',
                updatedAt: '2026-07-19T05:00:00.000Z',
                bodyTruncated: false,
                actionable: true,
                fingerprint: 'pre-watch-comment',
              },
              {
                id: 7002,
                authorLogin: 'maintainer',
                body: 'This arrived between watch creation and first poll.',
                createdAt: '2026-07-19T05:00:00.000Z',
                updatedAt: '2026-07-19T05:00:00.000Z',
                bodyTruncated: false,
                actionable: true,
                fingerprint: 'post-watch-comment',
              },
            ],
          },
        ),
      ]);
      const listed = await listPrWatchEventWatermarks({ watchId }, paths);
      return {
        ok: true,
        action: 'pr_watch_event_state_refresh',
        changed: refreshCount === 1,
        message: 'refreshed',
        data: {
          ...(listed.data as Record<string, unknown>),
          changedCategories:
            refreshCount === 1 ? ['conversation_comments'] : [],
        },
      };
    };
    const admittedInputs: Array<Record<string, unknown>> = [];
    const dependencies = {
      refreshPrWatchEventState: refreshPrWatchEventState as never,
      invokeWorkflow: async (_workflow: string, input: unknown) => {
        admittedInputs.push(input as Record<string, unknown>);
        return { runId: `run-${admittedInputs.length}` };
      },
    };
    const target = [{ watch: { id: watchId } }] as never;

    await expect(
      refreshWatchJobEvents(target, paths, dependencies as never, null),
    ).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        changed: true,
      }),
    ]);
    await refreshWatchJobEvents(target, paths, dependencies as never, null);

    expect(admittedInputs).toHaveLength(1);
    expect(admittedInputs[0]).toMatchObject({
      deltas: [
        expect.objectContaining({
          type: 'conversation-comment',
          itemId: '7002',
        }),
      ],
    });
    expect(
      (admittedInputs[0]!.deltas as Array<Record<string, unknown>>).some(
        (delta) => delta.itemId === '7001',
      ),
    ).toBe(false);
    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));
  });

  it('captures a fresh baseline on true-to-false reconfiguration and resets only on false-to-true', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true);
    const watchId = 'pandemicsyn/neondeck#164';
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => prDetail(),
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(
        'Current actionable feedback will be processed before later changes.',
      ),
    });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });

    let baselineCaptures = 0;
    const captureBaseline = async (
      reference: Parameters<typeof emptyPrWatchInitialEventBaseline>[0],
      baselineWatchId: string,
    ) => {
      baselineCaptures += 1;
      return emptyPrWatchInitialEventBaseline(reference, baselineWatchId);
    };
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: false },
        paths,
        async () => {
          throw new Error(
            'nonterminal reconfiguration must not refetch detail',
          );
        },
        undefined,
        captureBaseline,
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('Current feedback was baselined'),
    });
    const falseModeWatch = (await listPrWatchRecords(paths))[0]!;
    expect(falseModeWatch).toMatchObject({ processExisting: false });
    expect(falseModeWatch.initialEventProcessedAt).toEqual(expect.any(String));
    expect(
      (await listPrWatchEventWatermarks({ watchId }, paths)).data,
    ).toMatchObject({
      watermarks: expect.arrayContaining([expect.anything()]),
    });

    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: false },
        paths,
        async () => {
          throw new Error('idempotent reconfiguration must not refetch detail');
        },
        undefined,
        async () => {
          throw new Error('idempotent false mode must not recapture baseline');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      message: expect.stringContaining(
        'Current feedback was baselined; only later changes will run.',
      ),
    });
    expect(baselineCaptures).toBe(1);
    expect((await listPrWatchRecords(paths))[0]!.initialEventProcessedAt).toBe(
      falseModeWatch.initialEventProcessedAt,
    );

    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => {
          throw new Error(
            'nonterminal reconfiguration must not refetch detail',
          );
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(
        'Current actionable feedback will be processed',
      ),
    });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });
    await expect(
      addPrWatch(
        { ref: 'neondeck#164', processExisting: true },
        paths,
        async () => {
          throw new Error('idempotent true mode must not refetch detail');
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      message: expect.stringContaining(
        'Current actionable feedback will be processed before later changes.',
      ),
    });
  });

  it('atomically persists one notify-only synthetic delivery with the processed marker', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths, true, 'notify-only');
    const watchId = 'pandemicsyn/neondeck#164';
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    let first = true;
    const refreshPrWatchEventState = async () => {
      upsertWatermarks(paths, watchId, [
        categoryWatermark(
          watchId,
          'conversation_comments',
          '2026-07-19T00:00:00.000Z',
          {
            total: 1,
            truncated: false,
            comments: [
              {
                id: 7001,
                authorLogin: 'maintainer',
                body: 'Please update the error copy.',
                bodyTruncated: false,
                actionable: true,
                fingerprint: 'comment-fingerprint',
              },
            ],
          },
        ),
      ]);
      const listed = await listPrWatchEventWatermarks({ watchId }, paths);
      const changedCategories = first ? ['conversation_comments'] : [];
      first = false;
      return {
        ok: true,
        action: 'pr_watch_event_state_refresh',
        changed: changedCategories.length > 0,
        message: 'refreshed',
        data: {
          ...(listed.data as Record<string, unknown>),
          changedCategories,
        },
      };
    };
    const dependencies = {
      refreshPrWatchEventState: refreshPrWatchEventState as never,
    };
    const target = [{ watch: { id: watchId } }] as never;
    const published: Array<{ action: string; sourceId: string | null }> = [];
    const unsubscribe = subscribeNotificationEvents((event) => {
      published.push({
        action: event.action,
        sourceId: event.notification.sourceId,
      });
    });

    try {
      await refreshWatchJobEvents(target, paths, dependencies, null);
      await refreshWatchJobEvents(target, paths, dependencies, null);
    } finally {
      unsubscribe();
    }

    expect(
      (await listPrWatchRecords(paths))[0]!.initialEventProcessedAt,
    ).toEqual(expect.any(String));
    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    try {
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count, MAX(occurrence_count) AS occurrences
             FROM notifications
             WHERE source = 'watch-pr-events';`,
          )
          .get(),
      ).toEqual({ count: 1, occurrences: 1 });
      expect(
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM autopilot_admissions WHERE watch_id = ?;',
          )
          .get(watchId),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }
    expect(published).toEqual([
      {
        action: 'created',
        sourceId: expect.stringContaining('conversation_comments'),
      },
    ]);
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-package-2-intake-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

async function writeRepoRegistry(
  paths: RuntimePaths,
  includeRepo: boolean,
  mode = 'prepare-only',
) {
  await writeFile(
    paths.repos,
    `${JSON.stringify(
      {
        repos: includeRepo
          ? [
              {
                id: 'neondeck',
                github: { owner: 'pandemicsyn', name: 'neondeck' },
                path: '/tmp/neondeck',
                defaultBranch: 'main',
                metadata: { autopilot: { mode } },
              },
            ]
          : [],
      },
      null,
      2,
    )}\n`,
  );
}

function prDetail() {
  return {
    number: 164,
    title: 'Restart-safe process-existing intake',
    body: null,
    repo: 'pandemicsyn/neondeck',
    url: 'https://github.com/pandemicsyn/neondeck/pull/164',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}
