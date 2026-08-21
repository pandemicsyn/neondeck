import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';

const workspaceOutputRowSchema = v.object({
  output_ref: v.string(),
  byte_size: v.number(),
});
const sessionIdRowSchema = v.object({ session_id: v.string() });
const idRowSchema = v.object({ id: v.string() });
const notificationGroupRowSchema = v.object({
  source: v.string(),
  source_id: v.string(),
  count: v.number(),
});
const worktreeLockGroupRowSchema = v.object({
  scope_key: v.string(),
  count: v.number(),
});

export const submittedPrReviewRetentionMs = 14 * 24 * 60 * 60 * 1_000;
export const prReviewWorkspaceOutputGlobalMaxEntries = 96;
export const prReviewWorkspaceOutputGlobalMaxBytes = 128 * 1024 * 1024;

export function prunePrReviewWorkspaceOutputs(
  database: DatabaseSync,
  options: {
    now?: number;
    reserveEntries?: number;
    reserveBytes?: number;
  } = {},
) {
  const now = new Date(options.now ?? Date.now()).toISOString();
  const reserveEntries = options.reserveEntries ?? 0;
  const reserveBytes = options.reserveBytes ?? 0;
  let changes = Number(
    database
      .prepare(`DELETE FROM pr_review_workspace_outputs WHERE expires_at <= ?;`)
      .run(now).changes,
  );
  const rows = database
    .prepare(
      `SELECT output_ref, byte_size
       FROM pr_review_workspace_outputs
       ORDER BY created_at ASC, output_ref ASC;`,
    )
    .all()
    .map((row) => v.parse(workspaceOutputRowSchema, row));
  let retainedBytes = rows.reduce((total, row) => total + row.byte_size, 0);
  while (
    rows.length + reserveEntries > prReviewWorkspaceOutputGlobalMaxEntries ||
    retainedBytes + reserveBytes > prReviewWorkspaceOutputGlobalMaxBytes
  ) {
    const oldest = rows.shift();
    if (!oldest) break;
    changes += Number(
      database
        .prepare(
          `DELETE FROM pr_review_workspace_outputs WHERE output_ref = ?;`,
        )
        .run(oldest.output_ref).changes,
    );
    retainedBytes -= oldest.byte_size;
  }
  return changes;
}

export function pruneExpiredSubmittedPrReviewRows(
  database: DatabaseSync,
  now = Date.now(),
) {
  const cutoff = new Date(now - submittedPrReviewRetentionMs).toISOString();
  return database
    .prepare(
      `DELETE FROM pr_reviews
       WHERE status = 'submitted'
         AND submitted_at IS NOT NULL
         AND submitted_at < ?;`,
    )
    .run(cutoff).changes;
}

export function reconcileActiveChatSession(database: DatabaseSync) {
  const active = v.safeParse(
    sessionIdRowSchema,
    database
      .prepare(
        `
      SELECT session_id
      FROM chat_session_surfaces
      WHERE surface = 'dashboard'
      LIMIT 1;
    `,
      )
      .get(),
  );

  if (active.success) {
    const row = database
      .prepare(
        `
        SELECT id
        FROM chat_sessions
        WHERE id = ?
          AND archived_at IS NULL;
      `,
      )
      .get(active.output.session_id);
    if (row) return;
  }

  const fallback = v.safeParse(
    idRowSchema,
    database
      .prepare(
        `
      SELECT id
      FROM chat_sessions
      WHERE archived_at IS NULL
      ORDER BY pinned DESC, last_active_at DESC, created_at DESC
      LIMIT 1;
    `,
      )
      .get(),
  );

  if (!fallback.success) return;
  database
    .prepare(
      `
      INSERT INTO chat_session_surfaces (surface, session_id, updated_at)
      VALUES ('dashboard', ?, datetime('now'))
      ON CONFLICT(surface) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at;
    `,
    )
    .run(fallback.output.id);
}

export function reconcileExistingNotificationDuplicates(
  database: DatabaseSync,
) {
  const now = new Date().toISOString();
  const groups = database
    .prepare(
      `
      SELECT source, source_id, COUNT(*) AS count
      FROM notifications
      WHERE source IS NOT NULL
        AND source_id IS NOT NULL
        AND resolved_at IS NULL
      GROUP BY source, source_id
      HAVING COUNT(*) > 1;
    `,
    )
    .all()
    .map((row) => v.parse(notificationGroupRowSchema, row));

  for (const group of groups) {
    const rows = database
      .prepare(
        `
        SELECT id
        FROM notifications
        WHERE source = ?
          AND source_id = ?
          AND resolved_at IS NULL
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all(group.source, group.source_id)
      .map((row) => v.parse(idRowSchema, row));
    const [active, ...duplicates] = rows;
    if (!active || duplicates.length === 0) continue;

    database
      .prepare(
        `
        UPDATE notifications
        SET occurrence_count = MAX(occurrence_count, ?), updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(Number(group.count), now, active.id);

    const placeholders = duplicates.map(() => '?').join(', ');
    database
      .prepare(
        `
        UPDATE notifications
        SET resolved_at = ?, read_at = COALESCE(read_at, ?), updated_at = ?
        WHERE id IN (${placeholders});
      `,
      )
      .run(now, now, now, ...duplicates.map((row) => row.id));
  }
}

export function reconcileActiveWorktreeLocks(database: DatabaseSync) {
  const now = new Date().toISOString();
  const groups = database
    .prepare(
      `
      SELECT scope_key, COUNT(*) AS count
      FROM worktree_locks
      WHERE released_at IS NULL
      GROUP BY scope_key
      HAVING COUNT(*) > 1;
    `,
    )
    .all()
    .map((row) => v.parse(worktreeLockGroupRowSchema, row));

  for (const group of groups) {
    const rows = database
      .prepare(
        `
        SELECT id
        FROM worktree_locks
        WHERE scope_key = ?
          AND released_at IS NULL
        ORDER BY expires_at DESC, created_at DESC;
      `,
      )
      .all(group.scope_key)
      .map((row) => v.parse(idRowSchema, row));
    for (const row of rows.slice(1)) {
      database
        .prepare(
          `
          UPDATE worktree_locks
          SET released_at = ?, stale_recovered_at = ?, updated_at = ?
          WHERE id = ?
            AND released_at IS NULL;
        `,
        )
        .run(now, now, now, row.id);
    }
  }
}
