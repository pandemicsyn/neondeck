import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('database CLI adapter', () => {
  it('prints app database migration status', async () => {
    const home = await tempHome();
    await ensureRuntimeHome(runtimePaths(home));

    const text = await runCli(home, ['db', 'status']);
    const json = await runCli(home, ['--json', 'db', 'status']);
    const parsed = JSON.parse(json.stdout);

    expect(text.stdout).toContain('db:current');
    expect(text.stdout).toContain('pending   0');
    expect(parsed.ok).toBe(true);
    expect(parsed.databasePath).toBe(join(home, 'data', 'neondeck.db'));
    expect(parsed.pending).toEqual([]);
  });

  it('exits nonzero for unhealthy JSON database migration status', async () => {
    const home = await tempHome();

    let error: unknown;
    try {
      await runCli(home, ['--json', 'db', 'status']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"ok": false'),
    });
    const parsed = JSON.parse((error as { stdout: string }).stdout);
    expect(parsed.message).toBe('Neondeck app database is missing.');
    expect(parsed.databasePath).toBe(join(home, 'data', 'neondeck.db'));
  });

  it('backs up, lists, and restores the app database without bootstrapping first', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    setRestoreValue(paths.neondeckDatabase, 'before backup');

    const backup = JSON.parse(
      (await runCli(home, ['--json', 'db', 'backup'])).stdout,
    );
    expect(backup).toMatchObject({
      ok: true,
      action: 'db_backup',
      backup: { kind: 'manual' },
    });
    const listed = JSON.parse(
      (await runCli(home, ['--json', 'db', 'backups'])).stdout,
    );
    expect(listed).toMatchObject({
      ok: true,
      action: 'db_backups',
      backups: [expect.objectContaining({ name: backup.backup.name })],
    });

    setRestoreValue(paths.neondeckDatabase, 'after backup');
    const restored = JSON.parse(
      (await runCli(home, ['--json', 'db', 'restore', backup.backup.name]))
        .stdout,
    );
    expect(restored).toMatchObject({
      ok: true,
      action: 'db_restore',
      restoredBackup: { name: backup.backup.name },
      safetyBackup: { kind: 'restore-safety' },
    });
    expect(readRestoreValue(paths.neondeckDatabase)).toBe('before backup');
  });

  it('does not bootstrap a runtime home for failing database backup commands', async () => {
    const home = await tempHome();

    let error: unknown;
    try {
      await runCli(home, ['--json', 'db', 'backup']);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ code: 1 });
    expect(JSON.parse((error as { stdout: string }).stdout)).toMatchObject({
      ok: false,
      action: 'db_backup',
    });
    expect(existsSync(join(home, 'data', 'neondeck.db'))).toBe(false);
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-cli-db-'));
  tempRoots.push(home);
  return home;
}

function runCli(home: string, args: string[]) {
  return execFileAsync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      'src/cli/index.ts',
      '--home',
      home,
      ...args,
    ],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        NEONDECK_DISABLE_SCHEDULER: '1',
      },
    },
  );
}

function setRestoreValue(databasePath: string, value: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      'CREATE TABLE IF NOT EXISTS cli_restore_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
    );
    database
      .prepare(
        'INSERT INTO cli_restore_values (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value;',
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
          .prepare('SELECT value FROM cli_restore_values WHERE id = 1;')
          .get() as { value: unknown }
      ).value,
    );
  } finally {
    database.close();
  }
}
