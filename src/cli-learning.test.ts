import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryCandidate } from './modules/memory';
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

describe('learning CLI adapter', () => {
  it('prints learning status and target-filtered candidate lists', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await createMemoryCandidate(
      {
        action: 'upsert',
        scope: 'local',
        key: 'cli.adapter',
        value: 'CLI learning adapter coverage.',
        reason: 'CLI output test.',
      },
      paths,
    );

    const status = await runCli(home, ['learning', 'status', '--limit', '1']);
    const candidates = await runCli(home, [
      'learning',
      'candidates',
      '--target',
      'memory',
      '--status',
      'proposed',
      '--limit',
      '1',
    ]);

    expect(status.stdout).toContain('learning:ready');
    expect(status.stdout).toContain('pending');
    expect(candidates.stdout).toContain('candidates 1');
    expect(candidates.stdout).toContain('local:cli.adapter');
  });

  it('validates candidate filters and restore paths before mutating state', async () => {
    const home = await tempHome();

    await expect(
      runCli(home, ['learning', 'candidates', '--target', 'bogus']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('--target must be memory or skill'),
    });
    await expect(
      runCli(home, ['learning', 'candidates', '--status', 'bogus']),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        '--status must be proposed, applied, rejected, or archived',
      ),
    });
    await expect(
      runCli(home, ['learning', 'restore-skill-patch', 'missing-patch']),
    ).rejects.toMatchObject({
      stdout: expect.stringContaining('Skill patch was not found.'),
    });
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-cli-learning-'));
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
