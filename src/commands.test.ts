import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { listWorkflowSummaries } from './modules/app-state';
import { readAgentModelSelectionSync } from './modules/runtime';
import { parseNeonCommand, runNeonCommand } from './modules/commands';
import { updateAgentModels } from './modules/config';
import { listRepoStatus, runDevDoctor } from './modules/runtime';
import { runtimePaths } from './runtime-home';
import { readNeonSessionState } from './modules/sessions';
import { addPrWatch } from './modules/watches';

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
    expect(parseNeonCommand('/dev-doctor')).toMatchObject({
      ok: true,
      command: {
        name: 'dev-doctor',
        args: [],
      },
    });
    expect(parseNeonCommand('/watch-release neondeck')).toMatchObject({
      ok: true,
      command: {
        name: 'watch-release',
        args: ['neondeck'],
      },
    });
    expect(parseNeonCommand('/explain-ci neondeck#10')).toMatchObject({
      ok: true,
      command: {
        name: 'explain-ci',
        args: ['neondeck#10'],
      },
    });
    expect(parseNeonCommand('/draft-pr-description')).toMatchObject({
      ok: true,
      command: {
        name: 'draft-pr-description',
        args: [],
      },
    });
    expect(parseNeonCommand('/reasoning high')).toMatchObject({
      ok: true,
      command: {
        name: 'reasoning',
        args: ['high'],
      },
    });
    expect(
      parseNeonCommand('/memory set session current-task "ship it"'),
    ).toMatchObject({
      ok: true,
      command: {
        name: 'memory',
        args: ['set', 'session', 'current-task', 'ship it'],
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
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);
    await addPrWatch(
      { ref: 'neondeck#10' },
      paths,
      async () => ({
        number: 10,
        title: 'Add thing',
        repo: 'pandemicsyn/neondeck',
        url: 'https://github.com/pandemicsyn/neondeck/pull/10',
        state: 'open',
        merged: false,
        mergeCommitSha: null,
        headSha: 'abc123',
        baseRef: 'main',
        updatedAt: '2026-06-27T20:00:00Z',
      }),
      async () => ({
        status: 'failure',
        total: 2,
        successful: 1,
        failed: 1,
        pending: 0,
        checkedAt: '2026-06-27T20:00:30Z',
      }),
    );

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
              relations: ['review-requested', 'configured-repo'],
              ageDays: 0,
              stale: false,
              headSha: 'abc123',
              baseRef: 'main',
              checks: {
                status: 'failure',
                total: 2,
                successful: 1,
                failed: 1,
                pending: 0,
                checkedAt: '2026-06-27T20:00:30Z',
              },
            },
          ],
          fetchedAt: '2026-06-27T20:01:00Z',
          truncated: false,
          issues: [],
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: 'review-queue',
      data: {
        count: 1,
        triage: {
          summary: {
            requestedReviews: 1,
            failedChecks: 1,
            activeWatches: 1,
          },
          requestedReviews: [
            {
              repo: 'pandemicsyn/neondeck',
              number: 10,
              checks: 'failure',
            },
          ],
          failedChecks: [
            {
              repo: 'pandemicsyn/neondeck',
              number: 10,
            },
          ],
          activeWatches: [
            {
              id: 'pandemicsyn/neondeck#10',
              status: 'watching',
            },
          ],
        },
        topActions: [
          {
            title: 'Fix failing checks: pandemicsyn/neondeck#10',
            priority: 'urgent',
          },
        ],
      },
      workflowSummary: {
        workflow: 'command:review-queue',
      },
    });
  });

  it('explains CI for a selected PR from deterministic GitHub queue data', async () => {
    process.env.GITHUB_TOKEN = 'token';
    process.env.GITHUB_LOGIN = 'pandemicsyn';
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);

    await expect(
      runNeonCommand({ command: '/explain-ci neondeck#10' }, paths, {
        fetchPullRequestQueue: async () => ({
          login: 'pandemicsyn',
          repos: ['pandemicsyn/neondeck'],
          items: [testPr({ checks: 'failure' })],
          fetchedAt: '2026-06-27T20:01:00Z',
          truncated: false,
          issues: [],
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: 'explain-ci',
      message: 'pandemicsyn/neondeck#10 CI is failure.',
      data: {
        checks: {
          status: 'failure',
          failed: 1,
        },
        explanation: {
          status: 'failure',
          nextActions: expect.arrayContaining([
            'Open the failing GitHub checks and inspect the first failed job log.',
          ]),
        },
      },
      workflowSummary: {
        workflow: 'command:explain-ci',
      },
    });
  });

  it('summarizes a selected PR from deterministic GitHub queue data', async () => {
    process.env.GITHUB_TOKEN = 'token';
    process.env.GITHUB_LOGIN = 'pandemicsyn';
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);

    await expect(
      runNeonCommand({ command: '/summarize-pr neondeck#10' }, paths, {
        fetchPullRequestQueue: async () => ({
          login: 'pandemicsyn',
          repos: ['pandemicsyn/neondeck'],
          items: [testPr({ checks: 'success' })],
          fetchedAt: '2026-06-27T20:01:00Z',
          truncated: false,
          issues: [],
        }),
      }),
    ).resolves.toMatchObject({
      ok: true,
      command: 'summarize-pr',
      data: {
        summary: {
          headline: 'pandemicsyn/neondeck#10: Add thing',
          checks: 'success',
          relations: ['review-requested', 'configured-repo'],
        },
      },
      workflowSummary: {
        workflow: 'command:summarize-pr',
      },
    });
  });

  it('drafts a PR description from local repo status', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath, {
      packageScripts: { check: 'npm run lint && npm run test' },
    });
    await writeFile(join(repoPath, 'feature.txt'), 'changed\n');

    await expect(
      runNeonCommand({ command: '/draft-pr-description neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'draft-pr-description',
      data: {
        draft: {
          title: 'neondeck: <short change summary>',
          body: expect.stringContaining('npm run check'),
        },
        health: {
          dirty: true,
          changeCount: 1,
        },
      },
      workflowSummary: {
        workflow: 'command:draft-pr-description',
      },
    });
  });

  it('prepares PR readiness checks from deterministic repo status', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);
    await writeFile(join(repoPath, 'README.md'), '# changed\n');

    await expect(
      runNeonCommand({ command: '/prepare-pr neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'prepare-pr',
      data: {
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: 'working-tree',
            status: 'attention',
          }),
          expect.objectContaining({ id: 'branch' }),
          expect.objectContaining({ id: 'upstream' }),
          expect.objectContaining({ id: 'validation' }),
        ]),
      },
      workflowSummary: {
        workflow: 'command:prepare-pr',
      },
    });
  });

  it('reviews local repo status and reports deterministic findings', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);
    await writeFile(join(repoPath, 'README.md'), '# changed\n');

    await expect(
      runNeonCommand({ command: '/review-local neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'review-local',
      data: {
        findings: expect.arrayContaining([
          expect.objectContaining({
            title: 'Working on default branch',
          }),
          expect.objectContaining({
            title: 'Uncommitted changes present',
          }),
        ]),
        diff: {
          ok: true,
          fileCount: 1,
          additions: 1,
          deletions: 1,
        },
      },
      workflowSummary: {
        workflow: 'command:review-local',
      },
    });
  });

  it('does not invent review findings for a clean topic branch', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    await execFileAsync('git', ['checkout', '-b', 'feature/test'], {
      cwd: repoPath,
    });
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);

    await expect(
      runNeonCommand({ command: '/review-local neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'review-local',
      message: 'No deterministic local review findings for neondeck.',
      data: {
        findings: [],
        diff: {
          ok: true,
          fileCount: 0,
        },
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

  it('lists and updates structured memory through the memory command', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);

    await expect(
      runNeonCommand(
        { command: '/memory set local current-task "finish roadmap item 3"' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      command: 'memory',
      data: {
        action: 'memory_upsert',
        memory: {
          scope: 'local',
          key: 'current-task',
          value: 'finish roadmap item 3',
        },
      },
      workflowSummary: {
        workflow: 'command:memory',
      },
    });

    await expect(
      runNeonCommand({ command: '/memory local' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'memory',
      message: 'Listed 1 durable memory entry.',
      data: {
        memories: [
          {
            scope: 'local',
            key: 'current-task',
            value: 'finish roadmap item 3',
          },
        ],
      },
    });
  });

  it('shows and changes display assistant reasoning through slash command', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    const beforeSession = await readNeonSessionState(paths);

    await expect(
      runNeonCommand({ command: '/reasoning' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'reasoning',
      status: 'completed',
      message: 'Current reasoning is medium for kilocode/kilo-auto/balanced.',
      data: {
        model: 'kilocode/kilo-auto/balanced',
        thinkingLevel: 'medium',
        supportedLevels: expect.arrayContaining(['off', 'high', 'xhigh']),
      },
      workflowSummary: {
        workflow: 'command:reasoning',
        status: 'completed',
      },
    });

    await expect(
      runNeonCommand({ command: '/reasoning high' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'reasoning',
      status: 'completed',
      message:
        'Set reasoning to high for kilocode/kilo-auto/balanced and started a fresh Neon session.',
      data: {
        model: 'kilocode/kilo-auto/balanced',
        previousLevel: 'medium',
        thinkingLevel: 'high',
        sessionStarted: true,
        session: {
          activeSession: {
            label: 'Reasoning high',
            reason: 'reasoning-level:high',
          },
        },
      },
      workflowSummary: {
        workflow: 'command:reasoning',
        status: 'completed',
      },
    });

    expect(readAgentModelSelectionSync(paths)).toMatchObject({
      displayAssistantThinkingLevel: 'high',
    });
    const afterSession = await readNeonSessionState(paths);
    expect(afterSession.activeSession.id).not.toBe(
      beforeSession.activeSession.id,
    );
  });

  it('rejects reasoning levels unsupported by the selected model', async () => {
    const home = await tempDir('neondeck-home-');
    const paths = runtimePaths(home);
    await updateAgentModels(
      {
        displayAssistant: 'openai/gpt-4o',
        displayAssistantThinkingLevel: 'off',
      },
      paths,
    );

    await expect(
      runNeonCommand({ command: '/reasoning high' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      command: 'reasoning',
      status: 'failed',
      requires: ['reasoningLevel'],
      message: 'openai/gpt-4o supports off reasoning, not "high".',
      data: {
        model: 'openai/gpt-4o',
        currentLevel: 'off',
        requestedLevel: 'high',
        supportedLevels: ['off'],
      },
      workflowSummary: {
        workflow: 'command:reasoning',
        status: 'failed',
      },
    });
  });

  it('runs dev-doctor and stores structured local diagnostics', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);

    await expect(
      runNeonCommand({ command: '/dev-doctor' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'dev-doctor',
      status: 'completed',
      data: {
        action: 'dev_doctor_run',
        summary: {
          repos: 1,
        },
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'repos' }),
          expect.objectContaining({ id: 'package-scripts' }),
          expect.objectContaining({ id: 'node-version' }),
          expect.objectContaining({ id: 'env' }),
          expect.objectContaining({ id: 'ports' }),
          expect.objectContaining({ id: 'server' }),
          expect.objectContaining({ id: 'databases' }),
        ]),
      },
      workflowSummary: {
        workflow: 'command:dev-doctor',
        status: 'completed',
      },
    });
  });

  it('creates runtime databases before reporting diagnostics', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);

    await expect(runDevDoctor(paths)).resolves.toMatchObject({
      changed: false,
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: 'databases',
          status: 'ok',
          data: {
            databases: expect.arrayContaining([
              expect.objectContaining({ id: 'neondeck', exists: true }),
              expect.objectContaining({ id: 'flue', exists: true }),
            ]),
          },
        }),
      ]),
    });
  });

  it('lists repo status through a direct deterministic action', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);

    await expect(listRepoStatus(paths)).resolves.toMatchObject({
      ok: true,
      action: 'repo_status_list',
      changed: false,
      repos: [
        expect.objectContaining({
          id: 'neondeck',
          dirty: false,
          changeCount: 0,
        }),
      ],
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

  it('creates a release watch through slash command workflow', async () => {
    const home = await tempDir('neondeck-home-');
    const repoPath = await tempGitRepo();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos, repoPath);

    await expect(
      runNeonCommand({ command: '/watch-release neondeck' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      command: 'watch-release',
      status: 'completed',
      data: {
        result: {
          ok: true,
          action: 'schedule_blueprint_create',
          jobs: expect.arrayContaining([
            expect.objectContaining({
              id: 'schedule:release-watch-neondeck',
              type: 'release-watch',
            }),
          ]),
        },
      },
      workflowSummary: {
        workflow: 'command:watch-release',
        status: 'completed',
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

async function writeRepoRegistry(
  path: string,
  repoPath: string,
  options: { packageScripts?: Record<string, string> } = {},
) {
  await writeFile(
    path,
    `${JSON.stringify({
      repos: [
        {
          id: 'neondeck',
          github: { owner: 'pandemicsyn', name: 'neondeck' },
          path: repoPath,
          defaultBranch: 'main',
          ...(options.packageScripts
            ? { packageScripts: options.packageScripts }
            : {}),
        },
      ],
    })}\n`,
  );
}

function testPr(options: { checks: 'success' | 'failure' | 'pending' }) {
  return {
    id: 1,
    title: 'Add thing',
    repo: 'pandemicsyn/neondeck',
    number: 10,
    url: 'https://github.com/pandemicsyn/neondeck/pull/10',
    state: 'open',
    author: 'pandemicsyn',
    labels: ['feature'],
    comments: 2,
    updatedAt: '2026-06-27T20:00:00Z',
    createdAt: '2026-06-27T19:00:00Z',
    relations: ['review-requested' as const, 'configured-repo' as const],
    ageDays: 0,
    stale: false,
    headSha: 'abc123',
    baseRef: 'main',
    checks: {
      status: options.checks,
      total: 2,
      successful: options.checks === 'success' ? 2 : 1,
      failed: options.checks === 'failure' ? 1 : 0,
      pending: options.checks === 'pending' ? 1 : 0,
      checkedAt: '2026-06-27T20:00:30Z',
    },
  };
}
