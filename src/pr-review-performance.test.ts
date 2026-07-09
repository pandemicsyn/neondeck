import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readLocalPullRequestFileDiff,
  readLocalPullRequestFiles,
} from './modules/pr-local-diffs';
import { runtimePaths, type RuntimePaths } from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

const warmTargets = {
  treeVisibleMs: 500,
  firstPatchMs: 1_000,
  threadsVisibleMs: 500,
};

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('PR review performance harness', () => {
  it('measures warm local tree, first patch, and threads timing against targets', async () => {
    const fixture = await largeFixture(305);

    const timing = await measureWarmReviewTiming({
      ...fixture,
      fetchThreads: async () => [{ id: 'thread-1', path: 'src/file-000.ts' }],
    });

    expect(timing.fileCount).toBe(305);
    expect(timing.threadCount).toBe(1);
    expect(timing.targets).toEqual(warmTargets);
    expect(timing.withinTargets).toEqual({
      treeVisible: expect.any(Boolean),
      firstPatch: expect.any(Boolean),
      threadsVisible: expect.any(Boolean),
    });
    expect(timing.treeVisibleMs).toBeGreaterThanOrEqual(0);
    expect(timing.firstPatchMs).toBeGreaterThanOrEqual(0);
    expect(timing.threadsVisibleMs).toBeGreaterThanOrEqual(0);
  });
});

async function measureWarmReviewTiming(input: {
  baseSha: string;
  headSha: string;
  paths: RuntimePaths;
  fetchThreads: () => Promise<unknown[]>;
}) {
  const treeStart = performance.now();
  const files = await readLocalPullRequestFiles(
    {
      owner: 'example',
      repo: 'large',
      number: 300,
      headSha: input.headSha,
      baseSha: input.baseSha,
      baseRef: 'main',
      includePatches: false,
    },
    input.paths,
  );
  const treeVisibleMs = performance.now() - treeStart;

  const patchStart = performance.now();
  await readLocalPullRequestFileDiff(
    {
      owner: 'example',
      repo: 'large',
      number: 300,
      headSha: input.headSha,
      baseSha: input.baseSha,
      baseRef: 'main',
      path: files.files[0]?.path ?? 'src/file-000.ts',
    },
    input.paths,
  );
  const firstPatchMs = performance.now() - patchStart;

  const threadsStart = performance.now();
  const threads = await input.fetchThreads();
  const threadsVisibleMs = performance.now() - threadsStart;

  return {
    fileCount: files.files.length,
    threadCount: threads.length,
    targets: warmTargets,
    withinTargets: {
      treeVisible: treeVisibleMs < warmTargets.treeVisibleMs,
      firstPatch: firstPatchMs < warmTargets.firstPatchMs,
      threadsVisible: threadsVisibleMs < warmTargets.threadsVisibleMs,
    },
    treeVisibleMs,
    firstPatchMs,
    threadsVisibleMs,
  };
}

async function largeFixture(fileCount: number) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-large-repo-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);
  await mkdir(join(repo, 'src'), { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, [
    'remote',
    'add',
    'origin',
    'git@github.com:example/large.git',
  ]);
  await writeFile(join(repo, 'README.md'), 'large fixture\n');
  await git(repo, ['add', '-A']);
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'base',
  ]);
  const baseSha = await git(repo, ['rev-parse', 'HEAD']);

  await Promise.all(
    Array.from({ length: fileCount }, (_, index) =>
      writeFile(
        join(repo, 'src', `file-${String(index).padStart(3, '0')}.ts`),
        `export const value${index} = ${index};\n`,
      ),
    ),
  );
  await git(repo, ['add', '-A']);
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'head',
  ]);
  const headSha = await git(repo, ['rev-parse', 'HEAD']);

  await mkdir(paths.home, { recursive: true });
  await writeFile(
    paths.repos,
    `${JSON.stringify({
      repos: [
        {
          id: 'large',
          github: { owner: 'example', name: 'large' },
          path: repo,
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );

  return { baseSha, headSha, paths };
}

async function git(repo: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd: repo });
  return stdout.trim();
}
