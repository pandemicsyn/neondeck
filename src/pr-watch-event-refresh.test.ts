import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listNotifications } from './modules/app-state';
import type { GitHubPullRequestEventState } from './modules/github';
import {
  listPrWatchEventWatermarks,
  recordAddressedPrFeedback,
  recordNeondeckPrDelivery,
  refreshPrWatchEventState,
  requestedChangesReviewDeliveryFingerprint,
  reviewThreadCommentFingerprint,
  watermarksFromEventState,
} from './modules/pr-events';
import { refreshWatchJobEvents } from './modules/scheduler/pr-watch-events';
import { runSchedulerTick } from './modules/scheduler';
import { upsertScheduledTask } from './modules/scheduled-tasks';
import {
  addPrWatch,
  claimWatchAutopilotTurn,
  listPrWatchRecords,
  transitionWatchAutopilot,
} from './modules/watches';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('deterministic PR watch event refresh', () => {
  it('notifies current feedback once on a process-existing first poll without admitting work', async () => {
    const paths = await fixture();
    await writeFile(
      paths.repos,
      `${JSON.stringify(
        {
          repos: [
            {
              id: 'neondeck',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: '/tmp/neondeck',
              defaultBranch: 'main',
              metadata: { autopilot: { mode: 'prepare-only' } },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await addPrWatch(
      { ref: 'neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );

    const state = eventState();
    const dependencies = liveDependencies(state);
    const target = [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never;

    const first = await refreshWatchJobEvents(
      target,
      paths,
      dependencies,
      null,
    );
    expect(first).toEqual([
      expect.objectContaining({
        ok: true,
        changed: true,
        changedCategories: expect.arrayContaining([
          'requested_changes_reviews',
        ]),
        persistedNotifications: [
          expect.objectContaining({
            title: 'PR watch requested changes',
            data: expect.objectContaining({ mode: 'notify-only' }),
          }),
        ],
      }),
    ]);
    expect(await listNotifications(paths)).toEqual([
      expect.objectContaining({
        title: 'PR watch requested changes',
        data: expect.objectContaining({ mode: 'notify-only' }),
      }),
    ]);
    expect(first[0]).not.toHaveProperty('triage');
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: expect.any(String),
    });

    const watermarks = await listPrWatchEventWatermarks(
      { watchId: 'pandemicsyn/neondeck#164' },
      paths,
    );
    expect(watermarks).toMatchObject({
      ok: true,
      data: {
        watermarks: expect.arrayContaining([
          expect.objectContaining({
            category: 'requested_changes_reviews',
            watermark: expect.objectContaining({
              reviews: [
                expect.objectContaining({
                  id: 9001,
                  body: 'Please cover the restart path.',
                  fingerprint: expect.any(String),
                }),
              ],
            }),
          }),
        ]),
      },
    });

    const second = await refreshWatchJobEvents(
      target,
      paths,
      dependencies,
      null,
    );
    expect(second).toEqual([
      expect.objectContaining({ ok: true, changed: false }),
    ]);
  });

  it('keeps a quiet first poll silent while durably recording its baseline', async () => {
    const paths = await fixture();
    await addPrWatch(
      { ref: 'pandemicsyn/neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const state = eventState();
    state.requestedChangesReviews = [];
    state.requestedChangesState = {
      active: [],
      latestByReviewer: [],
      history: [],
    };

    const result = await refreshWatchJobEvents(
      [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never,
      paths,
      liveDependencies(state),
      null,
    );

    expect(result).toEqual([
      expect.objectContaining({ ok: true, changed: false, deltas: [] }),
    ]);
    expect(await listNotifications(paths)).toEqual([]);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      initialEventProcessedAt: expect.any(String),
    });
    await expect(
      listPrWatchEventWatermarks(
        { watchId: 'pandemicsyn/neondeck#164' },
        paths,
      ),
    ).resolves.toMatchObject({
      data: { watermarks: expect.arrayContaining([expect.any(Object)]) },
    });
  });

  it('retains the event baseline while an owner is busy and observes the feedback on the next eligible poll', async () => {
    const paths = await fixture();
    await addPrWatch(
      { ref: 'pandemicsyn/neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const quiet = eventState();
    quiet.requestedChangesReviews = [];
    quiet.requestedChangesState = {
      active: [],
      latestByReviewer: [],
      history: [],
    };
    const target = [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never;
    await refreshWatchJobEvents(target, paths, liveDependencies(quiet), null);

    claimWatchAutopilotTurn(
      paths,
      'pandemicsyn/neondeck#164',
      'in-flight-event',
    );
    const refreshWhileBusy = vi.fn();
    await expect(
      refreshWatchJobEvents(
        target,
        paths,
        { refreshPrWatchEventState: refreshWhileBusy as never },
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ message: expect.stringContaining('Deferred') }),
    ]);
    expect(refreshWhileBusy).not.toHaveBeenCalled();

    transitionWatchAutopilot(paths, 'pandemicsyn/neondeck#164', {
      from: 'working',
      to: 'watching',
    });
    const replayed = await refreshWatchJobEvents(
      target,
      paths,
      liveDependencies(eventState()),
      null,
    );
    expect(replayed).toEqual([
      expect.objectContaining({
        changed: true,
        autopilot: expect.objectContaining({ state: 'notified' }),
        deltas: expect.arrayContaining([
          expect.objectContaining({ type: 'requested-changes' }),
        ]),
      }),
    ]);
  });

  it('filters addressed and Neondeck-delivered feedback in the live first poll', async () => {
    const paths = await fixture();
    await addPrWatch(
      { ref: 'pandemicsyn/neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const state = eventState();
    const thread = reviewThread();
    state.reviewThreads = [thread];
    recordAddressedPrFeedback(
      {
        repoFullName: state.repo,
        prNumber: state.number,
        reviewThreadFingerprints: {},
        reviewCommentFingerprints: {
          '101': reviewThreadCommentFingerprint(thread, thread.comments[0]),
        },
      },
      paths,
    );
    recordNeondeckPrDelivery(
      {
        repoFullName: state.repo,
        prNumber: state.number,
        itemKind: 'review',
        itemId: state.requestedChangesReviews[0].id,
        itemFingerprint: requestedChangesReviewDeliveryFingerprint(
          state.requestedChangesReviews[0],
        ),
      },
      paths,
    );

    const result = await refreshWatchJobEvents(
      [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never,
      paths,
      liveDependencies(state),
      null,
    );

    expect(result).toEqual([
      expect.objectContaining({ ok: true, changed: false, deltas: [] }),
    ]);
    expect(await listNotifications(paths)).toEqual([]);
  });

  it('retries notify-only feedback when atomic notification persistence fails', async () => {
    const paths = await fixture();
    await addPrWatch(
      { ref: 'pandemicsyn/neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database.exec(`CREATE TRIGGER reject_watch_notifications
        BEFORE INSERT ON notifications
        WHEN NEW.source = 'watch-pr-events'
        BEGIN
          SELECT RAISE(ABORT, 'notification write failed');
        END;`);
    } finally {
      database.close();
    }

    await expect(
      refreshWatchJobEvents(
        [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never,
        paths,
        liveDependencies(eventState()),
        null,
      ),
    ).rejects.toThrow('notification write failed');

    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      initialEventProcessedAt: null,
      lastEventFingerprint: null,
    });
    await expect(
      listPrWatchEventWatermarks(
        { watchId: 'pandemicsyn/neondeck#164' },
        paths,
      ),
    ).resolves.toMatchObject({ data: { watermarks: [] } });
    expect(await listNotifications(paths)).toEqual([]);

    const retryDatabase = new DatabaseSync(paths.neondeckDatabase);
    try {
      retryDatabase.exec('DROP TRIGGER reject_watch_notifications;');
    } finally {
      retryDatabase.close();
    }
    await expect(
      refreshWatchJobEvents(
        [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never,
        paths,
        liveDependencies(eventState()),
        null,
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        changed: true,
        autopilot: expect.objectContaining({ state: 'notified' }),
        persistedNotifications: [expect.any(Object)],
      }),
    ]);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      initialEventProcessedAt: expect.any(String),
      lastEventFingerprint: expect.any(String),
    });
    expect(await listNotifications(paths)).toHaveLength(1);
  });

  it('does not let a deferred event fetch overwrite a concurrent current-feedback rearm', async () => {
    const paths = await fixture();
    const state = eventState();
    await addPrWatch(
      { ref: 'pandemicsyn/neondeck#164', processExisting: false },
      paths,
      async () => prDetail(),
      undefined,
      async (_watch, watchId) => watermarksFromEventState(watchId, state),
    );
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: false,
      initialEventProcessedAt: expect.any(String),
    });

    const fetchStarted = Promise.withResolvers<void>();
    const eventFetch = Promise.withResolvers<GitHubPullRequestEventState>();
    const refresh = refreshWatchJobEvents(
      [{ watch: { id: 'pandemicsyn/neondeck#164' } }] as never,
      paths,
      {
        refreshPrWatchEventState: (input, targetPaths, options) =>
          refreshPrWatchEventState(input, targetPaths, {
            token: 'test-token',
            persistWatermarks: options?.persistWatermarks,
            fetchPullRequestEventState: async () => {
              fetchStarted.resolve();
              return eventFetch.promise;
            },
          }),
      },
      null,
    );
    await fetchStarted.promise;

    await expect(
      addPrWatch(
        { ref: 'pandemicsyn/neondeck#164', processExisting: true },
        paths,
        async () => prDetail(),
      ),
    ).resolves.toMatchObject({ ok: true, changed: true });
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });
    await expect(
      listPrWatchEventWatermarks(
        { watchId: 'pandemicsyn/neondeck#164' },
        paths,
      ),
    ).resolves.toMatchObject({ data: { watermarks: [] } });

    eventFetch.resolve(state);
    await expect(refresh).resolves.toEqual([
      expect.objectContaining({
        ok: false,
        changed: false,
        requires: ['currentWatchState'],
        message: expect.stringContaining(
          'current event baseline was preserved',
        ),
      }),
    ]);
    expect((await listPrWatchRecords(paths))[0]).toMatchObject({
      processExisting: true,
      initialEventProcessedAt: null,
    });
    await expect(
      listPrWatchEventWatermarks(
        { watchId: 'pandemicsyn/neondeck#164' },
        paths,
      ),
    ).resolves.toMatchObject({ data: { watermarks: [] } });
  });

  it('reports atomically persisted event notifications without persisting them twice', async () => {
    const paths = await fixture();
    await addPrWatch(
      { ref: 'pandemicsyn/neondeck#164', processExisting: true },
      paths,
      async () => prDetail(),
    );
    await upsertScheduledTask(
      {
        id: 'watch:pandemicsyn/neondeck#164',
        spec: {
          kind: 'poll-pr-watch',
          watchId: 'pandemicsyn/neondeck#164',
        },
        trigger: { kind: 'interval', everySeconds: 300 },
        nextRunAt: '2026-07-19T00:00:00.000Z',
      },
      paths,
    );
    const addNotification =
      vi.fn<
        NonNullable<
          NonNullable<Parameters<typeof runSchedulerTick>[2]>['addNotification']
        >
      >();

    const result = await runSchedulerTick(
      paths,
      new Date('2026-07-19T00:00:00.000Z'),
      {
        ...liveDependencies(eventState()),
        addNotification,
        refreshPrWatch: async () => ({
          ok: true,
          action: 'watch_pr_refresh',
          changed: false,
          outcome: 'silent',
          id: 'pandemicsyn/neondeck#164',
          message: 'Watch unchanged.',
          watch: { id: 'pandemicsyn/neondeck#164' },
        }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      notifications: [
        expect.objectContaining({
          title: 'PR watch requested changes',
          occurrenceCount: 1,
        }),
      ],
    });
    expect(addNotification).not.toHaveBeenCalled();
    expect(await listNotifications(paths)).toEqual([
      expect.objectContaining({
        title: 'PR watch requested changes',
        occurrenceCount: 1,
      }),
    ]);
  });
});

function liveDependencies(state: GitHubPullRequestEventState) {
  return {
    refreshPrWatchEventState: (
      input: Parameters<typeof refreshPrWatchEventState>[0],
      targetPaths: RuntimePaths,
      options?: { persistWatermarks?: boolean },
    ) =>
      refreshPrWatchEventState(input, targetPaths, {
        token: 'test-token',
        fetchPullRequestEventState: async () => state,
        persistWatermarks: options?.persistWatermarks,
      }),
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-pr-watch-events-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

function prDetail() {
  return {
    number: 164,
    title: 'Simplify Autopilot',
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

function eventState(): GitHubPullRequestEventState {
  const review = {
    id: 9001,
    nodeId: 'review-9001',
    state: 'CHANGES_REQUESTED',
    authorLogin: 'reviewer',
    authorType: 'User',
    authorIsBot: false,
    submittedAt: '2026-07-19T00:04:00.000Z',
    commitId: 'a'.repeat(40),
    url: 'https://github.com/pandemicsyn/neondeck/pull/164#pullrequestreview-9001',
    body: 'Please cover the restart path.',
    bodyTruncated: false,
  };
  return {
    repo: 'pandemicsyn/neondeck',
    number: 164,
    url: 'https://github.com/pandemicsyn/neondeck/pull/164',
    title: 'Simplify Autopilot',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    headRepoFullName: 'pandemicsyn/neondeck',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    baseRepoFullName: 'pandemicsyn/neondeck',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [],
    requestedChangesReviews: [review],
    requestedChangesState: {
      active: [review],
      latestByReviewer: [review],
      history: [review],
    },
    conversationComments: [],
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'pandemicsyn/neondeck',
      baseRepoFullName: 'pandemicsyn/neondeck',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-07-19T00:09:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-19T00:10:00.000Z',
  };
}

function reviewThread(): GitHubPullRequestEventState['reviewThreads'][number] {
  return {
    id: 'thread-1',
    isResolved: false,
    isOutdated: false,
    path: 'src/app.ts',
    line: 12,
    comments: [
      {
        id: 'comment-101',
        databaseId: 101,
        authorLogin: 'reviewer',
        body: 'Please cover the restart path.',
        url: 'https://github.com/pandemicsyn/neondeck/pull/164#discussion_r101',
        path: 'src/app.ts',
        line: 12,
        originalLine: 12,
        diffHunk: '@@ -1 +1 @@',
        reviewId: 9001,
        createdAt: '2026-07-19T00:03:00.000Z',
        updatedAt: '2026-07-19T00:03:00.000Z',
      },
    ],
  };
}
