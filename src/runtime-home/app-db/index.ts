import { DatabaseSync } from 'node:sqlite';

import {
  ensureColumn,
  migrateLegacyNeonSessions,
  migrateMemoriesRepoIdentity,
  migrateMemoryEvents,
} from './migrations.ts';
import {
  reconcileActiveChatSession,
  reconcileActiveNeonSessions,
  reconcileActiveWorktreeLocks,
  reconcileExistingNotificationDuplicates,
} from './reconcile.ts';
import { appDatabaseIndexSql, appDatabaseSchemaSql } from './schema.ts';

export function initializeAppDatabase(path: string) {
  const database = new DatabaseSync(path);

  try {
    database.exec(appDatabaseSchemaSql);

    ensureColumn(database, 'repo_edit_events', 'worktree_id', 'TEXT');
    ensureColumn(database, 'repo_file_reads', 'worktree_id', 'TEXT');
    ensureColumn(database, 'kilo_tasks', 'lock_id', 'TEXT');
    ensureColumn(database, 'kilo_result_state', 'diff_fingerprint', 'TEXT');
    ensureColumn(
      database,
      'kilo_result_state',
      'verified_diff_fingerprint',
      'TEXT',
    );
    ensureColumn(database, 'notifications', 'resolved_at', 'TEXT');
    ensureColumn(database, 'notifications', 'updated_at', 'TEXT');
    ensureColumn(
      database,
      'notifications',
      'occurrence_count',
      'INTEGER NOT NULL DEFAULT 1',
    );
    ensureColumn(database, 'chat_sessions', 'context_loaded_at', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'summary_generated_at', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'summary_source', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'summary_refresh_note', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'context_memory_ids_json', 'TEXT');
    ensureColumn(
      database,
      'chat_sessions',
      'learning_turn_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(
      database,
      'chat_sessions',
      'last_learning_review_turn_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(database, 'chat_sessions', 'last_learning_review_at', 'TEXT');
    ensureColumn(
      database,
      'chat_sessions',
      'last_learning_curation_turn_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(
      database,
      'chat_sessions',
      'last_learning_curation_at',
      'TEXT',
    );
    ensureColumn(database, 'memories', 'repo_id', 'TEXT');
    ensureColumn(
      database,
      'memories',
      'status',
      "TEXT NOT NULL DEFAULT 'active'",
    );
    ensureColumn(
      database,
      'memories',
      'use_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(database, 'memories', 'last_used_at', 'TEXT');
    migrateMemoriesRepoIdentity(database);
    migrateMemoryEvents(database);
    ensureColumn(database, 'learning_candidates', 'action', 'TEXT');
    ensureColumn(database, 'learning_reviews', 'flue_run_id', 'TEXT');
    database
      .prepare(
        `
        UPDATE notifications
        SET updated_at = created_at
        WHERE updated_at IS NULL;
      `,
      )
      .run();
    reconcileActiveWorktreeLocks(database);
    database.exec(appDatabaseIndexSql);
    reconcileExistingNotificationDuplicates(database);
    reconcileActiveNeonSessions(database);

    database
      .prepare(
        `
        INSERT INTO neon_sessions (
          id,
          label,
          agent_name,
          status,
          reason,
          created_at,
          activated_at,
          updated_at
        )
        SELECT
          'neondeck-main',
          'Primary',
          'display-assistant',
          'active',
          'initial-session',
          datetime('now'),
          datetime('now'),
          datetime('now')
        WHERE NOT EXISTS (
          SELECT 1
          FROM neon_sessions
          WHERE agent_name = 'display-assistant'
            AND status = 'active'
        );
      `,
      )
      .run();

    migrateLegacyNeonSessions(database);
    reconcileActiveChatSession(database);

    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('schema_version', '9', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run();
  } finally {
    database.close();
  }
}

export function initializeFlueDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.close();
}
