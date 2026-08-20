import {
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  closeSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { defaultSqliteBusyTimeoutMs } from '../../lib/sqlite';
import { resolveShippedAsset } from '../assets';

const drizzleMigrationsTable = '__drizzle_migrations';
const defaultMigrationsFolder = resolveShippedAsset(
  'src/runtime-home/app-db/migrations',
  'assets/migrations',
);
const backupRetention = 2;
const backupNamePattern =
  /^neondeck-\d{4}-\d{2}-\d{2}T\d{6}Z-(?:pre-[a-z0-9][a-z0-9_-]*|manual|restore-safety)(?:-\d+)?\.db$/i;
let restoreReplacementHook:
  ((stagedPath: string, databasePath: string) => void) | undefined;

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

export type AppDbBackup = {
  name: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  walBytes: number | null;
  shmBytes: number | null;
  kind: 'manual' | 'pre-migration' | 'restore-safety' | 'automatic';
};

export type AppDbBackupResult = {
  ok: boolean;
  action: 'db_backup' | 'db_restore';
  changed: boolean;
  message: string;
  backup?: AppDbBackup;
  restoredBackup?: AppDbBackup;
  safetyBackup?: AppDbBackup;
  errors?: string[];
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
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: defaultSqliteBusyTimeoutMs,
    });
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
    if (journalPredatesCurrentBaseline(applied, migrations)) {
      return {
        ok: false,
        databasePath,
        migrationsFolder,
        applied,
        pending: migrations.map((migration) => migration.name),
        unknown: applied,
        changed: [],
        localHead,
        journalHead: applied.at(-1)?.name ?? null,
        lastBackup,
        message:
          'This app database predates the current Neondeck baseline. Reset it instead of applying a pre-1.0 compatibility upgrade.',
      };
    }
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
  const database = new DatabaseSync(databasePath, {
    timeout: defaultSqliteBusyTimeoutMs,
  });
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
      const applied = readJournal(database);
      if (journalPredatesCurrentBaseline(applied, migrations)) {
        throw new AppDbMigrationError(
          'This app database predates the current Neondeck baseline. Reset it instead of applying a pre-1.0 compatibility upgrade.',
        );
      }
      assertJournalMatchesLocalMigrations(applied, localByName);
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

export function setAppDbRestoreReplacementHookForTests(
  hook: ((stagedPath: string, databasePath: string) => void) | undefined,
) {
  const previous = restoreReplacementHook;
  restoreReplacementHook = hook;
  return () => {
    restoreReplacementHook = previous;
  };
}

export function listAppDbBackups(databasePath: string): AppDbBackup[] {
  const backupsDir = join(dirname(databasePath), 'backups');
  if (!existsSync(backupsDir)) return [];

  return readBackupEntries(backupsDir).flatMap(({ path }) => {
    const backup = readBackupMetadata(path);
    return backup ? [backup] : [];
  });
}

export async function createAppDbBackup(
  databasePath: string,
  options: { now?: Date } = {},
): Promise<AppDbBackupResult> {
  if (!existsSync(databasePath)) {
    return failedAppDbBackup(
      'db_backup',
      'Neondeck app database is missing; there is nothing to back up.',
    );
  }

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: defaultSqliteBusyTimeoutMs,
    });
    const backup = await createSnapshotFromDatabase(database, databasePath, {
      now: options.now,
      kind: 'manual',
    });
    return {
      ok: true,
      action: 'db_backup',
      changed: true,
      backup,
      message: `Created a consistent app database backup at ${backup.path}.`,
    };
  } catch (error) {
    return failedAppDbBackup(
      'db_backup',
      `Could not create an app database backup: ${errorMessage(error)}.`,
    );
  } finally {
    database?.close();
  }
}

