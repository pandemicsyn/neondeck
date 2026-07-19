import { randomUUID } from 'node:crypto';
import { asJsonValue } from '../../lib/action-result';
import { openDb, rollbackQuietly } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import type {
  AutomationExecutionResult,
  NotificationRecord,
} from '../app-state';
import { upsertScheduledTask } from '../scheduled-tasks';
import type {
  DesiredTerminalState,
  PrWatch,
  PrWatchInitialWatermark,
  PrWatchSnapshot,
  PrWatchStatus,
  RefWatch,
  RefWatchSnapshot,
  RefWatchStatus,
  WatchOutcome,
} from './schemas';

export function insertWatch(
  paths: RuntimePaths,
  watch: PrWatch,
  initialWatermarks?: PrWatchInitialWatermark[],
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    try {
      database
        .prepare(
          `
        INSERT INTO pr_watches (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          pr_number,
          desired_terminal_state,
          status,
          pr_state,
          title,
          url,
          merge_commit_sha,
          last_snapshot_json,
          last_outcome,
          last_checked_at,
          created_by,
          process_existing,
          initial_event_processed_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
        )
        .run(...watchParams(watch));
      if (initialWatermarks) {
        upsertInitialEventWatermarks(
          database,
          watch.id,
          initialWatermarks,
          watch.initialEventProcessedAt ?? watch.updatedAt,
        );
      }
      database.exec('COMMIT;');
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

export function updateWatch(
  paths: RuntimePaths,
  watch: PrWatch,
  initialWatermarks?: PrWatchInitialWatermark[],
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN;');
    try {
      database
        .prepare(
          `
        UPDATE pr_watches
        SET
          repo_id = ?,
          repo_full_name = ?,
          github_owner = ?,
          github_name = ?,
          pr_number = ?,
          desired_terminal_state = ?,
          status = ?,
          pr_state = ?,
          title = ?,
          url = ?,
          merge_commit_sha = ?,
          last_snapshot_json = ?,
          last_outcome = ?,
          last_checked_at = ?,
          process_existing = ?,
          initial_event_processed_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
        )
        .run(
          watch.repoId,
          watch.repoFullName,
          watch.githubOwner,
          watch.githubName,
          watch.prNumber,
          watch.desiredTerminalState,
          watch.status,
          watch.prState,
          watch.title,
          watch.url,
          watch.mergeCommitSha,
          watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
          watch.lastOutcome,
          watch.lastCheckedAt,
          watch.processExisting ? 1 : 0,
          watch.initialEventProcessedAt,
          watch.updatedAt,
          watch.id,
        );
      if (initialWatermarks) {
        upsertInitialEventWatermarks(
          database,
          watch.id,
          initialWatermarks,
          watch.initialEventProcessedAt ?? watch.updatedAt,
        );
      }
      database.exec('COMMIT;');
    } catch (error) {
      rollbackQuietly(database);
      throw error;
    }
  } finally {
    database.close();
  }
}

