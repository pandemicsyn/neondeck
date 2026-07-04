import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addNotification,
  listNotifications,
  markNotificationRead,
  resolveNotification,
} from './modules/app-state';
import {
  subscribeNotificationEvents,
  type NotificationEvent,
} from './modules/app-state';
import { runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('app state notifications', () => {
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
