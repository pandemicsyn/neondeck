import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { RuntimePaths } from '../../runtime-home';
import type { RuntimeStatus } from './status-schema';

type AppDatabaseSnapshot = {
  ok: boolean;
  message: string;
  counts: {
    activeJobs: number;
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
  if (!existsSync(paths.neondeckDatabase)) {
    return emptyDatabaseSnapshot('Neondeck app database is missing.');
  }

  const cutoff = new Date(Date.now() - flueFailureWindowMs).toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

  try {
    const activeJobs = count(
      database,
      'SELECT COUNT(*) AS count FROM jobs WHERE enabled = 1;',
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
      counts: {
        activeJobs,
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
    );
  } finally {
    database.close();
  }
}

export function inspectFlueDatabase(paths: RuntimePaths) {
  if (!existsSync(paths.flueDatabase)) {
    return { ok: false, message: 'Flue runtime database is missing.' };
  }

  const database = new DatabaseSync(paths.flueDatabase, { readOnly: true });

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

function emptyDatabaseSnapshot(message: string): AppDatabaseSnapshot {
  return {
    ok: false,
    message,
    counts: {
      activeJobs: 0,
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
  const row = database.prepare(sql).get(...values) as
    { count?: unknown } | undefined;
  return Number(row?.count ?? 0);
}

function readWorkflowErrorRow(row: unknown) {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    source: 'workflow-summary' as const,
    title: String(record.workflow),
    message: workflowSummaryMessage(record.summary_json, record.workflow),
    runId: typeof record.run_id === 'string' ? record.run_id : null,
    createdAt: String(record.created_at),
  };
}

function readNotificationErrorRow(row: unknown) {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    source: 'notification' as const,
    title: String(record.title),
    message: String(record.message),
    runId: typeof record.source_id === 'string' ? record.source_id : null,
    createdAt: String(record.created_at),
  };
}

function workflowSummaryMessage(summaryJson: unknown, workflow: unknown) {
  if (typeof summaryJson === 'string') {
    try {
      const summary = JSON.parse(summaryJson) as unknown;
      if (
        summary &&
        typeof summary === 'object' &&
        !Array.isArray(summary) &&
        typeof (summary as { message?: unknown }).message === 'string'
      ) {
        return (summary as { message: string }).message;
      }
    } catch {
      return `${String(workflow)} failed.`;
    }
  }

  return `${String(workflow)} failed.`;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
