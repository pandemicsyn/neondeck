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
    expect(applyAppDbMigrations(databasePath)).toMatchObject({
      applied: migrations.map((migration) => migration.name),
      backupPath: null,
    });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(tableExists(database, 'notifications')).toBe(true);
      expect(tableExists(database, 'briefing_profiles')).toBe(true);
      expect(tableExists(database, 'briefing_runs')).toBe(true);
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

  it('backfills durable owners and active attempts for pre-package admissions', async () => {
    const root = await tempDir();
    const databasePath = join(root, 'neondeck.db');
    const oldMigrations = join(root, 'old-migrations');
    await mkdir(oldMigrations);
    for (const entry of await readdir(appDbMigrationsFolder())) {
      if (entry.includes('autopilot_product_closure')) continue;
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
          `INSERT INTO autopilot_admissions (
             id, watch_id, event_fingerprint, repo_id, pr_number, mode,
             input_json, state, current_run_id, worktree_id,
             attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'prepared', ?, ?, 1, ?, ?);`,
        )
        .run(
          'admission:legacy-prepared',
          'watch:legacy',
          'event:legacy-prepared',
          'repo',
          17,
          'prepare-only',
          'run:legacy-prepared',
          'worktree:legacy',
          '2026-07-16T00:00:00.000Z',
          '2026-07-16T00:01:00.000Z',
        );
      before
        .prepare(
          `INSERT INTO autopilot_admissions (
             id, watch_id, event_fingerprint, repo_id, pr_number, mode,
             input_json, state, current_workflow, current_run_id,
             attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'triage-admitted',
                     'triage-pr-event', ?, 1, ?, ?);`,
        )
        .run(
          'admission:legacy-stale',
          'watch:legacy',
          'event:legacy-stale',
          'repo',
          17,
          'prepare-only',
          'run:legacy-stale',
          '2026-07-17T00:00:00.000Z',
          '2026-07-17T00:01:00.000Z',
        );
      before
        .prepare(
          `INSERT INTO autopilot_admissions (
             id, watch_id, event_fingerprint, repo_id, pr_number, mode,
             input_json, state, current_workflow, current_run_id,
             attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'prepare-admitted',
                     'prepare-pr-worktree', ?, 2, ?, ?);`,
        )
        .run(
          'admission:legacy',
          'watch:legacy',
          'event:legacy',
          'repo',
          17,
          'prepare-only',
          'run:legacy',
          '2026-07-18T00:00:00.000Z',
          '2026-07-18T00:01:00.000Z',
        );
      before
        .prepare(
          `INSERT INTO autopilot_admissions (
             id, watch_id, event_fingerprint, repo_id, pr_number, mode,
             input_json, state, attempt_count, next_attempt_at, last_error,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, '{}', 'failed', 1, ?, ?, ?, ?);`,
        )
        .run(
          'admission:legacy-retry',
          'watch:legacy',
          'event:legacy-retry',
          'repo',
          17,
          'prepare-only',
          '2026-07-19T00:01:00.000Z',
          'legacy retry',
          '2026-07-19T00:00:00.000Z',
          '2026-07-19T00:00:00.000Z',
        );
    } finally {
      before.close();
    }

    expect(applyAppDbMigrations(databasePath).applied).toEqual([
      expect.stringContaining('autopilot_product_closure'),
    ]);
    const after = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        after
          .prepare(
            `SELECT owner_id, event_sequence, version, current_stage_attempt_id
             FROM autopilot_admissions WHERE id = ?;`,
          )
          .get('admission:legacy'),
      ).toMatchObject({
        owner_id: expect.stringContaining('autopilot-owner:migrated:'),
        event_sequence: 3,
        version: 1,
        current_stage_attempt_id: 'autopilot-attempt:migrated:admission:legacy',
      });
      expect(
        after
          .prepare(
            `SELECT stage, status, run_id FROM autopilot_stage_attempts
             WHERE admission_id = ?;`,
          )
          .get('admission:legacy'),
      ).toEqual({
        stage: 'prepare-worktree',
        status: 'running',
        run_id: 'run:legacy',
      });
      expect(
        after
          .prepare(
            `SELECT reason FROM autopilot_admission_events
             WHERE admission_id = ?;`,
          )
          .get('admission:legacy'),
      ).toEqual({ reason: 'migration-backfill' });
      expect(
        after
          .prepare(
            `SELECT state, current_run_id, current_stage_attempt_id, last_error
             FROM autopilot_admissions WHERE id = ?;`,
          )
          .get('admission:legacy-stale'),
      ).toEqual({
        state: 'manual-review',
        current_run_id: null,
        current_stage_attempt_id: null,
        last_error:
          'Migration found a newer active admission for this PR owner.',
      });
      expect(
        after
          .prepare(
            `SELECT COUNT(*) AS count FROM autopilot_stage_attempts
             WHERE owner_id = (
               SELECT owner_id FROM autopilot_admissions WHERE id = ?
             ) AND status IN ('reserved', 'running');`,
          )
          .get('admission:legacy'),
      ).toEqual({ count: 1 });
      expect(
        after
          .prepare(
            `SELECT worktree_id FROM autopilot_pr_owners
             WHERE id = (
               SELECT owner_id FROM autopilot_admissions WHERE id = ?
             );`,
          )
          .get('admission:legacy-prepared'),
      ).toEqual({ worktree_id: 'worktree:legacy' });
      expect(
        after
          .prepare(
            `SELECT state, next_attempt_at, completed_at, last_outcome_json
             FROM autopilot_admissions WHERE id = ?;`,
          )
          .get('admission:legacy-retry'),
      ).toMatchObject({
        state: 'manual-review',
        next_attempt_at: null,
        completed_at: '2026-07-19T00:00:00.000Z',
        last_outcome_json: expect.stringContaining(
          'migration-legacy-retry-unproven',
        ),
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
