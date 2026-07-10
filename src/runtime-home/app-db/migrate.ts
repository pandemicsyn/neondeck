import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const drizzleMigrationsTable = '__drizzle_migrations';
const defaultMigrationsFolder = fileURLToPath(
  new URL('./migrations', import.meta.url),
);
const backupRetention = 5;

type DrizzleMigration = ReturnType<typeof readMigrationFiles>[number];

export type AppDbMigrationRecord = {
  id: number;
  hash: string;
  createdAt: number;
  name: string | null;
};

export type ApplyAppDbMigrationsResult = {
  applied: string[];
  pending: string[];
  backupPath: string | null;
};

export type AppDbMigrationStatus = {
  ok: boolean;
  databasePath: string;
  migrationsFolder: string;
  applied: AppDbMigrationRecord[];
  pending: string[];
  unknown: AppDbMigrationRecord[];
  changed: AppDbMigrationRecord[];
  localHead: string | null;
  journalHead: string | null;
  lastBackup: string | null;
  message: string;
};

export class AppDbMigrationError extends Error {
  constructor(
    message: string,
    readonly details: {
      migrationName?: string;
      backupPath?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'AppDbMigrationError';
    if (details.cause) this.cause = details.cause;
  }
}

export function appDbMigrationsFolder() {
  return defaultMigrationsFolder;
}

export function readAppDbMigrationStatus(
  databasePath: string,
  options: { migrationsFolder?: string } = {},
): AppDbMigrationStatus {
  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder;
  const migrations = readAppDbMigrationFiles(migrationsFolder);
  const localByName = new Map(
    migrations.map((migration) => [migration.name, migration]),
  );
  const localHead = migrations.at(-1)?.name ?? null;
  const lastBackup = latestBackupPath(dirname(databasePath));

  if (!existsSync(databasePath)) {
    return {
      ok: false,
      databasePath,
      migrationsFolder,
      applied: [],
      pending: migrations.map((migration) => migration.name),
      unknown: [],
      changed: [],
      localHead,
      journalHead: null,
      lastBackup,
      message: 'Neondeck app database is missing.',
    };
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    if (!tableExists(database, drizzleMigrationsTable)) {
      return {
        ok: false,
        databasePath,
        migrationsFolder,
        applied: [],
        pending: migrations.map((migration) => migration.name),
        unknown: [],
        changed: [],
        localHead,
        journalHead: null,
        lastBackup,
        message: 'App database has no Drizzle migration journal.',
      };
    }

    const applied = readJournal(database);
    const unknown = applied.filter(
      (row) => !row.name || !localByName.has(row.name),
    );
    const changed = applied.filter((row) => {
      const local = row.name ? localByName.get(row.name) : undefined;
      return Boolean(local && local.hash !== row.hash);
    });
    const appliedNames = new Set(
      applied
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string'),
    );
    const pending = migrations
      .filter((migration) => !appliedNames.has(migration.name))
      .map((migration) => migration.name);
    const journalHead = applied.at(-1)?.name ?? null;
    const ok =
      pending.length === 0 && unknown.length === 0 && changed.length === 0;

    return {
      ok,
      databasePath,
      migrationsFolder,
      applied,
      pending,
      unknown,
      changed,
      localHead,
      journalHead,
      lastBackup,
      message: ok
        ? 'App database migration journal is current.'
        : migrationStatusMessage({ pending, unknown, changed }),
    };
  } catch (error) {
    return {
      ok: false,
      databasePath,
      migrationsFolder,
      applied: [],
      pending: [],
      unknown: [],
      changed: [],
      localHead,
      journalHead: null,
      lastBackup,
      message: `App database migration status could not be inspected: ${errorMessage(error)}.`,
    };
  } finally {
    database?.close();
  }
}

export function applyAppDbMigrations(
  databasePath: string,
  options: { migrationsFolder?: string; now?: Date } = {},
): ApplyAppDbMigrationsResult {
  const migrations = readAppDbMigrationFiles(options.migrationsFolder);
  const database = new DatabaseSync(databasePath);
  let transactionOpen = false;
  let backupPath: string | null = null;
  let activeMigration: string | undefined;

  try {
    database.exec('PRAGMA busy_timeout = 5000;');
    database.exec('BEGIN IMMEDIATE;');
    transactionOpen = true;

    const localByName = new Map(
      migrations.map((migration) => [migration.name, migration]),
    );
    const journalExisted = tableExists(database, drizzleMigrationsTable);
    const userTablesBeforeJournal = listUserTables(database);
    if (journalExisted) {
      assertJournalMatchesLocalMigrations(readJournal(database), localByName);
    }

    if (!journalExisted) {
      if (userTablesBeforeJournal.length > 0) {
        throw new AppDbMigrationError(
          'This app database predates the current Neondeck baseline. Reset it instead of applying a pre-1.0 compatibility upgrade.',
        );
      }
      createJournalTable(database);
    }

    const appliedRows = readJournal(database);
    assertJournalMatchesLocalMigrations(appliedRows, localByName);

    const appliedNames = new Set(
      appliedRows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string'),
    );
    const pending = migrations.filter(
      (migration) => !appliedNames.has(migration.name),
    );
    const shouldBackupPending = journalExisted;

    if (pending.length > 0 && !backupPath && shouldBackupPending) {
      backupPath = backupDatabase(databasePath, pending[0].name, options.now);
    }

    for (const migration of pending) {
      activeMigration = migration.name;
      for (const statement of migration.sql) {
        if (statement.trim()) database.exec(statement);
      }
      insertJournalRow(database, migration);
    }

    database.exec('COMMIT;');
    transactionOpen = false;

    return {
      applied: pending.map((migration) => migration.name),
      pending: [],
      backupPath,
    };
  } catch (error) {
    if (transactionOpen) rollback(database);
    if (error instanceof AppDbMigrationError) throw error;
    const migrationText = activeMigration
      ? `Migration ${activeMigration} failed`
      : 'App database migration failed';
    const backupText = backupPath ? ` Backup: ${backupPath}.` : '';
    throw new AppDbMigrationError(
      `${migrationText}: ${errorMessage(error)}.${backupText}`,
      { migrationName: activeMigration, backupPath, cause: error },
    );
  } finally {
    database.close();
  }
}

export function readAppDbMigrationFiles(
  migrationsFolder = defaultMigrationsFolder,
) {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length === 0) {
    throw new AppDbMigrationError(
      `No app database migrations found in ${migrationsFolder}.`,
    );
  }
  return migrations;
}

