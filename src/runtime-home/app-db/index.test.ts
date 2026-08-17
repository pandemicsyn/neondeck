import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { defaultSqliteBusyTimeoutMs, openDb } from '../../lib/sqlite';
import { initializeAppDatabase } from './index';

describe('app database initialization', () => {
  it('enables WAL mode and configures the shared busy timeout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-app-db-'));
    const databasePath = join(home, 'neondeck.db');
    try {
      initializeAppDatabase(databasePath);
      const database = openDb(databasePath, { readOnly: true });
      try {
        expect(pragmaValue(database, 'journal_mode')).toBe('wal');
        expect(pragmaValue(database, 'busy_timeout')).toBe(
          defaultSqliteBusyTimeoutMs,
        );
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_session_audit WHERE action = 'onboarding_pending';`,
            )
            .get(),
        ).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('recovers pending onboarding after the database file becomes visible', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-app-db-'));
    const databasePath = join(home, 'neondeck.db');
    try {
      new DatabaseSync(databasePath).close();
      initializeAppDatabase(databasePath, { onboardingPending: true });

      const database = openDb(databasePath, { readOnly: true });
      try {
        expect(
          database
            .prepare(
              `SELECT action, session_id FROM chat_session_audit WHERE action = 'onboarding_pending';`,
            )
            .all(),
        ).toEqual([
          { action: 'onboarding_pending', session_id: 'neondeck-main' },
        ]);
      } finally {
        database.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function pragmaValue(database: DatabaseSync, pragma: string) {
  return Object.values(
    database.prepare(`PRAGMA ${pragma};`).get() as Record<string, unknown>,
  )[0];
}
