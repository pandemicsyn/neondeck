import { DatabaseSync } from 'node:sqlite';

export function migrateLegacyNeonSessions(database: DatabaseSync) {
  database
    .prepare(
      `
      INSERT INTO chat_sessions (
        id,
        title,
        agent_name,
        kind,
        pinned,
        archived_at,
        ui_metadata_json,
        created_at,
        updated_at,
        context_loaded_at,
        context_memory_ids_json,
        last_active_at
      )
      SELECT
        id,
        label,
        agent_name,
        CASE WHEN id = 'neondeck-main' THEN 'main' ELSE 'scratch' END,
        CASE WHEN id = 'neondeck-main' THEN 1 ELSE 0 END,
        ended_at,
        json_object('legacyReason', reason),
        created_at,
        updated_at,
        activated_at,
        '[]',
        activated_at
      FROM neon_sessions
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_sessions WHERE chat_sessions.id = neon_sessions.id
      );
    `,
    )
    .run();

  database
    .prepare(
      `
      UPDATE chat_sessions
      SET
        context_loaded_at = COALESCE(
          context_loaded_at,
          (
            SELECT activated_at
            FROM neon_sessions
            WHERE neon_sessions.id = chat_sessions.id
          ),
          created_at
        ),
        archived_at = (
          SELECT ended_at
          FROM neon_sessions
          WHERE neon_sessions.id = chat_sessions.id
        ),
        updated_at = (
          SELECT updated_at
          FROM neon_sessions
          WHERE neon_sessions.id = chat_sessions.id
        )
      WHERE EXISTS (
        SELECT 1
        FROM neon_sessions
        WHERE neon_sessions.id = chat_sessions.id
      );
    `,
    )
    .run();

  database
    .prepare(
      `
      UPDATE chat_sessions
      SET context_loaded_at = COALESCE(context_loaded_at, created_at);
    `,
    )
    .run();

  database
    .prepare(
      `
      INSERT OR IGNORE INTO chat_session_surfaces (surface, session_id, updated_at)
      SELECT 'dashboard', id, datetime('now')
      FROM chat_sessions
      WHERE archived_at IS NULL
      ORDER BY last_active_at DESC, created_at DESC
      LIMIT 1;
    `,
    )
    .run();
}

export function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
) {
  const columns = database
    .prepare(`PRAGMA table_info(${table});`)
    .all() as Array<{ name?: unknown }>;
  if (columns.some((item) => item.name === column)) {
    return;
  }

  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

export function migrateMemoriesRepoIdentity(database: DatabaseSync) {
  const table = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'memories';
    `,
    )
    .get() as { sql?: unknown } | undefined;
  const sql = typeof table?.sql === 'string' ? table.sql : '';
  if (!/UNIQUE\s*\(\s*scope\s*,\s*key\s*\)/i.test(sql)) return;

  database.exec(`
    DROP TABLE IF EXISTS memories_repo_identity_migration;

    CREATE TABLE memories_repo_identity_migration (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      repo_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO memories_repo_identity_migration (
      id,
      scope,
      key,
      value_json,
      repo_id,
      status,
      use_count,
      last_used_at,
      created_at,
      updated_at
    )
    SELECT
      id,
      scope,
      key,
      value_json,
      repo_id,
      COALESCE(status, 'active'),
      COALESCE(use_count, 0),
      last_used_at,
      created_at,
      updated_at
    FROM memories;

    DROP TABLE memories;
    ALTER TABLE memories_repo_identity_migration RENAME TO memories;
  `);
}

export function migrateMemoryEvents(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(memory_events);')
    .all() as Array<{ name?: unknown; type?: unknown }>;
  const id = columns.find((item) => item.name === 'id');
  const hasCreatedAt = columns.some((item) => item.name === 'created_at');
  if (String(id?.type ?? '').toUpperCase() === 'TEXT' && hasCreatedAt) {
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_events_v2 (
      id TEXT PRIMARY KEY,
      memory_id TEXT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO memory_events_v2 (
      id,
      memory_id,
      action,
      actor,
      reason,
      before_json,
      after_json,
      created_at
    )
    SELECT
      lower(hex(randomblob(4))) || '-' ||
        lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(6))),
      NULL,
      CASE
        WHEN action = 'upsert' THEN 'updated'
        WHEN action = 'delete' THEN 'archived'
        ELSE action
      END,
      'neon',
      NULL,
      NULL,
      CASE
        WHEN scope IS NOT NULL AND key IS NOT NULL THEN
          json_object('scope', scope, 'key', key)
        ELSE NULL
      END,
      COALESCE(changed_at, datetime('now'))
    FROM memory_events
    WHERE NOT EXISTS (
      SELECT 1
      FROM memory_events_v2
      WHERE memory_events_v2.id = CAST(memory_events.id AS TEXT)
    );

    DROP TABLE memory_events;
    ALTER TABLE memory_events_v2 RENAME TO memory_events;
  `);
}

