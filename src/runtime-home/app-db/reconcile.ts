import type { DatabaseSync } from 'node:sqlite';

export function reconcileActiveChatSession(database: DatabaseSync) {
  const active = database
    .prepare(
      `
      SELECT session_id
      FROM chat_session_surfaces
      WHERE surface = 'dashboard'
      LIMIT 1;
    `,
    )
    .get() as { session_id?: unknown } | undefined;

  if (typeof active?.session_id === 'string') {
    const row = database
      .prepare(
        `
        SELECT id
        FROM chat_sessions
        WHERE id = ?
          AND archived_at IS NULL;
      `,
      )
      .get(active.session_id);
    if (row) return;
  }

  const fallback = database
    .prepare(
      `
      SELECT id
      FROM chat_sessions
      WHERE archived_at IS NULL
      ORDER BY pinned DESC, last_active_at DESC, created_at DESC
      LIMIT 1;
    `,
    )
    .get() as { id?: unknown } | undefined;

  if (typeof fallback?.id !== 'string') return;
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
    .run(fallback.id);
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
    .all() as Array<{
    source: string;
    source_id: string;
    count: number;
  }>;

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
      .all(group.source, group.source_id) as Array<{ id: string }>;
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
    .all() as Array<{ scope_key: string; count: number }>;

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
      .all(group.scope_key) as Array<{ id: string }>;
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
