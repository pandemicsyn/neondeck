import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquirePhysicalWorkspaceLease,
  listPhysicalWorkspaceQuarantines,
  readTaskWorkspaceForRun,
} from '../../modules/scheduled-tasks/workspace-store.ts';
import { runtimePaths } from '../paths.ts';
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

  it('preserves applied scheduled-workspace migration hashes', () => {
    const migrations = new Map(
      readAppDbMigrationFiles().map((migration) => [
        migration.name,
        migration.hash,
      ]),
    );
    expect(migrations.get('20260817023609_scheduled_task_workspaces')).toBe(
      '9d08228fd65b36dc380c987411023bbd1935c222cb0219d87828fe27b21c10df',
    );
    expect(
      migrations.get('20260817063811_scheduled_workspace_required_identity'),
    ).toBe('0436a3d007825a303df2a5a001548b5675ed6678b86ad83907e3448dc06f2a2a');
    expect(
      migrations.get('20260817092313_scheduled_workspace_repo_identity'),
    ).toBe('1b3d0acb9125dd824d80dc1b90f814bee2caa84199ccecf2e22bae8d8c24a511');
    expect(
      migrations.get('20260817100124_scheduled_workspace_release_fence'),
    ).toBe('68456da88828c64066c0f6fb5bed8d540d0ee83afb841ca321683d14f101283c');
  });

  it('backfills legacy SSH snapshots with fail-closed host and key references in a forward migration', () => {
    const migration = readAppDbMigrationFiles().find((candidate) =>
      candidate.name.includes('scheduled_workspace_forward_compatibility'),
    );
    expect(migration?.sql.join('\n')).toContain(
      "'$.config.privateKeyEnv',\n  'NEONDECK_LEGACY_WORKSPACE_PRIVATE_KEY_UNAVAILABLE'",
    );
  });

  it('backfills immutable historical workspace snapshots with a validated legacy repository identity in a forward migration', () => {
    const migration = readAppDbMigrationFiles().find((candidate) =>
      candidate.name.includes('scheduled_workspace_forward_compatibility'),
    );
    const sql = migration?.sql.join('\n') ?? '';
    expect(sql).toContain('UPDATE `scheduled_run_workspace_snapshots`');
    expect(sql).toContain("'$.repoSnapshot'");
    expect(sql).toContain("'verified', json('false')");
    expect(sql).toContain("json_extract(`snapshot_json`, '$.repoId')");
  });

  it('upgrades a database with the earlier shipped hashes through the forward compatibility migration', async () => {
    const root = await tempDir();
    const paths = runtimePaths(root);
    await mkdir(paths.data, { recursive: true });
    const databasePath = paths.neondeckDatabase;
    const oldMigrations = join(root, 'pre-repo-identity-migrations');
    const appliedMigrations = join(root, 'pre-forward-migrations');
    await mkdir(oldMigrations);
    await mkdir(appliedMigrations);
    for (const entry of await readdir(appDbMigrationsFolder())) {
      if (entry < '20260817092313_scheduled_workspace_repo_identity') {
        await cp(
          join(appDbMigrationsFolder(), entry),
          join(oldMigrations, entry),
          { recursive: true },
        );
      }
      if (!entry.includes('scheduled_workspace_forward_compatibility')) {
        await cp(
          join(appDbMigrationsFolder(), entry),
          join(appliedMigrations, entry),
          { recursive: true },
        );
      }
    }
    applyAppDbMigrations(databasePath, { migrationsFolder: oldMigrations });
    const before = new DatabaseSync(databasePath);
    try {
      const insertSnapshot = before.prepare(
        `INSERT INTO scheduled_run_workspace_snapshots
         (run_id, workspace_id, snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?);`,
      );
      for (const fixture of [
        preCoordinationWorkspaceSnapshot({
          runId: 'run:legacy-local',
          workspaceId: 'workspace:legacy-local',
          providerId: 'local',
          providerResourceId: 'worktree:legacy-local',
          resourceMetadata: {},
          workspaceRoot: '/workspaces/legacy-local',
          localWorktreeId: 'worktree:legacy-local',
        }),
        preCoordinationWorkspaceSnapshot({
          runId: 'run:legacy-ssh',
          workspaceId: 'workspace:legacy-ssh',
          providerId: 'ssh-primary',
          providerResourceId: 'remote:legacy-ssh',
          resourceMetadata: {
            host: 'ssh.example.test',
            port: 2222,
            providerRoot: '/srv/neondeck',
            managedInfrastructure: false,
            managedDirectory: true,
          },
          workspaceRoot: '/srv/neondeck/task-ssh',
          localWorktreeId: null,
        }),
      ]) {
        insertSnapshot.run(
          fixture.runId,
          fixture.workspaceId,
          JSON.stringify(fixture.snapshot),
          '2026-08-17T00:00:00.000Z',
          '2026-08-17T00:00:00.000Z',
        );
      }
      before
        .prepare(
          `INSERT INTO app_metadata (key, value, updated_at)
           VALUES (?, ?, ?);`,
        )
        .run(
          'workspace-resource-lease:local:/workspaces/legacy',
          JSON.stringify({
            owner: 'legacy-owner',
            physicalResourceKey: 'local:/workspaces/legacy',
            expiresAt: '2026-08-17T01:00:00.000Z',
          }),
          '2026-08-17T00:00:00.000Z',
        );
    } finally {
      before.close();
    }
    applyAppDbMigrations(databasePath, {
      migrationsFolder: appliedMigrations,
    });
    const collisionKey =
      'ssh://user@ssh.example.test:2222/srv/neondeck/task-ssh';
    const collision = new DatabaseSync(databasePath);
    try {
      collision
        .prepare(
          `INSERT INTO execution_approvals (
             id, command, backend, context, risk, policy_decision, status,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          'alias-collision',
          'git status',
          'ssh-approved-exact',
          'migration-fixture',
          'mutating',
          'requires-approval',
          'approved',
          '2026-08-17T00:00:00.000Z',
          '2026-08-17T00:00:00.000Z',
        );
      insertCurrentTaskWorkspace(collision, {
        id: 'workspace:provider-alias',
        providerId: 'ssh-provider-alias',
        physicalResourceKey: collisionKey,
      });
      collision
        .prepare(
          `INSERT INTO app_metadata (key, value, updated_at)
           VALUES (?, ?, ?);`,
        )
        .run(
          `workspace-resource-lease:${collisionKey}`,
          JSON.stringify({
            owner: 'approved-execution:alias-collision',
            physicalResourceKey: collisionKey,
            expiresAt: '2020-01-01T00:00:00.000Z',
          }),
          '2026-08-17T00:00:00.000Z',
        );
    } finally {
      collision.close();
    }
    const applied = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const appliedHashes = new Map(
        applied
          .prepare(
            'SELECT name, hash FROM __drizzle_migrations WHERE name LIKE ?;',
          )
          .all('20260817%')
          .map((row) => {
            const record = row as { name: string; hash: string };
            return [record.name, record.hash] as const;
          }),
      );
      for (const [name, hash] of [
        [
          '20260817023609_scheduled_task_workspaces',
          '9d08228fd65b36dc380c987411023bbd1935c222cb0219d87828fe27b21c10df',
        ],
        [
          '20260817063811_scheduled_workspace_required_identity',
          '0436a3d007825a303df2a5a001548b5675ed6678b86ad83907e3448dc06f2a2a',
        ],
        [
          '20260817092313_scheduled_workspace_repo_identity',
          '1b3d0acb9125dd824d80dc1b90f814bee2caa84199ccecf2e22bae8d8c24a511',
        ],
        [
          '20260817100124_scheduled_workspace_release_fence',
          '68456da88828c64066c0f6fb5bed8d540d0ee83afb841ca321683d14f101283c',
        ],
      ] as const) {
        expect(appliedHashes.get(name)).toBe(hash);
      }
    } finally {
      applied.close();
    }
    expect(applyAppDbMigrations(databasePath)).toMatchObject({
      applied: ['20260817111330_scheduled_workspace_forward_compatibility'],
      pending: [],
    });
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const lease = after
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(`workspace-resource-lease:${collisionKey}`) as {
        value: string;
      };
      expect(JSON.parse(lease.value)).toMatchObject({
        providerId: 'ssh-approved-exact',
      });
      expect(readAppDbMigrationStatus(databasePath)).toMatchObject({
        ok: true,
        pending: [],
        changed: [],
      });
    } finally {
      after.close();
    }
    await expect(
      readTaskWorkspaceForRun('run:legacy-local', paths),
    ).resolves.toMatchObject({
      providerSnapshot: {
        version: 1,
        providerId: 'local',
        driver: 'local',
      },
      physicalResourceKey: 'local:/workspaces/legacy-local',
      resourceMetadata: {
        privateHome: '/neondeck-legacy-unavailable/workspace-home',
      },
      collectionOwner: null,
      collectionExpiresAt: null,
      releaseFencedAt: null,
    });
    await expect(
      readTaskWorkspaceForRun('run:legacy-ssh', paths),
    ).resolves.toMatchObject({
      providerSnapshot: {
        version: 1,
        providerId: 'ssh-primary',
        driver: 'ssh',
        config: {
          driver: 'ssh',
          hostEnv: 'NEONDECK_LEGACY_WORKSPACE_PROVIDER_UNAVAILABLE',
          privateKeyEnv: 'NEONDECK_LEGACY_WORKSPACE_PRIVATE_KEY_UNAVAILABLE',
          username: 'user',
          port: 2222,
          remoteRoot: '/srv/neondeck',
        },
      },
      physicalResourceKey: collisionKey,
      resourceMetadata: {
        host: 'ssh.example.test',
        port: 2222,
        username: 'user',
        providerRoot: '/srv/neondeck',
        privateHome: '/neondeck-legacy-unavailable/home',
        managedInfrastructure: false,
        pathsCanonical: false,
      },
      collectionOwner: null,
      collectionExpiresAt: null,
      releaseFencedAt: null,
    });
    await expect(
      acquirePhysicalWorkspaceLease(
        {
          physicalResourceKey: collisionKey,
          providerId: 'ssh-new-request',
          owner: 'new-owner',
          ttlMs: 60_000,
        },
        paths,
      ),
    ).resolves.toBe(false);
    await expect(listPhysicalWorkspaceQuarantines(paths)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          physicalResourceKey: collisionKey,
          providerId: 'ssh-approved-exact',
          source: 'approved-execution',
          sourceId: 'alias-collision',
        }),
      ]),
    );
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

function preCoordinationWorkspaceSnapshot(input: {
  runId: string;
  workspaceId: string;
  providerId: string;
  providerResourceId: string;
  resourceMetadata: Record<string, unknown>;
  workspaceRoot: string;
  localWorktreeId: string | null;
}) {
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    snapshot: {
      id: input.workspaceId,
      taskId: `task:${input.runId}`,
      owningRunId: input.runId,
      providerId: input.providerId,
      providerResourceId: input.providerResourceId,
      resourceMetadata: input.resourceMetadata,
      lifecycle: 'per-run',
      repoId: 'repo',
      workspaceRoot: input.workspaceRoot,
      requestedRef: 'main',
      revisionMode: 'latest-each-run',
      gitMode: 'run-branch',
      branchName: `neondeck/schedules/legacy/${input.runId}`,
      baseSha: null,
      initialSha: null,
      finalSha: null,
      dirty: null,
      localWorktreeId: input.localWorktreeId,
      authority: 'trusted-workspace',
      retention: 'cleanup-success',
      status: 'retained',
      lockOwner: null,
      lockExpiresAt: null,
      retentionReason: null,
      providerError: null,
      createdAt: '2026-08-17T00:00:00.000Z',
      lastUsedAt: '2026-08-17T00:00:00.000Z',
      retainedAt: '2026-08-17T00:00:00.000Z',
      cleanupAttemptedAt: null,
      deletedAt: null,
      updatedAt: '2026-08-17T00:00:00.000Z',
    },
  };
}

function insertCurrentTaskWorkspace(
  database: DatabaseSync,
  input: {
    id: string;
    providerId: string;
    physicalResourceKey: string;
  },
) {
  database
    .prepare(
      `INSERT INTO task_workspaces (
         id, task_id, provider_id, provider_resource_id,
         provider_snapshot_json, physical_resource_key, resource_metadata_json,
         lifecycle, repo_id, repo_snapshot_json, workspace_root, requested_ref,
         revision_mode, git_mode, authority, retention, status,
         created_at, last_used_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    )
    .run(
      input.id,
      'task:provider-alias',
      input.providerId,
      'resource:provider-alias',
      JSON.stringify({
        version: 1,
        providerId: input.providerId,
        driver: 'ssh',
        config: {
          driver: 'ssh',
          hostEnv: 'SSH_ALIAS_HOST',
          privateKeyEnv: 'SSH_ALIAS_KEY',
          username: 'user',
          port: 2222,
          remoteRoot: '/srv/neondeck',
        },
      }),
      input.physicalResourceKey,
      JSON.stringify({
        host: 'ssh.example.test',
        port: 2222,
        username: 'user',
        providerRoot: '/srv/neondeck',
        privateHome: '/srv/neondeck-home/provider-alias',
        managedInfrastructure: false,
        managedDirectory: false,
        pathsCanonical: true,
      }),
      'existing',
      'repo',
      JSON.stringify({
        verified: false,
        id: 'repo',
        github: { owner: 'legacy-unavailable', name: 'legacy-unavailable' },
        path: '/srv/neondeck/task-ssh',
        defaultBranch: 'main',
      }),
      '/srv/neondeck/task-ssh',
      'main',
      'latest-each-run',
      'direct-branch',
      'trusted-workspace',
      'retain-always',
      'retained',
      '2026-08-17T00:00:00.000Z',
      '2026-08-17T00:00:00.000Z',
      '2026-08-17T00:00:00.000Z',
    );
}
