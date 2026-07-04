import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Drizzle v1 package behavior', () => {
  it('reads timestamped migration directories and records the v1 journal shape', async () => {
    const root = await tempDir();
    const migrations = join(root, 'migrations');
    await writeMigration(
      migrations,
      '20260704000000_create_widgets',
      `
        CREATE TABLE widgets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL
        );
      `,
    );
    const database = new DatabaseSync(join(root, 'db.sqlite'));

    try {
      const files = readMigrationFiles({ migrationsFolder: migrations });
      expect(files).toMatchObject([
        {
          name: '20260704000000_create_widgets',
          folderMillis: Date.UTC(2026, 6, 4),
        },
      ]);
      expect(files[0]?.hash).toMatch(/^[a-f0-9]{64}$/);

      migrate(drizzle({ client: database }), { migrationsFolder: migrations });

      const columns = database
        .prepare('PRAGMA table_info(__drizzle_migrations);')
        .all();
      expect(columns).toMatchObject([
        { name: 'id', type: 'INTEGER', notnull: 0, pk: 1 },
        { name: 'hash', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'created_at', type: 'numeric', notnull: 0, pk: 0 },
        { name: 'name', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'applied_at', type: 'TEXT', notnull: 0, pk: 0 },
      ]);
      expect(
        database
          .prepare('SELECT hash, created_at, name FROM __drizzle_migrations;')
          .all(),
      ).toMatchObject([
        {
          hash: files[0]?.hash,
          created_at: Date.UTC(2026, 6, 4),
          name: '20260704000000_create_widgets',
        },
      ]);
    } finally {
      database.close();
    }
  });

  it('rolls back all pending migrations together when Drizzle migrate fails', async () => {
    const root = await tempDir();
    const migrations = join(root, 'migrations');
    await writeMigration(
      migrations,
      '20260704000000_create_widgets',
      'CREATE TABLE widgets (id TEXT PRIMARY KEY);',
    );
    await writeMigration(
      migrations,
      '20260704000100_break_migration',
      'CREATE TABLE broken (id TEXT PRIMARY KEY',
    );
    const database = new DatabaseSync(join(root, 'db.sqlite'));

    try {
      expect(() =>
        migrate(drizzle({ client: database }), {
          migrationsFolder: migrations,
        }),
      ).toThrow(/Failed query/i);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets';",
          )
          .get(),
      ).toBeUndefined();
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations;')
          .get(),
      ).toMatchObject({ count: 0 });
    } finally {
      database.close();
    }
  });

  it('emits JSON for pull --init but cannot introspect sqlite expression indexes', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'legacy.db');
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        repo_id TEXT
      );
      CREATE UNIQUE INDEX idx_memories_scope_key_repo
        ON memories(scope, key, COALESCE(repo_id, ''));
    `);
    database.close();

    const result = await runDrizzleKit([
      'pull',
      '--output',
      'json',
      '--dialect',
      'sqlite',
      '--out',
      join(root, 'out'),
      '--url',
      databasePath,
      '--init',
    ]);

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'error',
      error: { code: 'database_driver_error', database: 'sqlite' },
    });
  });

  it('has no sqlite generate SDK export, so drift checks must use CLI JSON', async () => {
    const root = await repoTempDir();
    const schemaPath = join(root, 'schema.ts');
    const out = join(root, 'out');
    await writeFile(
      schemaPath,
      `
        import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
        export const demo = sqliteTable('demo', {
          id: text('id').primaryKey(),
        });
      `,
    );

    const api = await import('drizzle-kit/api-sqlite');
    expect('generate' in api).toBe(false);

    const result = await runDrizzleKit([
      'generate',
      '--output',
      'json',
      '--dialect',
      'sqlite',
      '--schema',
      schemaPath,
      '--out',
      out,
      '--explain',
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'ok',
      dialect: 'sqlite',
    });
    expect(
      existsSync(out)
        ? readdirSync(out, { recursive: true }).filter((entry) =>
            String(entry).endsWith('migration.sql'),
          )
        : [],
    ).toEqual([]);
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-drizzle-'));
  tempRoots.push(path);
  return path;
}

async function repoTempDir() {
  const path = await mkdtemp(join(process.cwd(), '.tmp-drizzle-'));
  tempRoots.push(path);
  return path;
}

async function writeMigration(root: string, name: string, sql: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'migration.sql'), sql.trim());
}

async function runDrizzleKit(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(
      join(process.cwd(), 'node_modules', '.bin', 'drizzle-kit'),
      args,
      { cwd: process.cwd() },
    );
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}
