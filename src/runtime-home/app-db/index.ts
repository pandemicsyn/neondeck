import { DatabaseSync } from 'node:sqlite';

import { applyAppDbMigrations } from './migrate.ts';
import { migrateLegacyNeonSessions } from './migrations.ts';
import {
  reconcileActiveChatSession,
  reconcileActiveNeonSessions,
  reconcileActiveWorktreeLocks,
  reconcileExistingNotificationDuplicates,
} from './reconcile.ts';

export function initializeAppDatabase(path: string) {
  applyAppDbMigrations(path);
  const database = new DatabaseSync(path);

  try {
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
