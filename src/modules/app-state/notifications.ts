import { randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { asJsonValue } from '../../lib/action-result';
import { collectValidRowsInBatches, openDb, parseRow } from '../../lib/sqlite';
import { ensureRuntimeHome, runtimePaths } from '../../runtime-home';
import { publishNotificationEvent } from './notification-events';
import type { NotificationLevel, NotificationRecord } from './types';
import * as v from 'valibot';
import { appStateJsonValueSchema, notificationRowSchema } from './schemas';

export async function listNotifications(
  paths = runtimePaths(),
  options: { includeResolved?: boolean } = {},
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);

  try {
    return collectValidRowsInBatches(
      100,
      (limit, offset) =>
        database
          .prepare(
            `SELECT *
             FROM notifications
             ${options.includeResolved ? '' : 'WHERE resolved_at IS NULL'}
             ORDER BY updated_at DESC, occurrence_count DESC, created_at DESC
             LIMIT ? OFFSET ?;`,
          )
          .all(limit, offset),
      safeNotificationRow,
    );
  } finally {
    database.close();
  }
}

export async function addNotification(
  input: {
    id?: string;
    signal?: AbortSignal;
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
  input.signal?.throwIfAborted();
  if (input.id) {
    const database = openDb(paths.neondeckDatabase);
    try {
      const row = database
        .prepare('SELECT * FROM notifications WHERE id = ? LIMIT 1;')
        .get(input.id.trim());
      const existing = row ? tryReadNotificationRow(row) : undefined;
      if (existing) return existing;
    } finally {
      database.close();
    }
  }
  const now = new Date().toISOString();
  const source = input.source ?? null;
  const sourceId = input.sourceId ?? null;
  const notification: NotificationRecord = {
    id: input.id ?? randomUUID(),
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
    input.signal?.throwIfAborted();
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

    const existingRecord = existing
      ? tryReadNotificationRow(existing)
      : undefined;
    if (existingRecord) {
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
    const notification = row ? tryReadNotificationRow(row) : undefined;
    if (notification) {
      publishNotificationEvent({
        id,
        action: 'read',
        notification,
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
    const notification = row ? tryReadNotificationRow(row) : undefined;
    if (notification) {
      publishNotificationEvent({
        id,
        action: 'resolved',
        notification,
        changedAt: now,
      });
    }
  } finally {
    database.close();
  }
}

export function readNotificationRow(
  row: Record<string, SQLOutputValue>,
): NotificationRecord {
  const record = parseRow(row, notificationRowSchema, 'Invalid notification');
  return {
    id: record.id,
    level: record.level,
    title: record.title,
    message: record.message,
    source: record.source,
    sourceId: record.source_id,
    data:
      record.data_json !== null
        ? v.parse(appStateJsonValueSchema, JSON.parse(record.data_json))
        : null,
    readAt: record.read_at,
    resolvedAt: record.resolved_at,
    occurrenceCount: record.occurrence_count ?? 1,
    createdAt: record.created_at,
    updatedAt: record.updated_at ?? record.created_at,
  };
}

function safeNotificationRow(row: Record<string, SQLOutputValue>) {
  const notification = tryReadNotificationRow(row);
  return notification ? [notification] : [];
}

export function tryReadNotificationRow(
  row: Record<string, SQLOutputValue>,
): NotificationRecord | undefined {
  try {
    return readNotificationRow(row);
  } catch {
    return undefined;
  }
}
