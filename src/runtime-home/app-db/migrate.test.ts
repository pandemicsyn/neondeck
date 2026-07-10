import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppDbMigrationError,
  applyAppDbMigrations,
  readAppDbMigrationFiles,
  readAppDbMigrationStatus,
} from './migrate.ts';

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('app database migrator', () => {
  it('applies the fresh baseline to an empty database', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrations = readAppDbMigrationFiles();
    expect(applyAppDbMigrations(databasePath)).toMatchObject({
      applied: migrations.map((migration) => migration.name),
      backupPath: null,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(tableExists(database, 'notifications')).toBe(true);
    } finally {
      database.close();
    }
  });

  it('refuses an unjournaled non-empty pre-baseline database', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE old_state (id TEXT PRIMARY KEY);');
    database.close();
    expect(() => applyAppDbMigrations(databasePath)).toThrow(
      AppDbMigrationError,
    );
    expect(readAppDbMigrationStatus(databasePath)).toMatchObject({
      ok: false,
      message: 'App database has no Drizzle migration journal.',
    });
  });

  it('gives journaled pre-baseline databases the same reset instruction', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE __drizzle_migrations (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      );
    `);
    database
      .prepare(
        'INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES (?, ?, ?);',
      )
      .run('old-hash', 1, '20260704065926_baseline');
    database.close();

    expect(() => applyAppDbMigrations(databasePath)).toThrow(
      'This app database predates the current Neondeck baseline.',
    );
    expect(readAppDbMigrationStatus(databasePath).message).toContain(
      'predates the current Neondeck baseline',
    );
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-migrate-'));
  tempRoots.push(path);
  return path;
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(
    database
      .prepare(
        'SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1;',
      )
      .get('table', table),
  );
}
