import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addNotification,
  listNotifications,
  markNotificationRead,
  resolveNotification,
} from './app-state';
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
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-state-'));
  tempRoots.push(path);
  return path;
}
