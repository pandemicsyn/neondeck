import { openDb } from '../../lib/sqlite.ts';
import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { RuntimePaths } from '../../runtime-home';
import {
  readAppDbMigrationStatus,
  type AppDbMigrationStatus,
} from '../../runtime-home/app-db/migrate';
import type { RuntimeStatus } from './status-schema';
import { runtimeErrorSchema, type RuntimeExternalValue } from './value-schemas';
import * as v from 'valibot';

const nullableTextColumnSchema = v.nullable(v.string());
const countRowSchema = v.object({ count: v.number() });
const workflowErrorRowSchema = v.object({
  id: v.string(),
  workflow: v.string(),
  run_id: nullableTextColumnSchema,
  summary_json: nullableTextColumnSchema,
  created_at: v.string(),
});
const notificationErrorRowSchema = v.object({
  id: v.string(),
  title: v.string(),
  message: v.string(),
  source_id: nullableTextColumnSchema,
  created_at: v.string(),
});
const workflowSummarySchema = v.object({ message: v.string() });

type AppDatabaseSnapshot = {
  ok: boolean;
  message: string;
  migrations: AppDbMigrationStatus;
  counts: {
    activeScheduledTasks: number;
    activeWatches: number;
    recentFailedWorkflowSummaries: number;
    unreadFlueFailureNotifications: number;
    activeWorktrees: number;
    staleWorktreeLocks: number;
    worktreeCleanupFailures: number;
  };
  errors: RuntimeStatus['lastFlueErrors'];
};

const flueFailureWindowMs = 24 * 60 * 60 * 1000;

export function inspectAppDatabase(paths: RuntimePaths): AppDatabaseSnapshot {
  const migrations = readAppDbMigrationStatus(paths.neondeckDatabase);
  if (!existsSync(paths.neondeckDatabase)) {
    return emptyDatabaseSnapshot(
      'Neondeck app database is missing.',
      migrations,
    );
  }

  const cutoff = new Date(Date.now() - flueFailureWindowMs).toISOString();
  const database = openDb(paths.neondeckDatabase, { readOnly: true });

  try {
    const activeScheduledTasks = count(
      database,
      'SELECT COUNT(*) AS count FROM scheduled_tasks WHERE enabled = 1;',
    );
    const activeWatches = count(
      database,
      `
        SELECT
          (SELECT COUNT(*)
           FROM pr_watches
           WHERE status IN ('watching', 'merged', 'attention-needed')) +
          (SELECT COUNT(*)
           FROM ref_watches
           WHERE status IN ('watching', 'attention-needed')) AS count;
      `,
    );
    const recentFailedWorkflowSummaries = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM workflow_summaries
        WHERE status = 'failed'
          AND created_at >= ?;
      `,
      cutoff,
    );
    const unreadFlueFailureNotifications = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE source = 'flue'
          AND resolved_at IS NULL;
      `,
    );
    const activeWorktrees = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM worktrees
        WHERE lifecycle_status != 'deleted';
      `,
    );
    const staleWorktreeLocks = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM worktree_locks
        WHERE released_at IS NULL
          AND expires_at <= ?;
      `,
      new Date().toISOString(),
    );
    const worktreeCleanupFailures = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM worktree_cleanup_attempts
        WHERE outcome = 'failed';
      `,
    );
    const errors = [
      ...database
        .prepare(
          `
          SELECT id, workflow, run_id, summary_json, created_at
          FROM workflow_summaries
          WHERE status = 'failed'
            AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 5;
        `,
        )
        .all(cutoff)
        .map(readWorkflowErrorRow),
      ...database
        .prepare(
          `
          SELECT id, title, message, source_id, created_at
          FROM notifications
          WHERE source = 'flue'
            AND resolved_at IS NULL
          ORDER BY created_at DESC
          LIMIT 5;
        `,
        )
        .all()
        .map(readNotificationErrorRow),
    ]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 5);

    return {
      ok: true,
      message: 'Neondeck app database is readable.',
      migrations,
      counts: {
        activeScheduledTasks,
        activeWatches,
        recentFailedWorkflowSummaries,
        unreadFlueFailureNotifications,
        activeWorktrees,
        staleWorktreeLocks,
        worktreeCleanupFailures,
      },
      errors,
    };
  } catch (error) {
    return emptyDatabaseSnapshot(
      `Neondeck app database could not be inspected: ${errorMessage(error)}.`,
      migrations,
    );
  } finally {
    database.close();
  }
}

export function inspectFlueDatabase(paths: RuntimePaths) {
  if (!existsSync(paths.flueDatabase)) {
    return { ok: false, message: 'Flue runtime database is missing.' };
  }

  const database = openDb(paths.flueDatabase, { readOnly: true });

  try {
    database.prepare('SELECT name FROM sqlite_master LIMIT 1;').get();
    return { ok: true, message: 'Flue runtime database is readable.' };
  } catch (error) {
    return {
      ok: false,
      message: `Flue runtime database could not be inspected: ${errorMessage(error)}.`,
    };
  } finally {
    database.close();
  }
}

function emptyDatabaseSnapshot(
  message: string,
  migrations: AppDbMigrationStatus,
): AppDatabaseSnapshot {
  return {
    ok: false,
    message,
    migrations,
    counts: {
      activeScheduledTasks: 0,
      activeWatches: 0,
      recentFailedWorkflowSummaries: 0,
      unreadFlueFailureNotifications: 0,
      activeWorktrees: 0,
      staleWorktreeLocks: 0,
      worktreeCleanupFailures: 0,
    },
    errors: [],
  };
}

function count(database: DatabaseSync, sql: string, ...values: string[]) {
  return v.parse(countRowSchema, database.prepare(sql).get(...values)).count;
}

function readWorkflowErrorRow(row: RuntimeExternalValue) {
  const record = v.parse(workflowErrorRowSchema, row);
  return {
    id: record.id,
    source: 'workflow-summary' as const,
    title: record.workflow,
    message: workflowSummaryMessage(record.summary_json, record.workflow),
    runId: record.run_id,
    createdAt: record.created_at,
  };
}

function readNotificationErrorRow(row: RuntimeExternalValue) {
  const record = v.parse(notificationErrorRowSchema, row);
  return {
    id: record.id,
    source: 'notification' as const,
    title: record.title,
    message: record.message,
    runId: record.source_id,
    createdAt: record.created_at,
  };
}

function workflowSummaryMessage(summaryJson: string | null, workflow: string) {
  if (summaryJson === null) return `${workflow} failed.`;
  try {
    const summary = v.safeParse(workflowSummarySchema, JSON.parse(summaryJson));
    return summary.success ? summary.output.message : `${workflow} failed.`;
  } catch {
    return `${workflow} failed.`;
  }
}

function errorMessage(error: RuntimeExternalValue) {
  const parsed = v.safeParse(runtimeErrorSchema, error);
  return parsed.success ? parsed.output.message : String(error);
}
