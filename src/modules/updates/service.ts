import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import {
  publishNotificationEvent,
  readNotificationRow,
  resolveNotification,
  type NotificationEvent,
  type NotificationRecord,
} from '../app-state';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { neondeckVersion, unknownNeondeckVersion } from '../../version';
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
  notificationId: string | null;
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
  const enabled = updateChecksEnabled(process.env, currentVersion);
  const database = openDb(paths.neondeckDatabase);
  let result: { status: UpdateStatus; events: NotificationEvent[] };
  try {
    result = withImmediateTransaction(database, () => {
      const cached = readCachedUpdate(database);
      const status = buildUpdateStatus(enabled, currentVersion, cached, null);
      const events = resolveMatchingUpdateNotifications(
        database,
        new Date().toISOString(),
        (notification) => !enabled || notification.id !== status.notificationId,
      );
      const notification = status.notificationId
        ? database
            .prepare('SELECT * FROM notifications WHERE id = ? LIMIT 1;')
            .get(status.notificationId)
        : null;
      return {
        status: {
          ...status,
          dismissed: notification
            ? Boolean(readNotificationRow(notification).resolvedAt)
            : false,
        },
        events,
      };
    });
  } finally {
    database.close();
  }
  for (const event of result.events) publishNotificationEvent(event);
  return result.status;
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
  const localStatus = await readUpdateStatus(paths, currentVersion);
  if (!localStatus.enabled) return localStatus;
  const channel = localStatus.channel;
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
  const cached = { channel, latestVersion: payload.version, checkedAt };
  const notification = persistUpdateCheck(
    cached,
    currentVersion,
    updateAvailable,
    paths,
  );
  return buildUpdateStatus(true, currentVersion, cached, notification);
}

export async function dismissUpdate(
  version: string,
  paths = runtimePaths(),
  currentVersion = neondeckVersion,
) {
  const status = await readUpdateStatus(paths, currentVersion);
  if (
    !status.updateAvailable ||
    status.latestVersion !== version ||
    !status.notificationId
  ) {
    throw new Error(`Version ${version} is not the current available update.`);
  }
  await resolveNotification(status.notificationId, paths);
  return { ...status, dismissed: true };
}

export function updateNotificationId(version: string) {
  if (!parseVersion(version))
    throw new Error(`Invalid update version ${version}.`);
  return `${updateNotificationPrefix}${version}`;
}

export function updateChecksEnabled(
  env: NodeJS.ProcessEnv = process.env,
  currentVersion = neondeckVersion,
) {
  return (
    env.NEONDECK_DISABLE_UPDATE_CHECK !== '1' &&
    currentVersion !== unknownNeondeckVersion
  );
}

function buildUpdateStatus(
  enabled: boolean,
  currentVersion: string,
  cached: CachedUpdate | null,
  notification: NotificationRecord | null,
): UpdateStatus {
  const channel = updateChannelForVersion(currentVersion);
  const latestVersion =
    cached?.channel === channel && parseVersion(cached.latestVersion)
      ? cached.latestVersion
      : null;
  const updateAvailable =
    enabled &&
    latestVersion !== null &&
    compareVersions(latestVersion, currentVersion) > 0;
  return {
    enabled,
    currentVersion,
    latestVersion,
    channel,
    updateAvailable,
    dismissed: Boolean(notification?.resolvedAt),
    notificationId:
      updateAvailable && latestVersion
        ? updateNotificationId(latestVersion)
        : null,
    docsUrl: updateDocsUrl,
    releaseUrl: latestVersion ? releaseUrl(latestVersion) : null,
    checkedAt: cached?.channel === channel ? cached.checkedAt : null,
  };
}

function readCachedUpdate(
  database: ReturnType<typeof openDb>,
): CachedUpdate | null {
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
  let currentNotification: NotificationRecord | null = null;
  try {
    withImmediateTransaction(database, () => {
      events.push(
        ...resolveMatchingUpdateNotifications(
          database,
          update.checkedAt,
          (notification) => notification.id !== notificationId,
        ),
      );

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
            currentNotification = readNotificationRow(createdRow);
            events.push({
              id: notificationId,
              action: 'created',
              notification: currentNotification,
              changedAt: update.checkedAt,
            });
          }
        } else {
          const existingNotification = readNotificationRow(existing);
          currentNotification = existingNotification;
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
              currentNotification = readNotificationRow(reconciledRow);
              events.push({
                id: notificationId,
                action: 'reconciled',
                notification: currentNotification,
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
  return currentNotification;
}

function resolveMatchingUpdateNotifications(
  database: ReturnType<typeof openDb>,
  changedAt: string,
  shouldResolve: (notification: NotificationRecord) => boolean,
) {
  const events: NotificationEvent[] = [];
  const notifications = database
    .prepare(
      `SELECT *
       FROM notifications
       WHERE source = 'neondeck-update'
         AND resolved_at IS NULL;`,
    )
    .all()
    .map(readNotificationRow)
    .filter(shouldResolve);
  for (const notification of notifications) {
    database
      .prepare(
        `UPDATE notifications
         SET resolved_at = ?,
             read_at = COALESCE(read_at, ?),
             updated_at = ?
         WHERE id = ?
           AND resolved_at IS NULL;`,
      )
      .run(changedAt, changedAt, changedAt, notification.id);
    const resolvedRow = database
      .prepare('SELECT * FROM notifications WHERE id = ?;')
      .get(notification.id);
    if (resolvedRow) {
      events.push({
        id: notification.id,
        action: 'resolved',
        notification: readNotificationRow(resolvedRow),
        changedAt,
      });
    }
  }
  return events;
}

function releaseUrl(version: string) {
  return `https://github.com/pandemicsyn/neondeck/releases/tag/v${encodeURIComponent(version)}`;
}
