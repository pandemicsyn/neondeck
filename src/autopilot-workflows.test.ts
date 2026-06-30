import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimePaths } from './runtime-home';
import { preparePrWorktree, triagePrEvent } from './autopilot-workflows';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR event autopilot', () => {
  it('classifies actionable review feedback according to autopilot mode', async () => {
    const result = await triagePrEvent({
      repoId: 'sample',
      prNumber: 7,
      source: 'fixture',
      autopilotMode: 'auto-fix-no-push',
      current: {
        state: 'open',
        draft: false,
        headSha: 'abc123',
        baseRef: 'main',
      },
      deltas: [
        {
          type: 'requested-changes',
          id: 'review-1',
          actionable: true,
          severity: 'high',
          summary: 'Reviewer requested a small code change.',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_triage_pr_event',
      data: {
        classification: 'auto-fix-no-push',
        shouldPrepareWorktree: true,
        nextWorkflow: 'prepare_pr_worktree',
      },
    });
  });

  it('keeps merge conflicts in explain-only triage', async () => {
    const result = await triagePrEvent({
      repoId: 'sample',
      prNumber: 8,
      source: 'fixture',
      autopilotMode: 'draft-fix',
      current: { state: 'open', mergeable: false },
      deltas: [{ type: 'merge-conflict', actionable: true }],
    });

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      data: {
        classification: 'explain-only',
        shouldPrepareWorktree: false,
      },
    });
  });

  it('prepares a managed PR worktree from deterministic PR facts', async () => {
    const { paths, featureSha } = await fixture();
    const result = await preparePrWorktree(
      {
        repoId: 'sample',
        prNumber: 7,
        eventId: 'watch-event-1',
        lockOwner: 'test-prepare',
      },
      paths,
      {
        token: 'test-token',
        async fetchPullRequestDetail() {
          return {
            number: 7,
            title: 'Update feature',
            repo: 'example/sample',
            url: 'https://github.com/example/sample/pull/7',
            state: 'open',
            draft: false,
            merged: false,
            mergeCommitSha: null,
            headSha: featureSha,
            headRef: 'feature',
            headOwner: 'example',
            headName: 'sample',
            baseRef: 'main',
            updatedAt: '2026-06-30T00:00:00.000Z',
            maintainerCanModify: true,
          };
        },
        async fetchCheckSummary() {
          return {
            status: 'success',
            total: 1,
            successful: 1,
            failed: 0,
            pending: 0,
            checkedAt: '2026-06-30T00:00:00.000Z',
          };
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'autopilot_prepare_pr_worktree',
      data: {
        repo: { id: 'sample', fullName: 'example/sample' },
        pr: { number: 7, headSha: featureSha },
        checks: { status: 'success' },
        worktree: {
          repoId: 'sample',
          prNumber: 7,
          lifecycleStatus: 'ready',
          directPushAllowed: true,
        },
        lock: {
          scope: 'pr',
          owner: 'test-prepare',
        },
        status: {
          ok: true,
          git: { dirty: false },
        },
        eventId: 'watch-event-1',
        runLinkage: { owningWorkflowRunIdAttached: false },
      },
    });
  });

  it('does not accept caller-supplied PR facts as authoritative input', async () => {
    const { paths, featureSha } = await fixture();
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await preparePrWorktree(
        {
          repoId: 'sample',
          prNumber: 7,
          pr: {
            number: 7,
            title: 'Fabricated',
            repo: 'example/sample',
            url: 'https://github.com/example/sample/pull/7',
            state: 'open',
            headSha: featureSha,
            headRef: 'feature',
            baseRef: 'main',
            updatedAt: '2026-06-30T00:00:00.000Z',
            maintainerCanModify: true,
          },
          checks: {
            status: 'success',
            total: 1,
            successful: 1,
            failed: 0,
            pending: 0,
            checkedAt: '2026-06-30T00:00:00.000Z',
          },
        },
        paths,
      );

      expect(result).toMatchObject({
        ok: false,
        action: 'autopilot_prepare_pr_worktree',
        message: 'Invalid autopilot input.',
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = previousToken;
      }
    }
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-repo-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);

  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'main']);
  await git(repo, ['checkout', '-b', 'feature']);
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 2;\n');
  await git(repo, ['commit', '-am', 'feature']);
  const featureSha = await gitOutput(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['checkout', 'main']);

  await mkdir(paths.home, { recursive: true });
  await writeFile(
    paths.repos,
    `${JSON.stringify(
      {
        repos: [
          {
            id: 'sample',
            github: { owner: 'example', name: 'sample' },
            path: repo,
            defaultBranch: 'main',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { paths, featureSha: featureSha.trim() };
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}