export async function restoreAppDbBackup(
  databasePath: string,
  backupName: string,
): Promise<AppDbBackupResult> {
  const backupPath = resolveBackupPath(databasePath, backupName);
  if (!backupPath) {
    return failedAppDbBackup(
      'db_restore',
      `Backup "${backupName}" is not a recognized backup in the Neondeck backups directory.`,
    );
  }
  if (!existsSync(databasePath)) {
    return failedAppDbBackup(
      'db_restore',
      'Neondeck app database is missing; restore requires a current database to safeguard first.',
    );
  }

  let stagedPath: string | undefined;
  let safetyBackupPath: string | undefined;
  let liveDatabase: DatabaseSync | undefined;
  let transactionOpen = false;
  try {
    const restoredBackup = validateAppDbBackup(backupPath);
    stagedPath = `${databasePath}.restore-${process.pid}-${Date.now()}.tmp`;
    await materializeBackup(backupPath, stagedPath);
    validateAppDbBackup(stagedPath);

    liveDatabase = new DatabaseSync(databasePath, { timeout: 0 });
    try {
      liveDatabase.exec('PRAGMA busy_timeout = 0;');
      liveDatabase.exec('BEGIN EXCLUSIVE;');
      transactionOpen = true;
    } catch (error) {
      throw new AppDbMigrationError(
        `Could not exclusively lock the current app database. Stop Neondeck and any other SQLite clients before restoring. ${errorMessage(error)}`,
      );
    }

    const safetyBackup = await createSnapshotFromDatabase(
      liveDatabase,
      databasePath,
      // `sqliteBackup` cannot run from an active exclusive transaction. Node 26's
      // serializer captures the locked connection's current SQLite image instead.
      { kind: 'restore-safety', prune: false, serialize: true },
    );
    safetyBackupPath = safetyBackup.path;
    liveDatabase.exec('ROLLBACK;');
    transactionOpen = false;
    liveDatabase.close();
    liveDatabase = undefined;

    (restoreReplacementHook ?? replaceDatabaseAtomically)(
      stagedPath,
      databasePath,
    );
    stagedPath = undefined;
    removeDatabaseSidecars(databasePath);
    rotateBackups(join(dirname(databasePath), 'backups'));

    return {
      ok: true,
      action: 'db_restore',
      changed: true,
      restoredBackup,
      safetyBackup,
      message: `Restored ${restoredBackup.name}. The replaced database was saved as ${safetyBackup.path}.`,
    };
  } catch (error) {
    return failedAppDbBackup(
      'db_restore',
      `Could not restore app database: ${errorMessage(error)}.`,
    );
  } finally {
    if (transactionOpen && liveDatabase) rollback(liveDatabase);
    liveDatabase?.close();
    if (stagedPath) rmSync(stagedPath, { force: true });
    if (stagedPath && safetyBackupPath) {
      removeBackupSet(safetyBackupPath);
    }
  }
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

function journalPredatesCurrentBaseline(
  appliedRows: AppDbMigrationRecord[],
  migrations: DrizzleMigration[],
) {
  const baseline = migrations[0]?.name;
  return Boolean(
    baseline &&
    appliedRows.length > 0 &&
    !appliedRows.some((row) => row.name === baseline),
  );
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

async function createSnapshotFromDatabase(
  database: DatabaseSync,
  databasePath: string,
  options: {
    now?: Date;
    kind: 'manual' | 'restore-safety';
    prune?: boolean;
    serialize?: boolean;
  },
): Promise<AppDbBackup> {
  const backupsDir = join(dirname(databasePath), 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const backupPath = nextBackupPath(backupsDir, options.kind, options.now);
  try {
    if (options.serialize) {
      writeSerializedSnapshot(database, backupPath);
    } else {
      await sqliteBackup(database, backupPath);
    }
    if (options.prune !== false) rotateBackups(backupsDir);
    const metadata = readBackupMetadata(backupPath);
    if (!metadata) {
      throw new AppDbMigrationError(
        `Snapshot backup ${backupPath} was not created.`,
      );
    }
    return metadata;
  } catch (error) {
    rmSync(backupPath, { force: true });
    throw error;
  }
}

function writeSerializedSnapshot(database: DatabaseSync, backupPath: string) {
  writeFileSync(backupPath, database.serialize(), { flag: 'wx' });
  const descriptor = openSync(backupPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function materializeBackup(sourcePath: string, targetPath: string) {
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, {
      readOnly: true,
      timeout: defaultSqliteBusyTimeoutMs,
    });
    await sqliteBackup(source, targetPath);
  } finally {
    source?.close();
  }
}

function validateAppDbBackup(path: string): AppDbBackup {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, {
      readOnly: true,
      timeout: defaultSqliteBusyTimeoutMs,
    });
    const integrity = database.prepare('PRAGMA integrity_check;').all();
    if (
      integrity.length !== 1 ||
      (integrity[0] as { integrity_check?: unknown }).integrity_check !== 'ok'
    ) {
      throw new AppDbMigrationError('Backup database integrity check failed.');
    }
  } catch (error) {
    throw new AppDbMigrationError(
      `Backup database is not readable: ${errorMessage(error)}.`,
    );
  } finally {
    database?.close();
  }

  const status = readAppDbMigrationStatus(path);
  if (
    status.applied.length === 0 ||
    status.unknown.length > 0 ||
    status.changed.length > 0
  ) {
    throw new AppDbMigrationError(
      `Backup database is incompatible with this Neondeck package: ${status.message}`,
    );
  }

  const metadata = readBackupMetadata(path);
  if (!metadata) {
    return {
      name: path,
      path,
      createdAt: new Date().toISOString(),
      sizeBytes: statSync(path).size,
      walBytes: null,
      shmBytes: null,
      kind: 'automatic',
    };
  }
  return metadata;
}

function resolveBackupPath(databasePath: string, backupName: string) {
  if (
    backupName !== basename(backupName) ||
    !isRecognizedBackupName(backupName)
  ) {
    return null;
  }
  const path = join(dirname(databasePath), 'backups', backupName);
  return existsSync(path) ? path : null;
}

function replaceDatabaseAtomically(stagedPath: string, databasePath: string) {
  try {
    renameSync(stagedPath, databasePath);
  } catch (error) {
    throw new AppDbMigrationError(
      `Could not atomically replace ${databasePath}: ${errorMessage(error)}.`,
    );
  }
}

function removeDatabaseSidecars(databasePath: string) {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function removeBackupSet(backupPath: string) {
  rmSync(backupPath, { force: true });
  rmSync(`${backupPath}-wal`, { force: true });
  rmSync(`${backupPath}-shm`, { force: true });
}

function failedAppDbBackup(
  action: AppDbBackupResult['action'],
  message: string,
): AppDbBackupResult {
  return { ok: false, action, changed: false, message, errors: [message] };
}

function backupDatabase(
  databasePath: string,
  nextMigrationName: string,
  now = new Date(),
) {
  const backupsDir = join(dirname(databasePath), 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const backupPath = nextBackupPath(
    backupsDir,
    `pre-${nextMigrationName}`,
    now,
  );
  copyIfExists(databasePath, backupPath);
  copyIfExists(`${databasePath}-wal`, `${backupPath}-wal`);
  copyIfExists(`${databasePath}-shm`, `${backupPath}-shm`);
  rotateBackups(backupsDir);
  return backupPath;
}

function rotateBackups(backupsDir: string) {
  const backups = readBackupEntries(backupsDir);

  for (const backup of backups.slice(backupRetention)) {
    rmSync(backup.path, { force: true });
    rmSync(`${backup.path}-wal`, { force: true });
    rmSync(`${backup.path}-shm`, { force: true });
  }
}

function nextBackupPath(backupsDir: string, kind: string, now = new Date()) {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '');
  const base = `neondeck-${stamp}-${kind}`;
  let suffix = 0;
  while (true) {
    const name = `${base}${suffix ? `-${suffix}` : ''}.db`;
    const path = join(backupsDir, name);
    if (!existsSync(path)) return path;
    suffix += 1;
  }
}

function readBackupEntries(backupsDir: string) {
  return readdirSync(backupsDir)
    .filter(isRecognizedBackupName)
    .flatMap((name) => {
      const path = join(backupsDir, name);
      try {
        const stat = statSync(path);
        return stat.isFile() ? [{ path, name, mtimeMs: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
}

function readBackupMetadata(path: string): AppDbBackup | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return {
      name: basename(path),
      path,
      createdAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      walBytes: sidecarSize(`${path}-wal`),
      shmBytes: sidecarSize(`${path}-shm`),
      kind: backupKind(basename(path)),
    };
  } catch {
    return null;
  }
}

function sidecarSize(path: string) {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function backupKind(name: string): AppDbBackup['kind'] {
  if (name.includes('-restore-safety')) return 'restore-safety';
  if (name.includes('-manual')) return 'manual';
  if (name.includes('-pre-')) return 'pre-migration';
  return 'automatic';
}

function isRecognizedBackupName(name: string) {
  return backupNamePattern.test(name);
}

function latestBackupPath(dataDir: string) {
  const backupsDir = join(dataDir, 'backups');
  if (!existsSync(backupsDir)) return null;
  const latest = readBackupEntries(backupsDir)[0];
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
