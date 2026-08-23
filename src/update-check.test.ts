import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNotification } from './modules/app-state';
import {
  checkForUpdates,
  compareVersions,
  dismissUpdate,
  parseVersion,
  readUpdateStatus,
  updateChannelForVersion,
  updateNotificationId,
} from './modules/updates';
import { runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.NEONDECK_DISABLE_UPDATE_CHECK;
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Neondeck version comparison', () => {
  it('orders stable and prerelease versions using semver precedence', () => {
    expect(compareVersions('1.0.0-beta.39', '1.0.0-beta.38')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-beta.39')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareVersions('2.0.0+build.2', '2.0.0+build.1')).toBe(0);
  });

  it('rejects malformed versions and selects the release channel', () => {
    expect(parseVersion('1.0')).toBeNull();
    expect(parseVersion('1.0.0-01')).toBeNull();
    expect(updateChannelForVersion('1.0.0-beta.38')).toBe('next');
    expect(updateChannelForVersion('1.0.0')).toBe('latest');
  });
});

describe('Neondeck update checking', () => {
  it('caches a newer prerelease and creates one durable notification', async () => {
    const paths = runtimePaths(await tempDir());
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe('https://registry.npmjs.org/neondeck/next');
      return Response.json({ version: '1.0.0-beta.39' });
    });

    const first = await checkForUpdates(paths, {
      currentVersion: '1.0.0-beta.38',
      fetcher,
      now: () => new Date('2026-08-23T12:00:00.000Z'),
    });
    const second = await checkForUpdates(paths, {
      currentVersion: '1.0.0-beta.38',
      fetcher,
      now: () => new Date('2026-08-24T12:00:00.000Z'),
    });

    expect(first).toMatchObject({
      currentVersion: '1.0.0-beta.38',
      latestVersion: '1.0.0-beta.39',
      channel: 'next',
      updateAvailable: true,
      dismissed: false,
      docsUrl: 'https://neondeck.dev/docs/upgrading/',
    });
    expect(second.checkedAt).toBe('2026-08-24T12:00:00.000Z');
    await expect(
      getNotification(updateNotificationId('1.0.0-beta.39'), paths),
    ).resolves.toMatchObject({
      level: 'ready',
      source: 'neondeck-update',
      sourceId: '1.0.0-beta.39',
      occurrenceCount: 1,
    });
  });

  it('keeps one version dismissed and surfaces the next version', async () => {
    const paths = runtimePaths(await tempDir());
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ version: '1.0.0-beta.39' }),
    );
    await checkForUpdates(paths, {
      currentVersion: '1.0.0-beta.38',
      fetcher,
    });

    await expect(
      dismissUpdate('1.0.0-beta.39', paths, '1.0.0-beta.38'),
    ).resolves.toMatchObject({ dismissed: true });
    await expect(
      readUpdateStatus(paths, '1.0.0-beta.38'),
    ).resolves.toMatchObject({ dismissed: true, updateAvailable: true });

    fetcher.mockResolvedValue(Response.json({ version: '1.0.0-beta.40' }));
    await expect(
      checkForUpdates(paths, {
        currentVersion: '1.0.0-beta.38',
        fetcher,
      }),
    ).resolves.toMatchObject({
      latestVersion: '1.0.0-beta.40',
      dismissed: false,
    });
  });

  it('respects the update-check opt out without calling the registry', async () => {
    process.env.NEONDECK_DISABLE_UPDATE_CHECK = '1';
    const paths = runtimePaths(await tempDir());
    const fetcher = vi.fn<typeof fetch>();

    await expect(
      checkForUpdates(paths, {
        currentVersion: '1.0.0-beta.38',
        fetcher,
      }),
    ).resolves.toMatchObject({ enabled: false, updateAvailable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-update-test-'));
  tempRoots.push(path);
  return path;
}
