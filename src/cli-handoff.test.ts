import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('agent handoff CLI', () => {
  it('prints the register-pr JSON contract', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeRepoRegistry(paths.repos);

    const result = await runCli(home, [
      '--json',
      'register-pr',
      'neondeck#123',
      '--from',
      'codex',
      '--note',
      'Adds retry logic.',
      '--no-watch',
    ]);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      action: string;
      changed: boolean;
      id?: string;
      message: string;
      deckUrl?: string;
      notification?: { source?: string; data?: { prNumber?: number } };
    };

    expect(parsed).toMatchObject({
      ok: true,
      action: 'handoff_pr_register',
      changed: true,
      deckUrl: '/',
      notification: {
        source: 'external:codex',
        data: { prNumber: 123 },
      },
    });
    expect(parsed.id).toEqual(expect.any(String));
    expect(parsed.message).toContain('Registered pandemicsyn/neondeck#123');
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-cli-handoff-'));
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

async function writeRepoRegistry(path: string) {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: '/src/neondeck',
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
}

function tsxBin() {
  return resolve(
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
}
