import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitHubPullRequestDetail } from './modules/github';
import { addPrWatch } from './modules/watches';
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

  it('accepts command-local trailing JSON for documented handoff commands', async () => {
    const home = await tempHome();
    const paths = runtimePaths(home);
    await ensureRuntimeHome(paths);
    await writeRepoRegistry(paths.repos);
    await addPrWatch({ ref: 'neondeck#123' }, paths, async () => prDetail());

    for (const command of [
      {
        args: ['watch-pr', 'neondeck#123', '--json'],
        action: 'watch_pr_add',
      },
      {
        args: ['note', 'Finished', 'handoff', '--from', 'codex', '--json'],
        action: 'handoff_note_create',
      },
      {
        args: [
          'register-pr',
          'neondeck#123',
          '--from',
          'codex',
          '--note',
          'Adds retry logic.',
          '--no-watch',
          '--json',
        ],
        action: 'handoff_pr_register',
      },
    ]) {
      const result = await runCli(home, command.args);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        action: string;
      };

      expect(parsed).toMatchObject({
        ok: true,
        action: command.action,
      });
    }
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-cli-handoff-'));
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

function prDetail(
  overrides: Partial<GitHubPullRequestDetail> = {},
): GitHubPullRequestDetail {
  return {
    number: 123,
    title: 'Test PR',
    repo: 'pandemicsyn/neondeck',
    url: 'https://github.com/pandemicsyn/neondeck/pull/123',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    headSha: 'head123',
    baseRef: 'main',
    updatedAt: '2026-06-27T20:00:00Z',
    ...overrides,
  };
}
