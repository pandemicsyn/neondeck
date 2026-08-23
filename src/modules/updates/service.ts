import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import {
  getNotification,
  publishNotificationEvent,
  readNotificationRow,
  resolveNotification,
  type NotificationEvent,
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
  const updateAvailable = compareVersions(payload.version, currentVersion) > 0;
  persistUpdateCheck(
    { channel, latestVersion: payload.version, checkedAt },
    currentVersion,
    updateAvailable,
    paths,
  );
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

function persistUpdateCheck(
  update: CachedUpdate,
  currentVersion: string,
  updateAvailable: boolean,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  const notificationId = updateAvailable
    ? updateNotificationId(update.latestVersion)
    : null;
  const events: NotificationEvent[] = [];
  try {
    withImmediateTransaction(database, () => {
      const obsoleteRows = database
        .prepare(
          `SELECT *
           FROM notifications
           WHERE source = 'neondeck-update'
             AND resolved_at IS NULL;`,
        )
        .all()
        .filter((row) => readNotificationRow(row).id !== notificationId);
      for (const row of obsoleteRows) {
        const obsolete = readNotificationRow(row);
        database
          .prepare(
            `UPDATE notifications
             SET resolved_at = ?,
                 read_at = COALESCE(read_at, ?),
                 updated_at = ?
             WHERE id = ?;`,
          )
          .run(
            update.checkedAt,
            update.checkedAt,
            update.checkedAt,
            obsolete.id,
          );
        const resolvedRow = database
          .prepare('SELECT * FROM notifications WHERE id = ?;')
          .get(obsolete.id);
        if (resolvedRow) {
          events.push({
            id: obsolete.id,
            action: 'resolved',
            notification: readNotificationRow(resolvedRow),
            changedAt: update.checkedAt,
          });
        }
      }

      if (notificationId) {
        const title = `Neondeck ${update.latestVersion} is available`;
        const message = `You are running ${currentVersion}. Review the upgrade instructions when you are ready.`;
        const data = JSON.stringify({
          currentVersion,
          latestVersion: update.latestVersion,
          docsUrl: updateDocsUrl,
          releaseUrl: releaseUrl(update.latestVersion),
        });
        const existing = database
          .prepare('SELECT * FROM notifications WHERE id = ? LIMIT 1;')
          .get(notificationId);
        if (!existing) {
          database
            .prepare(
              `INSERT INTO notifications (
                 id, level, title, message, source, source_id, data_json,
                 read_at, resolved_at, occurrence_count, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?);`,
            )
            .run(
              notificationId,
              'ready',
              title,
              message,
              'neondeck-update',
              update.latestVersion,
              data,
              update.checkedAt,
              update.checkedAt,
            );
          const createdRow = database
            .prepare('SELECT * FROM notifications WHERE id = ?;')
            .get(notificationId);
          if (createdRow) {
            events.push({
              id: notificationId,
              action: 'created',
              notification: readNotificationRow(createdRow),
              changedAt: update.checkedAt,
            });
          }
        } else {
          const existingNotification = readNotificationRow(existing);
          if (
            existingNotification.resolvedAt === null &&
            (existingNotification.title !== title ||
              existingNotification.message !== message ||
              JSON.stringify(existingNotification.data) !== data)
          ) {
            database
              .prepare(
                `UPDATE notifications
                 SET title = ?, message = ?, data_json = ?, updated_at = ?
                 WHERE id = ?;`,
              )
              .run(title, message, data, update.checkedAt, notificationId);
            const reconciledRow = database
              .prepare('SELECT * FROM notifications WHERE id = ?;')
              .get(notificationId);
            if (reconciledRow) {
              events.push({
                id: notificationId,
                action: 'reconciled',
                notification: readNotificationRow(reconciledRow),
                changedAt: update.checkedAt,
              });
            }
          }
        }
      }

      database
        .prepare(
          `INSERT INTO app_metadata (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at;`,
        )
        .run(updateCacheKey, JSON.stringify(update), update.checkedAt);
    });
  } finally {
    database.close();
  }
  for (const event of events) publishNotificationEvent(event);
}

function releaseUrl(version: string) {
  return `https://github.com/pandemicsyn/neondeck/releases/tag/v${encodeURIComponent(version)}`;
}
