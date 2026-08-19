import { existsSync } from 'node:fs';
import {
  enableWal,
  openDb,
  withImmediateTransaction,
} from '../../lib/sqlite.ts';
import { applyAppDbMigrations } from './migrate.ts';
import {
  reconcileActiveChatSession,
  reconcileActiveWorktreeLocks,
  reconcileExistingNotificationDuplicates,
  prunePrReviewWorkspaceOutputs,
  pruneExpiredSubmittedPrReviewRows,
} from './reconcile.ts';

export function initializeAppDatabase(
  path: string,
  options: { onboardingPending?: boolean } = {},
) {
  const onboardingPending = options.onboardingPending ?? !existsSync(path);
  applyAppDbMigrations(path);
  const database = enableWal(openDb(path));
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
    pruneExpiredSubmittedPrReviewRows(database);
    prunePrReviewWorkspaceOutputs(database);

    withImmediateTransaction(database, () => {
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

      if (onboardingPending) {
        database
          .prepare(
            `
            INSERT INTO chat_session_audit (
              action,
              session_id,
              surface,
              reason,
              created_at
            )
            SELECT
              'onboarding_pending',
              'neondeck-main',
              'dashboard',
              'new-runtime-database',
              ?
            WHERE EXISTS (
              SELECT 1
              FROM chat_sessions
              WHERE id = 'neondeck-main'
            )
              AND NOT EXISTS (
                SELECT 1
                FROM chat_session_audit
                WHERE session_id = 'neondeck-main'
                  AND action = 'onboarding_pending'
            );
          `,
          )
          .run(now);
      }

      reconcileActiveChatSession(database);
    });
  } finally {
    database.close();
  }
}

export function initializeFlueDatabase(path: string) {
  const database = openDb(path);
  database.close();
}
