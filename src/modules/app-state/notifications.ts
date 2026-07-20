import { randomUUID } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import { publishNotificationEvent } from './notification-events';
import type { NotificationLevel, NotificationRecord } from './types';

export async function listNotifications(
  paths = runtimePaths(),
  options: { includeResolved?: boolean } = {},
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

  try {
    return database
      .prepare(
        `
        SELECT *
        FROM notifications
        ${options.includeResolved ? '' : 'WHERE resolved_at IS NULL'}
        ORDER BY updated_at DESC, occurrence_count DESC, created_at DESC
        LIMIT 100;
      `,
      )
      .all()
      .map(readNotificationRow);
  } finally {
    database.close();
  }
}

export async function addNotification(
  input: {
    level: NotificationLevel;
    title: string;
    message: string;
    source?: string;
    sourceId?: string;
    data?: unknown;
  },
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const source = input.source ?? null;
  const sourceId = input.sourceId ?? null;
  const notification: NotificationRecord = {
    id: randomUUID(),
    level: input.level,
    title: input.title,
    message: input.message,
    source,
    sourceId,
    data: input.data === undefined ? null : asJsonValue(input.data),
    readAt: null,
    resolvedAt: null,
    occurrenceCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const database = openDb(paths.neondeckDatabase);

  try {
    const existing =
      source && sourceId
        ? database
            .prepare(
              `
              SELECT *
              FROM notifications
              WHERE source = ?
                AND source_id = ?
                AND resolved_at IS NULL
              ORDER BY created_at DESC
              LIMIT 1;
            `,
            )
            .get(source, sourceId)
        : undefined;

    if (existing) {
      const existingRecord = readNotificationRow(existing);
      database
        .prepare(
          `
          UPDATE notifications
          SET
            level = ?,
            title = ?,
            message = ?,
            data_json = ?,
            read_at = NULL,
            occurrence_count = occurrence_count + 1,
            updated_at = ?
          WHERE id = ?;
        `,
        )
        .run(
          notification.level,
          notification.title,
          notification.message,
          notification.data === null ? null : JSON.stringify(notification.data),
          now,
          existingRecord.id,
        );

      const reconciled = {
        ...notification,
        id: existingRecord.id,
        createdAt: existingRecord.createdAt,
        occurrenceCount: existingRecord.occurrenceCount + 1,
      };
      publishNotificationEvent({
        id: reconciled.id,
        action: 'reconciled',
        notification: reconciled,
        changedAt: now,
      });
      return reconciled;
    }

    database
      .prepare(
        `
        INSERT INTO notifications (
          id,
          level,
          title,
          message,
          source,
          source_id,
          data_json,
          read_at,
          resolved_at,
          occurrence_count,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        notification.id,
        notification.level,
        notification.title,
        notification.message,
        notification.source,
        notification.sourceId,
        notification.data === null ? null : JSON.stringify(notification.data),
        notification.readAt,
        notification.resolvedAt,
        notification.occurrenceCount,
        notification.createdAt,
        notification.updatedAt,
      );
  } finally {
    database.close();
  }

  publishNotificationEvent({
    id: notification.id,
    action: 'created',
    notification,
    changedAt: now,
  });
  return notification;
}

export async function markNotificationRead(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);

  try {
    const result = database
      .prepare(
        `
        UPDATE notifications
        SET read_at = ?, updated_at = ?
        WHERE id = ?
          AND read_at IS NULL;
      `,
      )
      .run(now, now, id);
    if (result.changes === 0) return;
    const row = database
      .prepare('SELECT * FROM notifications WHERE id = ?;')
      .get(id);
    if (row) {
      publishNotificationEvent({
        id,
        action: 'read',
        notification: readNotificationRow(row),
        changedAt: now,
      });
    }
  } finally {
    database.close();
  }
}

export async function resolveNotification(id: string, paths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);

  try {
    const result = database
      .prepare(
        `
        UPDATE notifications
        SET resolved_at = ?, read_at = COALESCE(read_at, ?), updated_at = ?
        WHERE id = ?
          AND resolved_at IS NULL;
      `,
      )
      .run(now, now, now, id);
    if (result.changes === 0) return;
    const row = database
      .prepare('SELECT * FROM notifications WHERE id = ?;')
      .get(id);
    if (row) {
      publishNotificationEvent({
        id,
        action: 'resolved',
        notification: readNotificationRow(row),
        changedAt: now,
      });
    }
  } finally {
    database.close();
  }
}

export function readNotificationRow(row: unknown): NotificationRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    level: String(record.level) as NotificationLevel,
    title: String(record.title),
    message: String(record.message),
    source: typeof record.source === 'string' ? record.source : null,
    sourceId: typeof record.source_id === 'string' ? record.source_id : null,
    data:
      typeof record.data_json === 'string'
        ? JSON.parse(record.data_json)
        : null,
    readAt: typeof record.read_at === 'string' ? record.read_at : null,
    resolvedAt:
      typeof record.resolved_at === 'string' ? record.resolved_at : null,
    occurrenceCount: Number(record.occurrence_count ?? 1),
    createdAt: String(record.created_at),
    updatedAt:
      typeof record.updated_at === 'string'
        ? record.updated_at
        : String(record.created_at),
  };
}
