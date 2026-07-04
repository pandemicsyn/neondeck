import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-cli-db-'));
  tempRoots.push(home);
  return home;
}

function runCli(home: string, args: string[]) {
  return execFileAsync(
    tsxBin(),
    ['src/cli/index.ts', '--home', home, ...args],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        NEONDECK_DISABLE_SCHEDULER: '1',
      },
    },
  );
}

function tsxBin() {
  return resolve(
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
}
