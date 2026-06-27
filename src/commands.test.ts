import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkflowSummaries } from './app-state';
import { parseNeonCommand, runNeonCommand } from './commands';
import { runtimePaths } from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Neon commands', () => {
  it('parses supported slash commands with quoted args', () => {
    expect(parseNeonCommand('/repo-status "main repo"')).toMatchObject({
      ok: true,
      command: {
        name: 'repo-status',
        args: ['main repo'],
      },
    });
    expect(parseNeonCommand('repo-status')).toMatchObject({
      ok: false,
      requires: ['command'],
    });
    expect(parseNeonCommand('/unknown')).toMatchObject({
      ok: false,
      requires: ['supportedCommand'],
    });
  });

  it('runs repo-status and stores a workflow summary', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);
    await writeFile(join(repoPath, 'README.md'), '# changed\n');

    await expect(
      runNeonCommand({ command: '/repo-status neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'repo-status',
      status: 'completed',
      data: {
        repos: [
          {
            id: 'neondeck',
            dirty: true,
            changeCount: 1,
          },
        ],
      },
      workflowSummary: {
        workflow: 'command:repo-status',
        status: 'completed',
      },
    });
    await expect(listWorkflowSummaries(paths)).resolves.toMatchObject([
      { workflow: 'command:repo-status', status: 'completed' },
    ]);
  });

  it('runs review-queue through an injected GitHub fetcher', async () => {
    process.env.GITHUB_TOKEN = 'token';
    process.env.GITHUB_LOGIN = 'pandemicsyn';
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      runNeonCommand({ command: '/review-queue' }, paths, {
        fetchPullRequestQueue: async () => ({
          login: 'pandemicsyn',
          repos: ['pandemicsyn/neondeck'],
          items: [
            {
              id: 1,
              title: 'Add thing',
              repo: 'pandemicsyn/neondeck',
              number: 10,
              url: 'https://github.com/pandemicsyn/neondeck/pull/10',
              state: 'open',
              author: 'pandemicsyn',
              labels: [],
              comments: 0,
              updatedAt: '2026-06-27T20:00:00Z',
              createdAt: '2026-06-27T19:00:00Z',
            },
          ],
          fetchedAt: '2026-06-27T20:01:00Z',
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: 'review-queue',
      data: {
        count: 1,
        topActions: [
          {
            title: 'Review pandemicsyn/neondeck#10',
          },
        ],
      },
      workflowSummary: {
        workflow: 'command:review-queue',
      },
    });
  });

  it('runs briefing without GitHub config and records the missing requirement', async () => {
    delete process.env.GITHUB_TOKEN;
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      runNeonCommand({ command: '/briefing' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'briefing',
      data: {
        reviewQueue: {
          error: 'GITHUB_TOKEN is not configured.',
          requires: ['GITHUB_TOKEN'],
        },
      },
      workflowSummary: {
        workflow: 'command:briefing',
      },
    });
  });

  it('persists failed watch-pr command results', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      runNeonCommand({ command: '/watch-pr' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      command: 'watch-pr',
      status: 'failed',
      requires: ['ref'],
      workflowSummary: {
        workflow: 'command:watch-pr',
        status: 'failed',
      },
    });
  });
});

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function tempGitRepo() {
  const path = await tempDir('neondeck-repo-');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: path });
  await execFileAsync(
    'git',
    ['config', 'user.email', 'neondeck@example.test'],
    {
      cwd: path,
    },
  );
  await execFileAsync('git', ['config', 'user.name', 'Neondeck Test'], {
    cwd: path,
  });
  await writeFile(join(path, 'README.md'), '# test\n');
  await execFileAsync('git', ['add', 'README.md'], { cwd: path });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: path });
  return path;
}

async function writeRepoRegistry(path: string, repoPath: string) {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: repoPath,
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
}
