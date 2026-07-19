import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubPullRequestEventState } from './modules/github';
import { refreshPrWatchEventState } from './modules/pr-events';
import { runtimePaths } from './runtime-home';

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
  it('upgrades the real pre-Package-2 schema as a versioned seed-only baseline', async () => {
    const root = await tempDir();
    const paths = runtimePaths(root);
    await mkdir(paths.data, { recursive: true });
    const database = new DatabaseSync(paths.neondeckDatabase);
    let migratedGeneration = '';

    try {
      const migrationsFolder = join(
        process.cwd(),
        'src/runtime-home/app-db/migrations',
      );
      const migrationFiles = readMigrationFiles({ migrationsFolder });
      const historicalMigrations = join(root, 'package-1-migrations');
      for (const migration of migrationFiles) {
        if (
          migration.name >
          '20260719072902_autopilot_package_1_durable_invariants'
        ) {
          break;
        }
        await writeMigrationExact(
          historicalMigrations,
          migration.name,
          await readFile(
            join(migrationsFolder, migration.name, 'migration.sql'),
            'utf8',
          ),
        );
      }
      migrate(drizzle({ client: database }), {
        migrationsFolder: historicalMigrations,
      });
      database
        .prepare(
          `INSERT INTO pr_watches (
             id, repo_id, repo_full_name, github_owner, github_name, pr_number,
             desired_terminal_state, status, pr_state, title, url,
             merge_commit_sha, last_snapshot_json, last_outcome, last_checked_at,
             created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?);`,
        )
        .run(
          'example/sample#7',
          'repo-1',
          'example/sample',
          'example',
          'sample',
          7,
          'merged-or-closed',
          'active',
          'open',
          'Historical PR',
          'https://github.com/example/sample/pull/7',
          'operator',
          '2026-07-01T00:00:00.000Z',
          '2026-07-18T12:34:56.000Z',
        );
      database
        .prepare(
          `INSERT INTO pr_watch_event_watermarks (
             watch_id, category, watermark_json, source_updated_at,
             checked_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          'example/sample#7',
          'commits',
          '{"headSha":"abc123","total":1,"truncated":false}',
          '2026-07-18T12:00:00.000Z',
          '2026-07-18T12:34:56.000Z',
          '2026-07-18T12:34:56.000Z',
          '2026-07-18T12:34:56.000Z',
          'example/sample#7',
          'review_threads',
          '{"total":1,"unresolvedThreadIds":["thread-1"],"truncated":false}',
          '2026-07-18T12:00:00.000Z',
          '2026-07-18T12:34:56.000Z',
          '2026-07-18T12:34:56.000Z',
          '2026-07-18T12:34:56.000Z',
        );

      migrate(drizzle({ client: database }), { migrationsFolder });

      const migratedWatch = database
        .prepare(
          'SELECT process_existing, initial_event_processed_at, event_watermark_version, event_generation_id FROM pr_watches WHERE id = ?;',
        )
        .get('example/sample#7') as Record<string, unknown>;
      expect(migratedWatch).toEqual({
        process_existing: 0,
        initial_event_processed_at: '2026-07-18T12:34:56.000Z',
        event_watermark_version: 1,
        event_generation_id: expect.any(String),
      });
      migratedGeneration = String(migratedWatch.event_generation_id);
      expect(migratedGeneration.length).toBeGreaterThan(0);
      expect(
        database
          .prepare(
            'SELECT category, watermark_json FROM pr_watch_event_watermarks WHERE watch_id = ? ORDER BY category;',
          )
          .all('example/sample#7'),
      ).toEqual([
        {
          category: 'commits',
          watermark_json: '{"headSha":"abc123","total":1,"truncated":false}',
        },
        {
          category: 'review_threads',
          watermark_json:
            '{"total":1,"unresolvedThreadIds":["thread-1"],"truncated":false}',
        },
      ]);
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM pr_watch_event_intakes;')
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      database.close();
    }

    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: 'sample',
            github: { owner: 'example', name: 'sample' },
            path: '/tmp/example-sample',
            defaultBranch: 'main',
            metadata: { autopilot: { mode: 'prepare-only' } },
          },
        ],
      })}\n`,
    );
    const incomplete = legacyUpgradeEventState({
      conversationCommentsTruncated: true,
    });
    await expect(
      refreshPrWatchEventState({ watchId: 'example/sample#7' }, paths, {
        token: 'test-token',
        fetchPullRequestEventState: async () => incomplete,
      }),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['completePrEventFacts'],
    });
    expect(readUpgradeWatchState(paths.neondeckDatabase)).toMatchObject({
      event_watermark_version: 1,
      event_generation_id: migratedGeneration,
      pending_intakes: 0,
      admissions: 0,
      commits_watermark: '{"headSha":"abc123","total":1,"truncated":false}',
    });

    const complete = legacyUpgradeEventState();
    await expect(
      refreshPrWatchEventState({ watchId: 'example/sample#7' }, paths, {
        token: 'test-token',
        fetchPullRequestEventState: async () => complete,
      }),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      data: { seededUpgrade: true, watermarkVersion: 2 },
    });
    const seededUpgrade = readUpgradeWatchState(paths.neondeckDatabase) as {
      event_generation_id: string;
    };
    expect(seededUpgrade).toMatchObject({
      event_watermark_version: 2,
      pending_intakes: 0,
      admissions: 0,
    });
    expect(seededUpgrade.event_generation_id).toEqual(expect.any(String));
    expect(seededUpgrade.event_generation_id).not.toBe(migratedGeneration);

    // A restart sees the v2 seed and must not replay any historical feedback.
    await expect(
      refreshPrWatchEventState({ watchId: 'example/sample#7' }, paths, {
        token: 'test-token',
        fetchPullRequestEventState: async () => complete,
      }),
    ).resolves.toMatchObject({ ok: true, changed: false });
    expect(readUpgradeWatchState(paths.neondeckDatabase)).toMatchObject({
      pending_intakes: 0,
      admissions: 0,
    });

    const later = legacyUpgradeEventState({
      conversationComments: [
        ...complete.conversationComments!,
        {
          id: 7002,
          nodeId: 'comment-7002',
          url: 'https://github.com/example/sample/pull/7#issuecomment-7002',
          authorLogin: 'reviewer',
          authorType: 'User',
          authorIsBot: false,
          body: 'This is new after the v2 seed.',
          createdAt: '2026-07-19T12:00:00.000Z',
          updatedAt: '2026-07-19T12:00:00.000Z',
        },
      ],
    });
    const firstLater = await refreshPrWatchEventState(
      { watchId: 'example/sample#7' },
      paths,
      {
        token: 'test-token',
        fetchPullRequestEventState: async () => later,
      },
    );
    const secondLater = await refreshPrWatchEventState(
      { watchId: 'example/sample#7' },
      paths,
      {
        token: 'test-token',
        fetchPullRequestEventState: async () => {
          throw new Error('pending intake must replay without GitHub');
        },
      },
    );
    expect(firstLater).toMatchObject({
      ok: true,
      changed: true,
      data: { pending: true },
    });
    expect(secondLater).toMatchObject({
      ok: true,
      changed: true,
      data: { pending: true },
    });
    expect((firstLater.data as { intakeId: string }).intakeId).toBe(
      (secondLater.data as { intakeId: string }).intakeId,
    );
    expect(readUpgradeWatchState(paths.neondeckDatabase)).toMatchObject({
      pending_intakes: 1,
      admissions: 0,
    });
  });

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

