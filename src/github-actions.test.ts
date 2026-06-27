import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getGitHubCheckSummary, listGitHubPrQueue } from './github-actions';
import { runtimePaths } from './runtime-home';

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

describe('GitHub Flue actions', () => {
  it('returns structured requirements when token is missing', async () => {
    delete process.env.GITHUB_TOKEN;
    await expect(listGitHubPrQueue()).resolves.toMatchObject({
      ok: false,
      action: 'github_pr_queue_list',
      requires: ['GITHUB_TOKEN'],
    });
  });

  it('fetches check summaries for configured repo default branch', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const refs: string[] = [];
    const home = await tempHome();
    const paths = runtimePaths(home);
    await writeRepoRegistry(paths.repos);

    await expect(
      getGitHubCheckSummary({ repo: 'neondeck' }, paths, {
        fetchCheckSummary: async (input) => {
          refs.push(input.ref);
          return {
            status: 'success',
            total: 1,
            successful: 1,
            failed: 0,
            pending: 0,
            checkedAt: '2026-06-27T20:05:30Z',
          };
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      action: 'github_check_summary_get',
      data: {
        repo: 'neondeck',
        repoFullName: 'pandemicsyn/neondeck',
        ref: 'main',
        checks: { status: 'success' },
      },
    });
    expect(refs).toEqual(['main']);
  });
});

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  tempRoots.push(home);
  return home;
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
