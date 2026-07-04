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
import {
  ensureColumn,
  migrateMemoriesRepoIdentity,
  migrateMemoryEvents,
} from './migrations.ts';

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
  stampedBaseline: boolean;
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
      const legacy = readLegacyDatabaseState(database);
      const message = legacy.legacy
        ? 'Legacy app database has not been stamped with Drizzle migrations yet.'
        : 'App database has no Drizzle migration journal.';
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
        message,
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
    const legacy = journalExisted
      ? { legacy: false, schemaVersion: null }
      : readLegacyDatabaseState(database);

    if (journalExisted) {
      assertJournalMatchesLocalMigrations(readJournal(database), localByName);
    }

    if (!journalExisted && legacy.legacy) {
      const baseline = baselineMigration(migrations);
      backupPath = backupDatabase(databasePath, baseline.name, options.now);
      upgradeLegacyDatabaseToCurrentBaseline(database);
      createJournalTable(database);
      insertJournalRow(database, baseline);
    } else if (!journalExisted) {
      if (userTablesBeforeJournal.length > 0) {
        const baseline = baselineMigration(migrations);
        backupPath = backupDatabase(databasePath, baseline.name, options.now);
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
    const shouldBackupPending =
      journalExisted || legacy.legacy || userTablesBeforeJournal.length > 0;

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
      stampedBaseline: !journalExisted && legacy.legacy,
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

function baselineMigration(migrations: DrizzleMigration[]) {
  const [baseline] = migrations;
  if (!baseline) {
    throw new AppDbMigrationError('No baseline app database migration found.');
  }
  return baseline;
}

function readLegacyDatabaseState(database: DatabaseSync) {
  const schemaVersion = readSchemaVersion(database);
  if (schemaVersion) {
    return { legacy: true, schemaVersion };
  }
  const sentinelTables = ['app_metadata', 'memories', 'workflow_summaries'];
  return {
    legacy: sentinelTables.every((table) => tableExists(database, table)),
    schemaVersion: null,
  };
}

function readSchemaVersion(database: DatabaseSync) {
  if (!tableExists(database, 'app_metadata')) return null;
  const row = database
    .prepare(
      `
      SELECT value
      FROM app_metadata
      WHERE key = 'schema_version';
    `,
    )
    .get() as { value?: unknown } | undefined;
  return typeof row?.value === 'string' ? row.value : null;
}

function upgradeLegacyDatabaseToCurrentBaseline(database: DatabaseSync) {
  const requiredTables = [
    'repo_edit_events',
    'repo_file_reads',
    'kilo_tasks',
    'kilo_result_state',
    'notifications',
    'chat_sessions',
    'memories',
    'memory_events',
    'learning_candidates',
    'learning_reviews',
  ];
  const missing = requiredTables.filter(
    (table) => !tableExists(database, table),
  );
  if (missing.length > 0) {
    throw new AppDbMigrationError(
      `Legacy app database is too old to upgrade automatically; missing tables: ${missing.join(', ')}.`,
    );
  }

  ensureColumn(database, 'repo_edit_events', 'worktree_id', 'TEXT');
  ensureColumn(database, 'repo_file_reads', 'worktree_id', 'TEXT');
  ensureColumn(database, 'kilo_tasks', 'lock_id', 'TEXT');
  ensureColumn(database, 'kilo_result_state', 'diff_fingerprint', 'TEXT');
  ensureColumn(
    database,
    'kilo_result_state',
    'verified_diff_fingerprint',
    'TEXT',
  );
  ensureColumn(database, 'notifications', 'resolved_at', 'TEXT');
  ensureColumn(database, 'notifications', 'updated_at', 'TEXT');
  ensureColumn(
    database,
    'notifications',
    'occurrence_count',
    'INTEGER NOT NULL DEFAULT 1',
  );
  ensureColumn(database, 'chat_sessions', 'context_loaded_at', 'TEXT');
  ensureColumn(database, 'chat_sessions', 'summary_generated_at', 'TEXT');
  ensureColumn(database, 'chat_sessions', 'summary_source', 'TEXT');
  ensureColumn(database, 'chat_sessions', 'summary_refresh_note', 'TEXT');
  ensureColumn(database, 'chat_sessions', 'context_memory_ids_json', 'TEXT');
  ensureColumn(
    database,
    'chat_sessions',
    'learning_turn_count',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn(
    database,
    'chat_sessions',
    'last_learning_review_turn_count',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn(database, 'chat_sessions', 'last_learning_review_at', 'TEXT');
  ensureColumn(
    database,
    'chat_sessions',
    'last_learning_curation_turn_count',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn(database, 'chat_sessions', 'last_learning_curation_at', 'TEXT');
  ensureColumn(database, 'memories', 'repo_id', 'TEXT');
  ensureColumn(
    database,
    'memories',
    'status',
    "TEXT NOT NULL DEFAULT 'active'",
  );
  ensureColumn(database, 'memories', 'use_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'memories', 'last_used_at', 'TEXT');
  migrateMemoriesRepoIdentity(database);
  migrateMemoryEvents(database);
  ensureColumn(database, 'learning_candidates', 'action', 'TEXT');
  ensureColumn(database, 'learning_reviews', 'flue_run_id', 'TEXT');
  ensureLegacyMcpTables(database);
  repairLegacyIndexes(database);
  database
    .prepare(
      `
      INSERT INTO app_metadata (key, value, updated_at)
      VALUES ('schema_version', '9', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at;
    `,
    )
    .run();
}

function ensureLegacyMcpTables(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mcp_tool_catalog (
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      adapted_name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema_json TEXT,
      output_schema_json TEXT,
      annotations_json TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(server_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS mcp_tool_approvals (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      adapted_name TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      arguments_preview TEXT NOT NULL,
      status TEXT NOT NULL,
      approver_surface TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      used_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_tool_audit (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      adapted_name TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      decision TEXT NOT NULL,
      approval_id TEXT,
      duration_ms INTEGER,
      ok INTEGER NOT NULL,
      result_preview TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      server_id TEXT PRIMARY KEY,
      server_identity TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_type TEXT,
      id_token TEXT,
      expires_at TEXT,
      scopes_json TEXT,
      client_information_json TEXT,
      discovery_state_json TEXT,
      code_verifier TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mcp_oauth_logins (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      server_identity TEXT,
      state TEXT NOT NULL,
      status TEXT NOT NULL,
      redirect_url TEXT NOT NULL,
      authorization_url TEXT,
      discovery_state_json TEXT,
      code_verifier TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  ensureColumn(database, 'mcp_tool_catalog', 'annotations_json', 'TEXT');
  ensureColumn(database, 'mcp_tool_audit', 'decision', 'TEXT');
  ensureColumn(database, 'mcp_tool_audit', 'ok', 'INTEGER');
  ensureColumn(database, 'mcp_tool_audit', 'result_preview', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'server_identity', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'access_token', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'refresh_token', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'token_type', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'id_token', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'expires_at', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'scopes_json', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'client_information_json', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'discovery_state_json', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'code_verifier', 'TEXT');
  ensureColumn(database, 'mcp_oauth_tokens', 'updated_at', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'server_identity', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'state', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'status', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'redirect_url', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'authorization_url', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'discovery_state_json', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'code_verifier', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'error', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'created_at', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'expires_at', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'completed_at', 'TEXT');
  ensureColumn(database, 'mcp_oauth_logins', 'updated_at', 'TEXT');
}

function repairLegacyIndexes(database: DatabaseSync) {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_events_changed
      ON memory_events(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_memories_active_scope
      ON memories(status, scope, updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_scope_key_repo
      ON memories(scope, key, COALESCE(repo_id, ''));

    CREATE INDEX IF NOT EXISTS idx_mcp_tool_catalog_status
      ON mcp_tool_catalog(server_id, status, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_mcp_tool_approvals_pending
      ON mcp_tool_approvals(server_id, tool_name, adapted_name, arguments_hash, status, expires_at);

    CREATE INDEX IF NOT EXISTS idx_mcp_tool_audit_created
      ON mcp_tool_audit(created_at DESC);
  `);
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