function createJournalTable(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS "${drizzleMigrationsTable}" (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    );
  `);
}

function readJournal(database: DatabaseSync): AppDbMigrationRecord[] {
  if (!tableExists(database, drizzleMigrationsTable)) return [];
  return database
    .prepare(
      `
      SELECT id, hash, created_at, name
      FROM "${drizzleMigrationsTable}"
      ORDER BY created_at, id;
    `,
    )
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        id: Number(record.id),
        hash: String(record.hash),
        createdAt: Number(record.created_at),
        name: typeof record.name === 'string' ? record.name : null,
      };
    });
}

function assertJournalMatchesLocalMigrations(
  appliedRows: AppDbMigrationRecord[],
  localByName: Map<string, DrizzleMigration>,
) {
  const unknown = appliedRows.find(
    (row) => !row.name || !localByName.has(row.name),
  );
  if (unknown) {
    throw new AppDbMigrationError(
      `This Neondeck database was created by a newer package. Unknown app database migration: ${unknown.name ?? '(unnamed)'}. Upgrade Neondeck or restore a pre-migration backup.`,
      { migrationName: unknown.name ?? undefined },
    );
  }

  const changed = appliedRows.find((row) => {
    const local = row.name ? localByName.get(row.name) : undefined;
    return local && local.hash !== row.hash;
  });
  if (changed) {
    throw new AppDbMigrationError(
      `App database migration ${changed.name} has a different hash than the shipped migration. Refusing to open the database.`,
      { migrationName: changed.name ?? undefined },
    );
  }
}

function insertJournalRow(database: DatabaseSync, migration: DrizzleMigration) {
  database
    .prepare(
      `
      INSERT INTO "${drizzleMigrationsTable}" (hash, created_at, name, applied_at)
      VALUES (?, ?, ?, ?);
    `,
    )
    .run(
      migration.hash,
      migration.folderMillis,
      migration.name,
      new Date().toISOString(),
    );
}

function backupDatabase(
  databasePath: string,
  nextMigrationName: string,
  now = new Date(),
) {
  const backupsDir = join(dirname(databasePath), 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '');
  const backupPath = join(
    backupsDir,
    `neondeck-${stamp}-pre-${nextMigrationName}.db`,
  );
  copyIfExists(databasePath, backupPath);
  copyIfExists(`${databasePath}-wal`, `${backupPath}-wal`);
  copyIfExists(`${databasePath}-shm`, `${backupPath}-shm`);
  rotateBackups(backupsDir);
  return backupPath;
}

function rotateBackups(backupsDir: string) {
  const backups = readdirSync(backupsDir)
    .filter((name) => /^neondeck-.+\.db$/.test(name))
    .map((name) => {
      const path = join(backupsDir, name);
      return { path, name, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  for (const backup of backups.slice(backupRetention)) {
    rmSync(backup.path, { force: true });
    rmSync(`${backup.path}-wal`, { force: true });
    rmSync(`${backup.path}-shm`, { force: true });
  }
}

function latestBackupPath(dataDir: string) {
  const backupsDir = join(dataDir, 'backups');
  if (!existsSync(backupsDir)) return null;
  const latest = readdirSync(backupsDir)
    .filter((name) => /^neondeck-.+\.db$/.test(name))
    .map((name) => {
      const path = join(backupsDir, name);
      return { path, name, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0];
  return latest?.path ?? null;
}

function migrationStatusMessage(input: {
  pending: string[];
  unknown: AppDbMigrationRecord[];
  changed: AppDbMigrationRecord[];
}) {
  if (input.unknown.length > 0) {
    return `Database contains unknown migrations: ${input.unknown
      .map((row) => row.name ?? '(unnamed)')
      .join(', ')}.`;
  }
  if (input.changed.length > 0) {
    return `Database contains migrations with hash mismatches: ${input.changed
      .map((row) => row.name ?? '(unnamed)')
      .join(', ')}.`;
  }
  if (input.pending.length > 0) {
    return `Database has pending migrations: ${input.pending.join(', ')}.`;
  }
  return 'App database migration journal is not current.';
}

function copyIfExists(from: string, to: string) {
  if (existsSync(from)) copyFileSync(from, to);
}

function listUserTables(database: DatabaseSync) {
  return database
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name != ?;
    `,
    )
    .all(drizzleMigrationsTable)
    .map((row) => String((row as { name: unknown }).name));
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

function rollback(database: DatabaseSync) {
  try {
    database.exec('ROLLBACK;');
  } catch {
    // The original migration error is more useful than a rollback failure.
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