async function writeMigrationExact(root: string, name: string, sql: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'migration.sql'), sql);
}

function readUpgradeWatchState(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT
           (SELECT event_watermark_version FROM pr_watches WHERE id = 'example/sample#7') AS event_watermark_version,
           (SELECT event_generation_id FROM pr_watches WHERE id = 'example/sample#7') AS event_generation_id,
           (SELECT watermark_json FROM pr_watch_event_watermarks WHERE watch_id = 'example/sample#7' AND category = 'commits') AS commits_watermark,
           (SELECT COUNT(*) FROM pr_watch_event_intakes WHERE watch_id = 'example/sample#7' AND status = 'pending') AS pending_intakes,
           (SELECT COUNT(*) FROM autopilot_admissions WHERE watch_id = 'example/sample#7') AS admissions;`,
      )
      .get();
  } finally {
    database.close();
  }
}

function legacyUpgradeEventState(
  overrides: Partial<GitHubPullRequestEventState> = {},
): GitHubPullRequestEventState {
  return {
    repo: 'example/sample',
    number: 7,
    url: 'https://github.com/example/sample/pull/7',
    title: 'Historical PR',
    body: null,
    state: 'open',
    draft: false,
    merged: false,
    mergeCommitSha: null,
    headSha: 'a'.repeat(40),
    headRef: 'feature',
    headRepoFullName: 'example/sample',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    baseRepoFullName: 'example/sample',
    mergeable: true,
    mergeableState: 'clean',
    maintainerCanModify: true,
    commits: [],
    reviewThreads: [],
    requestedChangesReviews: [],
    requestedChangesState: { active: [], latestByReviewer: [], history: [] },
    conversationComments: [
      {
        id: 7001,
        nodeId: 'comment-7001',
        url: 'https://github.com/example/sample/pull/7#issuecomment-7001',
        authorLogin: 'reviewer',
        authorType: 'User',
        authorIsBot: false,
        body: 'Historical feedback must only seed.',
        createdAt: '2026-07-18T12:00:00.000Z',
        updatedAt: '2026-07-18T12:00:00.000Z',
      },
    ],
    checkSuites: [],
    checkRuns: [],
    branchPermissions: {
      headRepoFullName: 'example/sample',
      baseRepoFullName: 'example/sample',
      isFork: false,
      maintainerCanModify: true,
      headRepoPush: true,
      baseRepoPush: true,
      canLikelyPush: true,
      checkedAt: '2026-07-19T00:00:00.000Z',
    },
    isOutOfDate: false,
    fetchedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
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
