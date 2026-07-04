import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeAppDatabase } from './index.ts';

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('app database schema parity', () => {
  it('matches the legacy v9 initializer and the Drizzle baseline migration', async () => {
    const root = await tempDir();
    const legacyPath = join(root, 'legacy.db');
    const migratedPath = join(root, 'migrated.db');

    initializeAppDatabase(legacyPath);
    applyBaselineMigration(migratedPath);

    const legacy = new DatabaseSync(legacyPath, { readOnly: true });
    const migrated = new DatabaseSync(migratedPath, { readOnly: true });
    try {
      expect(readSchemaSnapshot(migrated)).toEqual(readSchemaSnapshot(legacy));
    } finally {
      legacy.close();
      migrated.close();
    }
  });
});

function applyBaselineMigration(path: string) {
  const database = new DatabaseSync(path);
  try {
    migrate(drizzle({ client: database }), { migrationsFolder });
  } finally {
    database.close();
  }
}

function readSchemaSnapshot(database: DatabaseSync) {
  const tables = database
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name != '__drizzle_migrations'
      ORDER BY name;
    `,
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));

  return tables.map((table) => ({
    table,
    autoincrement: readTableSql(database, table)
      .toUpperCase()
      .includes('AUTOINCREMENT'),
    columns: readColumns(database, table),
    indexes: readIndexes(database, table),
  }));
}

function readColumns(database: DatabaseSync, table: string) {
  return database
    .prepare(`PRAGMA table_info(${quoteIdentifier(table)});`)
    .all()
    .map((row) => {
      const record = row as Record<string, unknown>;
      return {
        name: String(record.name),
        type: String(record.type).toUpperCase(),
        notnull: Number(record.notnull),
        default: normalizeDefault(record.dflt_value),
        pk: Number(record.pk),
      };
    });
}

function readIndexes(database: DatabaseSync, table: string) {
  return database
    .prepare(`PRAGMA index_list(${quoteIdentifier(table)});`)
    .all()
    .flatMap((row) => {
      const index = row as Record<string, unknown>;
      const origin = String(index.origin);
      if (origin === 'pk') return [];

      const name = String(index.name);
      const sql = readIndexSql(database, name);
      return [
        {
          name: origin === 'u' ? '<unique-constraint>' : name,
          unique: Number(index.unique),
          origin,
          partial: Number(index.partial),
          columns: readIndexColumns(database, name),
          sql: origin === 'c' ? normalizeSql(sql) : null,
        },
      ];
    })
    .sort((a, b) => {
      const left = `${a.name}:${a.sql ?? a.columns.join(',')}`;
      const right = `${b.name}:${b.sql ?? b.columns.join(',')}`;
      return left.localeCompare(right);
    });
}

function readIndexColumns(database: DatabaseSync, indexName: string) {
  return database
    .prepare(`PRAGMA index_xinfo(${quoteIdentifier(indexName)});`)
    .all()
    .flatMap((row) => {
      const record = row as Record<string, unknown>;
      if (Number(record.key) !== 1) return [];
      return [
        {
          seqno: Number(record.seqno),
          cid: Number(record.cid),
          name: record.name === null ? null : String(record.name),
          desc: Number(record.desc),
        },
      ];
    })
    .sort((a, b) => a.seqno - b.seqno)
    .map((item) => `${item.name ?? '<expr>'}:${item.desc}`);
}

function readIndexSql(database: DatabaseSync, indexName: string) {
  const row = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name = ?;
    `,
    )
    .get(indexName) as { sql?: unknown } | undefined;
  return typeof row?.sql === 'string' ? row.sql : '';
}

function readTableSql(database: DatabaseSync, table: string) {
  const row = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?;
    `,
    )
    .get(table) as { sql?: unknown } | undefined;
  return typeof row?.sql === 'string' ? row.sql : '';
}

function normalizeSql(value: string) {
  return value
    .replace(/[`"]/g, '')
    .replace(/\b([a-z_][a-z0-9_]*)\./gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+\(/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\(\s+/g, '(')
    .trim()
    .toLowerCase();
}

function normalizeDefault(value: unknown) {
  return value === null ? null : String(value);
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-schema-parity-'));
  tempRoots.push(path);
  return path;
}
