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

  it('prunes expired retained PR review outputs during initialization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'neondeck-app-db-'));
    const databasePath = join(home, 'neondeck.db');
    try {
      initializeAppDatabase(databasePath);
      const database = openDb(databasePath);
      try {
        database
          .prepare(
            `INSERT INTO pr_review_workspace_outputs (
               output_ref, scope_key, source, payload, byte_size, line_count,
               created_at, expires_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          )
          .run(
            'expired-output',
            'review:expired',
            'diff',
            'payload',
            7,
            1,
            '2026-01-01T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z',
          );
      } finally {
        database.close();
      }

      initializeAppDatabase(databasePath);
      const after = openDb(databasePath, { readOnly: true });
      try {
        expect(
          after
            .prepare(
              `SELECT COUNT(*) AS count FROM pr_review_workspace_outputs;`,
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        after.close();
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
