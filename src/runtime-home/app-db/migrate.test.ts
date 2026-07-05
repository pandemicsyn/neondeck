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
import { initializeLegacyAppDatabase } from './legacy-test-support.ts';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('app database migrator', () => {
  it('applies the baseline migration for a fresh database', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrations = readAppDbMigrationFiles();

    const result = applyAppDbMigrations(databasePath);

    expect(result).toMatchObject({
      applied: migrations.map((migration) => migration.name),
      backupPath: null,
      stampedBaseline: false,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(tableExists(database, 'notifications')).toBe(true);
      expect(readJournalNames(database)).toEqual(
        migrations.map((migration) => migration.name),
      );
    } finally {
      database.close();
    }
  });

  it('stamps an existing v9 database without executing the baseline over it', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrations = readAppDbMigrationFiles();
    const [baseline] = migrations;
    initializePrePendingMigrationAppDatabase(databasePath);

    const result = applyAppDbMigrations(databasePath, {
      now: new Date('2026-07-04T12:00:00Z'),
    });

    expect(result).toMatchObject({
      applied: migrations.slice(1).map((migration) => migration.name),
      stampedBaseline: true,
    });
    expect(result.backupPath).toContain(`pre-${baseline.name}.db`);
    expect(existsSync(result.backupPath ?? '')).toBe(true);
    const stamped = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readJournalNames(stamped)).toEqual(
        migrations.map((migration) => migration.name),
      );
      expect(indexExists(stamped, 'idx_memories_scope_key_repo')).toBe(true);
      expect(indexExists(stamped, 'idx_memories_active_scope')).toBe(true);
      expect(indexExists(stamped, 'idx_memory_events_changed')).toBe(true);
      expect(tableExists(stamped, 'pr_review_drafts')).toBe(true);
      expect(tableExists(stamped, 'github_pr_file_cache')).toBe(true);
    } finally {
      stamped.close();
    }
  });

  it('repairs indexes after pre-v9 legacy table rebuild shims before stamping', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    initializePrePendingMigrationAppDatabase(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP INDEX idx_memories_scope_key_repo;
        DROP INDEX idx_memories_active_scope;
        DROP INDEX idx_memory_events_changed;
        UPDATE app_metadata SET value = '8' WHERE key = 'schema_version';
      `);
    } finally {
      database.close();
    }

    const result = applyAppDbMigrations(databasePath);

    expect(result.stampedBaseline).toBe(true);
    expect(result.applied).toEqual(
      readAppDbMigrationFiles()
        .slice(1)
        .map((migration) => migration.name),
    );
    const stamped = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(indexExists(stamped, 'idx_memories_scope_key_repo')).toBe(true);
      expect(indexExists(stamped, 'idx_memories_active_scope')).toBe(true);
      expect(indexExists(stamped, 'idx_memory_events_changed')).toBe(true);
    } finally {
      stamped.close();
    }
  });

  it('repairs legacy v9 databases that predate MCP tables before stamping', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrations = readAppDbMigrationFiles();
    initializePrePendingMigrationAppDatabase(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        DROP TABLE mcp_tool_catalog;
        DROP TABLE mcp_tool_approvals;
        DROP TABLE mcp_tool_audit;
        DROP TABLE mcp_oauth_tokens;
        DROP TABLE mcp_oauth_logins;
        UPDATE app_metadata SET value = '9' WHERE key = 'schema_version';
      `);
    } finally {
      database.close();
    }

    const result = applyAppDbMigrations(databasePath);

    expect(result).toMatchObject({
      applied: migrations.slice(1).map((migration) => migration.name),
      stampedBaseline: true,
    });
    const stamped = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(readJournalNames(stamped)).toEqual(
        migrations.map((migration) => migration.name),
      );
      expect(tableExists(stamped, 'mcp_tool_catalog')).toBe(true);
      expect(tableExists(stamped, 'mcp_tool_approvals')).toBe(true);
      expect(tableExists(stamped, 'mcp_tool_audit')).toBe(true);
      expect(tableExists(stamped, 'mcp_oauth_tokens')).toBe(true);
      expect(tableExists(stamped, 'mcp_oauth_logins')).toBe(true);
      expect(indexExists(stamped, 'idx_mcp_tool_catalog_status')).toBe(true);
      expect(indexExists(stamped, 'idx_mcp_tool_approvals_pending')).toBe(true);
      expect(indexExists(stamped, 'idx_mcp_tool_audit_created')).toBe(true);
    } finally {
      stamped.close();
    }
  });

  it('refuses to open a database with unknown newer migrations', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    applyAppDbMigrations(databasePath);
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(
          `
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('future-hash', 4070908800000, '20990101000000_future', datetime('now'));
        `,
        )
        .run();
    } finally {
      database.close();
    }

    expect(() => applyAppDbMigrations(databasePath)).toThrow(
      /created by a newer package/i,
    );
  });

  it('reports current, pending, changed, and unknown migration status', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrationsFolder = await copyMigrations(root);
    const migrations = readAppDbMigrationFiles();
    const [baseline] = migrations;
    const head = migrations.at(-1) ?? baseline;
    applyAppDbMigrations(databasePath);

    expect(readAppDbMigrationStatus(databasePath)).toMatchObject({
      ok: true,
      pending: [],
      unknown: [],
      changed: [],
      localHead: head.name,
      journalHead: head.name,
      message: 'App database migration journal is current.',
    });

    await writeMigration(
      migrationsFolder,
      '20990101000000_add_marker',
      'CREATE TABLE migration_marker (id TEXT PRIMARY KEY);',
    );

    expect(
      readAppDbMigrationStatus(databasePath, { migrationsFolder }),
    ).toMatchObject({
      ok: false,
      pending: ['20990101000000_add_marker'],
      unknown: [],
      changed: [],
      localHead: '20990101000000_add_marker',
      journalHead: head.name,
      message: 'Database has pending migrations: 20990101000000_add_marker.',
    });

    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(
          `
          UPDATE __drizzle_migrations
          SET hash = 'changed-hash'
          WHERE name = ?;
        `,
        )
        .run(baseline.name);
      database
        .prepare(
          `
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('future-hash', 4070908800000, '20990101000000_future', datetime('now'));
        `,
        )
        .run();
    } finally {
      database.close();
    }

    const drift = readAppDbMigrationStatus(databasePath, { migrationsFolder });
    expect(drift.ok).toBe(false);
    expect(drift.unknown.map((row) => row.name)).toEqual([
      '20990101000000_future',
    ]);
    expect(drift.changed.map((row) => row.name)).toEqual([baseline.name]);
    expect(drift.message).toBe(
      'Database contains unknown migrations: 20990101000000_future.',
    );
  });

  it('returns structured status when an existing database path cannot be opened', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    await mkdir(databasePath);

    const status = readAppDbMigrationStatus(databasePath);

    expect(status).toMatchObject({
      ok: false,
      databasePath,
      applied: [],
      pending: [],
      unknown: [],
      changed: [],
      journalHead: null,
    });
    expect(status.message).toContain(
      'App database migration status could not be inspected:',
    );
  });

  it('creates and rotates backups before applying pending migrations', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrationsFolder = await copyMigrations(root);
    await writeMigration(
      migrationsFolder,
      '20990101000000_add_marker',
      'CREATE TABLE migration_marker (id TEXT PRIMARY KEY);',
    );
    applyAppDbMigrations(databasePath);
    await seedOldBackups(join(root, 'backups'));

    const result = applyAppDbMigrations(databasePath, {
      migrationsFolder,
      now: new Date('2026-07-04T13:00:00Z'),
    });

    expect(result.applied).toEqual(['20990101000000_add_marker']);
    expect(result.backupPath).toContain('pre-20990101000000_add_marker.db');
    expect(existsSync(result.backupPath ?? '')).toBe(true);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(tableExists(database, 'migration_marker')).toBe(true);
    } finally {
      database.close();
    }
    const backups = await readdir(join(root, 'backups'));
    expect(backups.filter((name) => name.endsWith('.db')).sort()).toHaveLength(
      5,
    );
  });

  it('rolls back failed pending migrations and leaves a backup on disk', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const migrationsFolder = await copyMigrations(root);
    await writeMigration(
      migrationsFolder,
      '20990101000000_add_marker',
      'CREATE TABLE migration_marker (id TEXT PRIMARY KEY);',
    );
    await writeMigration(
      migrationsFolder,
      '20990101000100_bad_sql',
      'CREATE TABLE broken_marker (id TEXT PRIMARY KEY',
    );
    applyAppDbMigrations(databasePath);

    let error: unknown;
    try {
      applyAppDbMigrations(databasePath, {
        migrationsFolder,
        now: new Date('2026-07-04T14:00:00Z'),
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AppDbMigrationError);
    expect((error as AppDbMigrationError).details.backupPath).toContain(
      'pre-20990101000000_add_marker.db',
    );
    expect(
      existsSync((error as AppDbMigrationError).details.backupPath ?? ''),
    ).toBe(true);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(tableExists(database, 'migration_marker')).toBe(false);
      expect(readJournalNames(database)).not.toContain(
        '20990101000000_add_marker',
      );
      expect(readJournalNames(database)).not.toContain(
        '20990101000100_bad_sql',
      );
    } finally {
      database.close();
    }
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-migrate-'));
  tempRoots.push(path);
  return path;
}

function initializePrePendingMigrationAppDatabase(path: string) {
  initializeLegacyAppDatabase(path);
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      DROP TABLE IF EXISTS github_pr_file_cache;
      DROP TABLE IF EXISTS pr_review_draft_comments;
      DROP TABLE IF EXISTS pr_review_drafts;
      DROP TABLE IF EXISTS chat_session_command_events;
    `);
  } finally {
    database.close();
  }
}

async function copyMigrations(root: string) {
  const target = join(root, 'migrations');
  await cp(appDbMigrationsFolder(), target, { recursive: true });
  return target;
}

async function writeMigration(root: string, name: string, sql: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'migration.sql'), sql);
}

async function seedOldBackups(backupsDir: string) {
  await mkdir(backupsDir, { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    const path = join(backupsDir, `neondeck-old-${index}.db`);
    await writeFile(path, 'old');
    const date = new Date(Date.UTC(2026, 0, index + 1));
    await utimes(path, date, date);
  }
}

function tableExists(database: DatabaseSync, table: string) {
  return Boolean(
    database
      .prepare(
        `
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ?
        LIMIT 1;
      `,
      )
      .get(table),
  );
}

function indexExists(database: DatabaseSync, index: string) {
  return Boolean(
    database
      .prepare(
        `
        SELECT 1
        FROM sqlite_master
        WHERE type = 'index'
          AND name = ?
        LIMIT 1;
      `,
      )
      .get(index),
  );
}

function readJournalNames(database: DatabaseSync) {
  return database
    .prepare(
      `
      SELECT name
      FROM __drizzle_migrations
      ORDER BY created_at, id;
    `,
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));
}