function upsertInitialEventWatermarks(
  database: ReturnType<typeof openDb>,
  watchId: string,
  watermarks: PrWatchInitialWatermark[],
  now: string,
) {
  for (const watermark of watermarks) {
    database
      .prepare(
        `
        INSERT INTO pr_watch_event_watermarks (
          watch_id,
          category,
          watermark_json,
          source_updated_at,
          checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(watch_id, category) DO UPDATE SET
          watermark_json = excluded.watermark_json,
          source_updated_at = excluded.source_updated_at,
          checked_at = excluded.checked_at,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        watchId,
        watermark.category,
        JSON.stringify(watermark.value),
        watermark.sourceUpdatedAt,
        now,
        now,
        now,
      );
  }
}

export function insertRefWatch(paths: RuntimePaths, watch: RefWatch) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO ref_watches (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          ref,
          status,
          title,
          url,
          last_snapshot_json,
          last_outcome,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(...refWatchParams(watch));
  } finally {
    database.close();
  }
}

export function updateRefWatch(paths: RuntimePaths, watch: RefWatch) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE ref_watches
        SET
          repo_id = ?,
          repo_full_name = ?,
          github_owner = ?,
          github_name = ?,
          ref = ?,
          status = ?,
          title = ?,
          url = ?,
          last_snapshot_json = ?,
          last_outcome = ?,
          last_checked_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        watch.repoId,
        watch.repoFullName,
        watch.githubOwner,
        watch.githubName,
        watch.ref,
        watch.status,
        watch.title,
        watch.url,
        watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
        watch.lastOutcome,
        watch.lastCheckedAt,
        watch.updatedAt,
        watch.id,
      );
  } finally {
    database.close();
  }
}

export function upsertWatchPollingTask(
  watch: PrWatch,
  paths: RuntimePaths,
  intervalSeconds = 300,
) {
  return upsertScheduledTask(
    {
      id: watchPollingTaskId(watch.id),
      spec: {
        kind: 'poll-pr-watch',
        watchId: watch.id,
      },
      trigger: {
        kind: 'interval',
        everySeconds: intervalSeconds,
      },
      enabled: true,
    },
    paths,
  );
}

export function watchPollingTaskId(id: string) {
  return `watch:${id}`;
}

export function readWatches(paths: RuntimePaths): PrWatch[] {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM pr_watches
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all()
      .map(readWatchRow);
  } finally {
    database.close();
  }
}

export function readWatch(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM pr_watches
        WHERE id = ?;
      `,
      )
      .get(id);

    return row ? readWatchRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function readRefWatches(paths: RuntimePaths): RefWatch[] {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM ref_watches
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all()
      .map(readRefWatchRow);
  } finally {
    database.close();
  }
}

export function readRefWatch(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM ref_watches
        WHERE id = ?;
      `,
      )
      .get(id);

    return row ? readRefWatchRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function deleteWatch(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare('DELETE FROM pr_watch_event_watermarks WHERE watch_id = ?;')
      .run(id);
    database.prepare('DELETE FROM pr_watches WHERE id = ?;').run(id);
  } finally {
    database.close();
  }
}

export function refWatchParams(watch: RefWatch) {
  return [
    watch.id,
    watch.repoId,
    watch.repoFullName,
    watch.githubOwner,
    watch.githubName,
    watch.ref,
    watch.status,
    watch.title,
    watch.url,
    watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
    watch.lastOutcome,
    watch.lastCheckedAt,
    watch.createdAt,
    watch.updatedAt,
  ];
}

export function watchParams(watch: PrWatch) {
  return [
    watch.id,
    watch.repoId,
    watch.repoFullName,
    watch.githubOwner,
    watch.githubName,
    watch.prNumber,
    watch.desiredTerminalState,
    watch.status,
    watch.prState,
    watch.title,
    watch.url,
    watch.mergeCommitSha,
    watch.lastSnapshot ? JSON.stringify(watch.lastSnapshot) : null,
    watch.lastOutcome,
    watch.lastCheckedAt,
    watch.createdBy,
    watch.processExisting ? 1 : 0,
    watch.initialEventProcessedAt,
    watch.createdAt,
    watch.updatedAt,
  ];
}

export function readRefWatchRow(row: unknown): RefWatch {
  const record = row as Record<string, unknown>;
  const snapshot =
    typeof record.last_snapshot_json === 'string'
      ? (JSON.parse(record.last_snapshot_json) as RefWatchSnapshot)
      : null;

  return {
    id: String(record.id),
    repoId: String(record.repo_id),
    repoFullName: String(record.repo_full_name),
    githubOwner: String(record.github_owner),
    githubName: String(record.github_name),
    ref: String(record.ref),
    status: String(record.status) as RefWatchStatus,
    title: typeof record.title === 'string' ? String(record.title) : null,
    url: typeof record.url === 'string' ? String(record.url) : null,
    lastSnapshot: snapshot,
    lastOutcome:
      typeof record.last_outcome === 'string'
        ? (String(record.last_outcome) as WatchOutcome)
        : null,
    lastCheckedAt:
      typeof record.last_checked_at === 'string'
        ? String(record.last_checked_at)
        : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

export function readWatchRow(row: unknown): PrWatch {
  const record = row as Record<string, unknown>;
  const snapshot =
    typeof record.last_snapshot_json === 'string'
      ? (JSON.parse(record.last_snapshot_json) as PrWatchSnapshot)
      : null;

  return {
    id: String(record.id),
    repoId: String(record.repo_id),
    repoFullName: String(record.repo_full_name),
    githubOwner: String(record.github_owner),
    githubName: String(record.github_name),
    prNumber: Number(record.pr_number),
    desiredTerminalState: String(
      record.desired_terminal_state,
    ) as DesiredTerminalState,
    status: String(record.status) as PrWatchStatus,
    prState:
      typeof record.pr_state === 'string' ? String(record.pr_state) : null,
    title: typeof record.title === 'string' ? String(record.title) : null,
    url: typeof record.url === 'string' ? String(record.url) : null,
    mergeCommitSha:
      typeof record.merge_commit_sha === 'string'
        ? String(record.merge_commit_sha)
        : null,
    lastSnapshot: snapshot,
    lastOutcome:
      typeof record.last_outcome === 'string'
        ? (String(record.last_outcome) as WatchOutcome)
        : null,
    lastCheckedAt:
      typeof record.last_checked_at === 'string'
        ? String(record.last_checked_at)
        : null,
    createdBy:
      typeof record.created_by === 'string' ? String(record.created_by) : null,
    processExisting: record.process_existing === 1,
    initialEventProcessedAt:
      typeof record.initial_event_processed_at === 'string'
        ? record.initial_event_processed_at
        : null,
    createdAt: String(record.created_at),
    updatedAt: String(record.updated_at),
  };
}

export function markWatchInitialEventProcessed(
  paths: RuntimePaths,
  watchId: string,
  processedAt = new Date().toISOString(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return (
      database
        .prepare(
          `UPDATE pr_watches
           SET initial_event_processed_at = ?, updated_at = ?
           WHERE id = ? AND initial_event_processed_at IS NULL;`,
        )
        .run(processedAt, processedAt, watchId).changes === 1
    );
  } finally {
    database.close();
  }
}

export function persistInitialWatchNotificationAndMarkProcessed(
  paths: RuntimePaths,
  watchId: string,
  notification: NonNullable<AutomationExecutionResult['notifications']>[number],
  processedAt = new Date().toISOString(),
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const watch = database
        .prepare(
          `SELECT initial_event_processed_at
           FROM pr_watches
           WHERE id = ? AND initial_event_processed_at IS NULL;`,
        )
        .get(watchId);
      if (!watch) {
        database.exec('COMMIT;');
        return { processed: false, notification: null };
      }

      const source = notification.source ?? 'watch-pr-events';
      const sourceId = notification.sourceId ?? watchId;
      const existing = database
        .prepare(
          `SELECT id
           FROM notifications
           WHERE source = ? AND source_id = ? AND resolved_at IS NULL
           LIMIT 1;`,
        )
        .get(source, sourceId);
      let persistedNotification: NotificationRecord | null = null;
      if (!existing) {
        const id = randomUUID();
        const data =
          notification.data === undefined
            ? null
            : asJsonValue(notification.data);
        database
          .prepare(
            `INSERT INTO notifications (
               id, level, title, message, source, source_id, data_json,
               read_at, resolved_at, occurrence_count, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?);`,
          )
          .run(
            id,
            notification.level,
            notification.title,
            notification.message,
            source,
            sourceId,
            data === null ? null : JSON.stringify(data),
            processedAt,
            processedAt,
          );
        persistedNotification = {
          id,
          level: notification.level,
          title: notification.title,
          message: notification.message,
          source,
          sourceId,
          data,
          readAt: null,
          resolvedAt: null,
          occurrenceCount: 1,
          createdAt: processedAt,
          updatedAt: processedAt,
        };
      }
      database
        .prepare(
          `UPDATE pr_watches
           SET initial_event_processed_at = ?, updated_at = ?
           WHERE id = ? AND initial_event_processed_at IS NULL;`,
        )
        .run(processedAt, processedAt, watchId);
      database.exec('COMMIT;');
      return { processed: true, notification: persistedNotification };
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  } finally {
    database.close();
  }
}
