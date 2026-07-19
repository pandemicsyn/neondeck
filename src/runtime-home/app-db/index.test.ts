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
