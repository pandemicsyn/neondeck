import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppDbMigrationError,
  appDbMigrationsFolder,
  applyAppDbMigrations,
  createAppDbBackup,
  listAppDbBackups,
  readAppDbMigrationFiles,
  readAppDbMigrationStatus,
  restoreAppDbBackup,
  setAppDbRestoreReplacementHookForTests,
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

  it('retains the newest two pre-migration backup sets', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrations = join(root, 'migrations');
    const backups = join(root, 'backups');
    await writeMigration(
      migrations,
      '20260819000000_create_widgets',
      'CREATE TABLE widgets (id INTEGER PRIMARY KEY);',
    );
    applyAppDbMigrations(databasePath, { migrationsFolder: migrations });

    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, 'unrelated.db'), 'keep');
    await writeFile(join(backups, 'neondeck-personal.db'), 'keep');
    await writeFile(join(backups, 'notes.txt'), 'keep');

    const backupPaths: string[] = [];
    for (const [index, now] of [
      new Date('2026-08-19T10:00:00.000Z'),
      new Date('2026-08-19T11:00:00.000Z'),
      new Date('2026-08-19T12:00:00.000Z'),
    ].entries()) {
      await writeMigration(
        migrations,
        `2026081900000${index + 1}_add_widget_column`,
        `ALTER TABLE widgets ADD COLUMN value_${index} TEXT;`,
      );
      const { backupPath } = applyAppDbMigrations(databasePath, {
        migrationsFolder: migrations,
        now,
      });
      expect(backupPath).not.toBeNull();
      backupPaths.push(backupPath!);
      await writeFile(`${backupPath}-wal`, 'wal sidecar');
      await writeFile(`${backupPath}-shm`, 'shm sidecar');
    }

    const [oldest = '', secondNewest = '', newest = ''] = backupPaths.map(
      (path) => basename(path),
    );
    const backupNames = (await readdir(backups)).sort();
    expect(backupNames).toEqual(
      [
        'unrelated.db',
        'neondeck-personal.db',
        'notes.txt',
        secondNewest,
        `${secondNewest}-wal`,
        `${secondNewest}-shm`,
        newest,
        `${newest}-wal`,
        `${newest}-shm`,
      ].sort(),
    );
    expect(backupNames).not.toContain(oldest);
    expect(
      (await readdir(backups)).filter((name) => /^neondeck-.+\.db$/.test(name)),
    ).toHaveLength(3);
    expect(listAppDbBackups(databasePath).map((backup) => backup.name)).toEqual(
      [newest, secondNewest],
    );
  });

  it('captures WAL-resident state in a standalone pre-migration snapshot', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrations = join(root, 'migrations');
    await writeMigration(
      migrations,
      '20260819000000_create_restore_values',
      'CREATE TABLE restore_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    );
    applyAppDbMigrations(databasePath, { migrationsFolder: migrations });

    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec('PRAGMA journal_mode = WAL;');
      writer.exec('PRAGMA wal_autocheckpoint = 0;');
      writer
        .prepare('INSERT INTO restore_values (id, value) VALUES (1, ?);')
        .run('only in the WAL');
      expect(existsSync(`${databasePath}-wal`)).toBe(true);

      await writeMigration(
        migrations,
        '20260819000001_add_restore_note',
        'ALTER TABLE restore_values ADD COLUMN note TEXT;',
      );
      const { backupPath } = applyAppDbMigrations(databasePath, {
        migrationsFolder: migrations,
      });
      expect(backupPath).not.toBeNull();
      expect(existsSync(`${backupPath!}-wal`)).toBe(false);
      expect(existsSync(`${backupPath!}-shm`)).toBe(false);

      const snapshot = new DatabaseSync(backupPath!, { readOnly: true });
      try {
        expect(
          snapshot
            .prepare('SELECT value FROM restore_values WHERE id = 1;')
            .get(),
        ).toEqual({ value: 'only in the WAL' });
      } finally {
        snapshot.close();
      }
    } finally {
      writer.close();
    }
  });

  it('creates a consistent manual backup and restores it with a safety backup', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    applyAppDbMigrations(databasePath);
    setRestoreValue(databasePath, 'before backup');

    const backup = await createAppDbBackup(databasePath, {
      now: new Date('2026-08-19T13:00:00.000Z'),
    });
    expect(backup).toMatchObject({ ok: true, action: 'db_backup' });
    expect(backup.backup).toMatchObject({ kind: 'manual', walBytes: null });
    setRestoreValue(databasePath, 'after backup');

    const restored = await restoreAppDbBackup(
      databasePath,
      backup.backup!.name,
    );
    expect(restored).toMatchObject({
      ok: true,
      action: 'db_restore',
      restoredBackup: { name: backup.backup!.name },
      safetyBackup: { kind: 'restore-safety' },
    });
    expect(readRestoreValue(databasePath)).toBe('before backup');
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    expect(listAppDbBackups(databasePath)).toHaveLength(2);
  });

  it('refuses unreadable backup candidates without changing the live database', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    applyAppDbMigrations(databasePath);
    setRestoreValue(databasePath, 'live value');
    const backups = join(root, 'backups');
    await mkdir(backups, { recursive: true });
    const invalid = 'neondeck-2026-08-19T140000Z-manual.db';
    await writeFile(join(backups, invalid), 'not a sqlite database');

    const restored = await restoreAppDbBackup(databasePath, invalid);

    expect(restored).toMatchObject({ ok: false, action: 'db_restore' });
    expect(restored.message).toContain('not readable');
    expect(readRestoreValue(databasePath)).toBe('live value');
  });

  it('preserves the selected backup when atomic replacement fails', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    applyAppDbMigrations(databasePath);
    setRestoreValue(databasePath, 'before backup');
    const backup = await createAppDbBackup(databasePath, {
      now: new Date('2026-08-19T15:00:00.000Z'),
    });
    setRestoreValue(databasePath, 'live value');
    const restoreReplacement = setAppDbRestoreReplacementHookForTests(() => {
      throw new Error('simulated replacement failure');
    });

    try {
      const restored = await restoreAppDbBackup(
        databasePath,
        backup.backup!.name,
      );
      expect(restored).toMatchObject({ ok: false, action: 'db_restore' });
    } finally {
      restoreReplacement();
    }

    expect(readRestoreValue(databasePath)).toBe('live value');
    expect(listAppDbBackups(databasePath).map((item) => item.name)).toEqual([
      backup.backup!.name,
    ]);
  });

  it('reports a successful restore when only retention cleanup fails', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    applyAppDbMigrations(databasePath);
    setRestoreValue(databasePath, 'backup value');
    const backup = await createAppDbBackup(databasePath, {
      now: new Date('2026-08-19T10:00:00.000Z'),
    });
    setRestoreValue(databasePath, 'live value');

    const backups = join(root, 'backups');
    const cleanupFailure = join(
      backups,
      'neondeck-2026-08-19T110000Z-manual.db',
    );
    const retained = join(backups, 'neondeck-2026-08-19T120000Z-manual.db');
    await utimes(
      backup.backup!.path,
      new Date('2020-08-19T10:00:00.000Z'),
      new Date('2020-08-19T10:00:00.000Z'),
    );
    await cp(backup.backup!.path, cleanupFailure);
    await utimes(
      cleanupFailure,
      new Date('2020-08-19T11:00:00.000Z'),
      new Date('2020-08-19T11:00:00.000Z'),
    );
    await mkdir(`${cleanupFailure}-wal`);
    await writeFile(join(`${cleanupFailure}-wal`, 'keep'), 'keep');
    await cp(backup.backup!.path, retained);
    await utimes(
      retained,
      new Date('2020-08-19T12:00:00.000Z'),
      new Date('2020-08-19T12:00:00.000Z'),
    );

    const restored = await restoreAppDbBackup(
      databasePath,
      backup.backup!.name,
    );

    expect(restored).toMatchObject({
      ok: true,
      changed: true,
      action: 'db_restore',
      warnings: [expect.stringContaining('retention cleanup failed')],
    });
    expect(readRestoreValue(databasePath)).toBe('backup value');
  });

  it('refuses restore while a WAL reader holds a live snapshot', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    applyAppDbMigrations(databasePath);
    setRestoreValue(databasePath, 'live value');
    const backup = await createAppDbBackup(databasePath);
    const lock = new DatabaseSync(databasePath, { timeout: 0 });
    lock.exec('PRAGMA journal_mode = WAL;');
    lock.exec('BEGIN;');
    lock.prepare('SELECT COUNT(*) FROM sqlite_master;').get();

    try {
      const restored = await restoreAppDbBackup(
        databasePath,
        backup.backup!.name,
      );
      expect(restored).toMatchObject({ ok: false, action: 'db_restore' });
      expect(restored.message).toContain('exclusively lock');
    } finally {
      lock.exec('ROLLBACK;');
      lock.close();
    }

    expect(readRestoreValue(databasePath)).toBe('live value');
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-migrate-'));
  tempRoots.push(path);
  return path;
}

async function writeMigration(root: string, name: string, sql: string) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'migration.sql'), sql);
}

function setRestoreValue(databasePath: string, value: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      'CREATE TABLE IF NOT EXISTS restore_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    );
    database
      .prepare(
        'INSERT INTO restore_values (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value;',
      )
      .run(value);
  } finally {
    database.close();
  }
}

function readRestoreValue(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return String(
      (
        database
          .prepare('SELECT value FROM restore_values WHERE id = 1;')
          .get() as { value: unknown }
      ).value,
    );
  } finally {
    database.close();
  }
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
