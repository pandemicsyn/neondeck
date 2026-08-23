import { openDb } from '../../lib/sqlite';
import {
  addNotification,
  getNotification,
  resolveNotification,
} from '../app-state';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { neondeckVersion } from '../../version';
import {
  compareVersions,
  parseVersion,
  updateChannelForVersion,
} from './version';

export type UpdateChannel = 'latest' | 'next';

export type UpdateStatus = {
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: UpdateChannel;
  updateAvailable: boolean;
  dismissed: boolean;
  docsUrl: string;
  releaseUrl: string | null;
  checkedAt: string | null;
};

type CachedUpdate = {
  channel: UpdateChannel;
  latestVersion: string;
  checkedAt: string;
};

type RegistryResponse = { version?: unknown };

export const updateDocsUrl = 'https://neondeck.dev/docs/upgrading/';
export const updateCheckIntervalMs = 24 * 60 * 60_000;
export const updateCheckTimeoutMs = 5_000;
const updateCacheKey = 'neondeck-update-status';
const updateNotificationPrefix = 'neondeck-update:';

export async function readUpdateStatus(
  paths = runtimePaths(),
  currentVersion = neondeckVersion,
): Promise<UpdateStatus> {
  await ensureRuntimeHome(paths);
  const enabled = updateChecksEnabled();
  const channel = updateChannelForVersion(currentVersion);
  const cached = readCachedUpdate(paths);
  const latestVersion =
    cached?.channel === channel && parseVersion(cached.latestVersion)
      ? cached.latestVersion
      : null;
  const updateAvailable =
    enabled &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  const notification = updateAvailable
    ? await getNotification(updateNotificationId(latestVersion), paths)
    : null;

  return {
    enabled,
    currentVersion,
    latestVersion,
    channel,
    updateAvailable,
    dismissed: Boolean(notification?.resolvedAt),
    docsUrl: updateDocsUrl,
    releaseUrl: latestVersion ? releaseUrl(latestVersion) : null,
    checkedAt: cached?.channel === channel ? cached.checkedAt : null,
  };
}

export async function checkForUpdates(
  paths = runtimePaths(),
  options: {
    currentVersion?: string;
    fetcher?: typeof fetch;
    now?: () => Date;
  } = {},
) {
  const currentVersion = options.currentVersion ?? neondeckVersion;
  if (!updateChecksEnabled()) return readUpdateStatus(paths, currentVersion);
  await ensureRuntimeHome(paths);
  const channel = updateChannelForVersion(currentVersion);
  const response = await (options.fetcher ?? fetch)(
    `https://registry.npmjs.org/neondeck/${channel}`,
    {
      headers: {
        accept: 'application/json',
        'user-agent': `neondeck/${currentVersion}`,
      },
      signal: AbortSignal.timeout(updateCheckTimeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(`Neondeck update check returned ${response.status}.`);
  }
  const payload = (await response.json()) as RegistryResponse;
  if (typeof payload.version !== 'string' || !parseVersion(payload.version)) {
    throw new Error('Neondeck update check returned an invalid version.');
  }

  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  writeCachedUpdate(
    { channel, latestVersion: payload.version, checkedAt },
    paths,
  );
  if (compareVersions(payload.version, currentVersion) > 0) {
    await addNotification(
      {
        id: updateNotificationId(payload.version),
        level: 'ready',
        title: `Neondeck ${payload.version} is available`,
        message: `You are running ${currentVersion}. Review the upgrade instructions when you are ready.`,
        source: 'neondeck-update',
        sourceId: payload.version,
        data: {
          currentVersion,
          latestVersion: payload.version,
          docsUrl: updateDocsUrl,
          releaseUrl: releaseUrl(payload.version),
        },
      },
      paths,
    );
  } else {
    await resolveInstalledUpdateNotifications(currentVersion, paths);
  }
  return readUpdateStatus(paths, currentVersion);
}

export async function dismissUpdate(
  version: string,
  paths = runtimePaths(),
  currentVersion = neondeckVersion,
) {
  const status = await readUpdateStatus(paths, currentVersion);
  if (!status.updateAvailable || status.latestVersion !== version) {
    throw new Error(`Version ${version} is not the current available update.`);
  }
  await resolveNotification(updateNotificationId(version), paths);
  return readUpdateStatus(paths, currentVersion);
}

export function updateNotificationId(version: string) {
  if (!parseVersion(version))
    throw new Error(`Invalid update version ${version}.`);
  return `${updateNotificationPrefix}${version}`;
}

export function updateChecksEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NEONDECK_DISABLE_UPDATE_CHECK !== '1';
}

function readCachedUpdate(paths: RuntimePaths): CachedUpdate | null {
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT value FROM app_metadata WHERE key = ? LIMIT 1;')
      .get(updateCacheKey) as { value?: unknown } | undefined;
    if (typeof row?.value !== 'string') return null;
    const value = JSON.parse(row.value) as Partial<CachedUpdate>;
    return (value.channel === 'latest' || value.channel === 'next') &&
      typeof value.latestVersion === 'string' &&
      typeof value.checkedAt === 'string'
      ? (value as CachedUpdate)
      : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}

function writeCachedUpdate(update: CachedUpdate, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO app_metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at;`,
      )
      .run(updateCacheKey, JSON.stringify(update), update.checkedAt);
  } finally {
    database.close();
  }
}

async function resolveInstalledUpdateNotifications(
  currentVersion: string,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  let ids: string[] = [];
  try {
    ids = (
      database
        .prepare(
          `SELECT id, source_id
           FROM notifications
           WHERE source = 'neondeck-update'
             AND resolved_at IS NULL;`,
        )
        .all() as Array<{ id: string; source_id: string | null }>
    )
      .filter(
        (row) =>
          row.source_id !== null &&
          parseVersion(row.source_id) !== null &&
          compareVersions(row.source_id, currentVersion) <= 0,
      )
      .map((row) => row.id);
  } finally {
    database.close();
  }
  await Promise.all(ids.map((id) => resolveNotification(id, paths)));
}

function releaseUrl(version: string) {
  return `https://github.com/pandemicsyn/neondeck/releases/tag/v${encodeURIComponent(version)}`;
}
