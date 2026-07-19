import { DatabaseSync } from 'node:sqlite';

import { configureDb, enableWal } from '../../lib/sqlite.ts';
import { applyAppDbMigrations } from './migrate.ts';
import {
  reconcileActiveChatSession,
  reconcileActiveWorktreeLocks,
  reconcileExistingNotificationDuplicates,
} from './reconcile.ts';

export function initializeAppDatabase(path: string) {
  applyAppDbMigrations(path);
  const database = enableWal(configureDb(new DatabaseSync(path)));
  const now = new Date().toISOString();

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

    database
      .prepare(
        `
        INSERT INTO chat_sessions (
          id,
          title,
          agent_name,
          kind,
          pinned,
          created_at,
          updated_at,
          last_active_at,
          context_loaded_at,
          context_memory_ids_json
        )
        SELECT
          'neondeck-main',
          'Primary',
          'display-assistant',
          'main',
          1,
          ?,
          ?,
          ?,
          ?,
          '[]'
        WHERE NOT EXISTS (
          SELECT 1
          FROM chat_sessions
          WHERE agent_name = 'display-assistant'
            AND archived_at IS NULL
        );
      `,
      )
      .run(now, now, now, now);

    reconcileActiveChatSession(database);
  } finally {
    database.close();
  }
}

export function initializeFlueDatabase(path: string) {
  const database = configureDb(new DatabaseSync(path));
  database.close();
}
