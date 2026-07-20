import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppDbMigrationError,
  appDbMigrationsFolder,
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
    expect(
      migrations.filter((migration) =>
        migration.name.includes('autopilot_engine_cleanup'),
      ),
    ).toHaveLength(1);
    expect(applyAppDbMigrations(databasePath)).toMatchObject({
      applied: migrations.map((migration) => migration.name),
      backupPath: null,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(tableExists(database, 'notifications')).toBe(true);
      expect(tableExists(database, 'briefing_profiles')).toBe(true);
      expect(tableExists(database, 'briefing_runs')).toBe(true);
      expect(tableExists(database, 'pr_watch_event_watermarks')).toBe(true);
      expect(tableExists(database, 'pr_watch_event_intakes')).toBe(false);
      expect(tableExists(database, 'autopilot_admissions')).toBe(false);
      expect(tableExists(database, 'autopilot_pr_owners')).toBe(false);
      expect(
        database
          .prepare('PRAGMA table_info(pr_watches);')
          .all()
          .map((column) => (column as { name: string }).name),
      ).not.toContain('event_generation_id');
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
  it('cleans an upgraded runtime home while preserving watch feedback state', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const oldMigrations = join(root, 'pre-cleanup-migrations');
    await mkdir(oldMigrations);
    for (const entry of await readdir(appDbMigrationsFolder())) {
      if (entry.includes('autopilot_engine_cleanup')) continue;
      await cp(
        join(appDbMigrationsFolder(), entry),
        join(oldMigrations, entry),
        { recursive: true },
      );
    }
    applyAppDbMigrations(databasePath, { migrationsFolder: oldMigrations });

    const before = new DatabaseSync(databasePath);
    try {
      before
        .prepare(
          `INSERT INTO pr_watches (
             id, repo_id, repo_full_name, github_owner, github_name, pr_number,
             desired_terminal_state, status, event_generation_id,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          'example/sample#7',
          'repo-1',
          'example/sample',
          'example',
          'sample',
          7,
          'merged',
          'watching',
          'obsolete-generation',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z',
        );
      before
        .prepare(
          `INSERT INTO pr_watch_event_watermarks (
             watch_id, category, watermark_json, source_updated_at,
             checked_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          'example/sample#7',
          'review_threads',
          '{"total":1,"items":[{"id":"thread-1","fingerprint":"sha256:complete"}]}',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z',
        );
      before
        .prepare(
          `INSERT INTO pr_watch_event_intakes (
             event_id, watch_id, event_generation_id, sequence,
             repo_full_name, pr_number, source, previous_watermarks_json,
             candidate_watermarks_json, changed_categories_json, status,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          'event:obsolete',
          'example/sample#7',
          'obsolete-generation',
          1,
          'example/sample',
          7,
          'poll',
          '{}',
          '{}',
          '[]',
          'pending',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z',
        );
    } finally {
      before.close();
    }

    expect(applyAppDbMigrations(databasePath)).toMatchObject({
      applied: [expect.stringContaining('autopilot_engine_cleanup')],
      pending: [],
      backupPath: expect.stringContaining('autopilot_engine_cleanup'),
    });

    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(tableExists(after, 'pr_watch_event_intakes')).toBe(false);
      expect(tableExists(after, 'autopilot_admissions')).toBe(false);
      expect(tableExists(after, 'autopilot_owner_fix_submissions')).toBe(false);
      expect(
        after
          .prepare(
            `SELECT id, process_existing, event_watermark_version
             FROM pr_watches WHERE id = ?;`,
          )
          .get('example/sample#7'),
      ).toEqual({
        id: 'example/sample#7',
        process_existing: 0,
        event_watermark_version: 2,
      });
      expect(
        after
          .prepare(
            `SELECT category, watermark_json
             FROM pr_watch_event_watermarks WHERE watch_id = ?;`,
          )
          .get('example/sample#7'),
      ).toEqual({
        category: 'review_threads',
        watermark_json:
          '{"total":1,"items":[{"id":"thread-1","fingerprint":"sha256:complete"}]}',
      });
      expect(readAppDbMigrationStatus(databasePath)).toMatchObject({
        ok: true,
        pending: [],
        unknown: [],
        changed: [],
      });
    } finally {
      after.close();
    }
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
