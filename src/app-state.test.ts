import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addNotification,
  addWorkflowSummary,
  listNotifications,
  listWorkflowSummaries,
  markNotificationRead,
  resolveNotification,
} from './modules/app-state';
import {
  subscribeNotificationEvents,
  type NotificationEvent,
} from './modules/app-state';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { openDb } from './lib/sqlite';
import {
  insertWatch,
  persistWatchEventRefresh,
  type PrWatch,
} from './modules/watches';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('app state notifications', () => {
  it('skips malformed persisted rows without hiding valid app state', async () => {
    const paths = runtimePaths(await tempDir());
    const malformedNotification = await addNotification(
      {
        level: 'info',
        title: 'Malformed later',
        message: 'This row will be corrupted.',
      },
      paths,
    );
    await addNotification(
      {
        level: 'ready',
        title: 'Still visible',
        message: 'This row remains valid.',
      },
      paths,
    );
    const malformedSummary = await addWorkflowSummary(
      {
        workflow: 'test',
        status: 'failed',
        summary: { message: 'will be corrupted' },
      },
      paths,
    );
    await addWorkflowSummary(
      {
        workflow: 'test',
        status: 'completed',
        summary: { message: 'still visible' },
      },
      paths,
    );
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare('UPDATE notifications SET level = ? WHERE id = ?;')
        .run('legacy-level', malformedNotification.id);
      database
        .prepare('UPDATE workflow_summaries SET summary_json = ? WHERE id = ?;')
        .run('{', malformedSummary.id);
    } finally {
      database.close();
    }

    await expect(listNotifications(paths)).resolves.toMatchObject([
      { title: 'Still visible' },
    ]);
    await expect(listWorkflowSummaries(paths)).resolves.toMatchObject([
      { status: 'completed', summary: { message: 'still visible' } },
    ]);
  });

  it('reconciles unresolved notifications by source and source id', async () => {
    const paths = runtimePaths(await tempDir());
    const first = await addNotification(
      {
        level: 'attention',
        title: 'PR watch failed',
        message: 'First failure.',
        source: 'watch-pr',
        sourceId: 'repo#1',
      },
      paths,
    );
    const second = await addNotification(
      {
        level: 'ready',
        title: 'PR watch green',
        message: 'Checks are green.',
        source: 'watch-pr',
        sourceId: 'repo#1',
      },
      paths,
    );

    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(2);
    await expect(listNotifications(paths)).resolves.toMatchObject([
      {
        id: first.id,
        level: 'ready',
        title: 'PR watch green',
        message: 'Checks are green.',
        occurrenceCount: 2,
        readAt: null,
        resolvedAt: null,
      },
    ]);
  });

  it('creates a fresh notification when the existing reconciliation row is corrupt', async () => {
    const paths = runtimePaths(await tempDir());
    const corrupt = await addNotification(
      {
        level: 'attention',
        title: 'Corrupt existing',
        message: 'This row will be malformed.',
        source: 'watch-pr',
        sourceId: 'repo#corrupt',
      },
      paths,
    );
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          'UPDATE notifications SET title = CAST(? AS BLOB) WHERE id = ?;',
        )
        .run('corrupt', corrupt.id);
    } finally {
      database.close();
    }

    await expect(
      addNotification(
        {
          level: 'ready',
          title: 'Fresh reconciliation',
          message: 'The valid notification is persisted.',
          source: 'watch-pr',
          sourceId: 'repo#corrupt',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      id: expect.not.stringMatching(corrupt.id),
      title: 'Fresh reconciliation',
    });
    await expect(listNotifications(paths)).resolves.toMatchObject([
      { title: 'Fresh reconciliation' },
    ]);
  });

  it('keeps a watch refresh transaction moving past a corrupt notification row', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const watch = watchFixture();
    insertWatch(paths, watch);
    const corrupt = await addNotification(
      {
        level: 'attention',
        title: 'Corrupt watch event',
        message: 'This row will be malformed.',
        source: 'watch-pr-events',
        sourceId: `${watch.id}:event`,
      },
      paths,
    );
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare(
          'UPDATE notifications SET title = CAST(? AS BLOB) WHERE id = ?;',
        )
        .run('corrupt', corrupt.id);
    } finally {
      database.close();
    }

    expect(
      persistWatchEventRefresh(
        paths,
        watch.id,
        [],
        {
          expectedWatchState: watch,
          notification: {
            level: 'ready',
            title: 'Persisted after corruption',
            message: 'Watermarks and notification were reconciled.',
            source: 'watch-pr-events',
            sourceId: `${watch.id}:event`,
          },
        },
        '2026-08-21T00:01:00.000Z',
      ),
    ).toMatchObject({
      persisted: true,
      notification: { title: 'Persisted after corruption' },
    });
    await expect(listNotifications(paths)).resolves.toMatchObject([
      { title: 'Persisted after corruption' },
    ]);
  });

  it('marks notifications read and hides resolved notifications by default', async () => {
    const paths = runtimePaths(await tempDir());
    const notification = await addNotification(
      {
        level: 'info',
        title: 'Queued',
        message: 'Digest queued.',
        source: 'scheduler',
        sourceId: 'digest',
      },
      paths,
    );

    await markNotificationRead(notification.id, paths);
    let notifications = await listNotifications(paths);
    expect(notifications[0]).toMatchObject({
      id: notification.id,
      readAt: expect.any(String),
      resolvedAt: null,
    });

    await resolveNotification(notification.id, paths);
    await expect(listNotifications(paths)).resolves.toEqual([]);
    notifications = await listNotifications(paths, { includeResolved: true });
    expect(notifications[0]).toMatchObject({
      id: notification.id,
      readAt: expect.any(String),
      resolvedAt: expect.any(String),
    });
  });

  it('sorts reconciled notifications by latest update time', async () => {
    const paths = runtimePaths(await tempDir());
    const recurring = await addNotification(
      {
        level: 'attention',
        title: 'Recurring',
        message: 'First.',
        source: 'watch-pr',
        sourceId: 'repo#1',
      },
      paths,
    );
    await addNotification(
      {
        level: 'info',
        title: 'One off',
        message: 'Second.',
        source: 'scheduler',
        sourceId: 'digest',
      },
      paths,
    );
    await addNotification(
      {
        level: 'attention',
        title: 'Recurring',
        message: 'Third.',
        source: 'watch-pr',
        sourceId: 'repo#1',
      },
      paths,
    );

    await expect(listNotifications(paths)).resolves.toMatchObject([
      {
        id: recurring.id,
        message: 'Third.',
        occurrenceCount: 2,
      },
      {
        title: 'One off',
      },
    ]);
  });

  it('publishes notification events for inbox changes', async () => {
    const paths = runtimePaths(await tempDir());
    const events: NotificationEvent[] = [];
    const unsubscribe = subscribeNotificationEvents((event) => {
      events.push(event);
    });

    try {
      const notification = await addNotification(
        {
          level: 'attention',
          title: 'Needs attention',
          message: 'A watcher failed.',
          source: 'watch-pr',
          sourceId: 'repo#2',
        },
        paths,
      );
      await markNotificationRead(notification.id, paths);
      await markNotificationRead(notification.id, paths);
      await resolveNotification(notification.id, paths);
      await resolveNotification(notification.id, paths);
    } finally {
      unsubscribe();
    }

    expect(events).toMatchObject([
      {
        action: 'created',
        notification: { title: 'Needs attention', readAt: null },
      },
      {
        action: 'read',
        notification: { title: 'Needs attention', readAt: expect.any(String) },
      },
      {
        action: 'resolved',
        notification: {
          title: 'Needs attention',
          resolvedAt: expect.any(String),
        },
      },
    ]);
  });

  it('does not let broken notification listeners break persistence', async () => {
    const paths = runtimePaths(await tempDir());
    const events: NotificationEvent[] = [];
    const broken = subscribeNotificationEvents(() => {
      throw new Error('closed stream');
    });
    const working = subscribeNotificationEvents((event) => {
      events.push(event);
    });

    try {
      await expect(
        addNotification(
          {
            level: 'attention',
            title: 'Still persists',
            message: 'A watcher failed.',
            source: 'watch-pr',
            sourceId: 'repo#3',
          },
          paths,
        ),
      ).resolves.toMatchObject({ title: 'Still persists' });
    } finally {
      broken();
      working();
    }

    await expect(listNotifications(paths)).resolves.toMatchObject([
      { title: 'Still persists' },
    ]);
    expect(events).toMatchObject([
      { action: 'created', notification: { title: 'Still persists' } },
    ]);
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-state-'));
  tempRoots.push(path);
  return path;
}

function watchFixture(): PrWatch {
  const now = '2026-08-21T00:00:00.000Z';
  return {
    id: 'acme/widgets#1',
    repoId: 'widgets',
    repoFullName: 'acme/widgets',
    githubOwner: 'acme',
    githubName: 'widgets',
    prNumber: 1,
    desiredTerminalState: 'checks',
    status: 'watching',
    prState: 'open',
    title: 'Improve persistence',
    url: 'https://example.test/acme/widgets/pull/1',
    mergeCommitSha: null,
    lastSnapshot: null,
    lastOutcome: null,
    lastCheckedAt: null,
    createdBy: null,
    processExisting: false,
    initialEventProcessedAt: null,
    eventWatermarkVersion: 2,
    autopilotMode: 'prepare-only',
    autopilotStatus: 'watching',
    ownerInstanceId: null,
    worktreeId: null,
    lastEventFingerprint: null,
    createdAt: now,
    updatedAt: now,
  };
}
