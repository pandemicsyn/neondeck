import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  readLocalPullRequestFileDiff,
  readLocalPullRequestFiles,
} from '../modules/pr-local-diffs';
import { runtimePaths, type RuntimePaths } from '../runtime-home';

const execFileAsync = promisify(execFile);

export type ReviewPerformanceFixtureProfile = {
  id: 'small' | 'medium' | 'large';
  fileCount: number;
  directoryCount: number;
  annotationCount: number;
  draftCount: number;
  findingCount: number;
};

export const reviewPerformanceFixtureProfiles = [
  {
    id: 'small',
    fileCount: 8,
    directoryCount: 2,
    annotationCount: 1,
    draftCount: 1,
    findingCount: 0,
  },
  {
    id: 'medium',
    fileCount: 90,
    directoryCount: 5,
    annotationCount: 6,
    draftCount: 4,
    findingCount: 5,
  },
  {
    id: 'large',
    fileCount: 305,
    directoryCount: 12,
    annotationCount: 18,
    draftCount: 12,
    findingCount: 16,
  },
] as const satisfies readonly ReviewPerformanceFixtureProfile[];

export type ReviewPerformanceFixture = {
  baseSha: string;
  headSha: string;
  owner: string;
  repo: string;
  number: number;
  paths: RuntimePaths;
  profile: ReviewPerformanceFixtureProfile;
  cleanup: () => Promise<void>;
};

export type ReviewFixtureTiming = {
  fileCount: number;
  threadCount: number;
  treeVisibleMs: number[];
  firstPatchMs: number[];
  threadsVisibleMs: number[];
  treeVisibleMedianMs: number;
  firstPatchMedianMs: number;
  threadsVisibleMedianMs: number;
};

export async function createReviewPerformanceFixture(
  profile: ReviewPerformanceFixtureProfile,
): Promise<ReviewPerformanceFixture> {
  const home = await mkdtemp(join(tmpdir(), `neondeck-${profile.id}-home-`));
  const repoRoot = await mkdtemp(
    join(tmpdir(), `neondeck-${profile.id}-review-`),
  );
  const paths = runtimePaths(home);
  const owner = 'example';
  const repo = `review-${profile.id}`;
  const files = fixtureFiles(profile);
  try {
    await git(repoRoot, ['init', '-b', 'main']);
    await git(repoRoot, [
      'remote',
      'add',
      'origin',
      `git@github.com:${owner}/${repo}.git`,
    ]);
    for (const file of files) {
      if (file.status === 'added') continue;
      const basePath = file.previousPath ?? file.path;
      await writeFixtureFile(repoRoot, basePath, file.index, 'base');
    }
    await git(repoRoot, ['add', '-A']);
    await commit(repoRoot, 'base');
    const baseSha = await git(repoRoot, ['rev-parse', 'HEAD']);

    for (const file of files) {
      if (file.status === 'deleted') {
        await rm(join(repoRoot, file.path));
      } else if (file.status === 'renamed' && file.previousPath) {
        await mkdir(dirname(join(repoRoot, file.path)), { recursive: true });
        await rename(
          join(repoRoot, file.previousPath),
          join(repoRoot, file.path),
        );
      } else {
        await writeFixtureFile(repoRoot, file.path, file.index, 'head');
      }
    }
    await git(repoRoot, ['add', '-A']);
    await commit(repoRoot, 'head');
    const headSha = await git(repoRoot, ['rev-parse', 'HEAD']);

    await mkdir(paths.home, { recursive: true });
    await writeFile(
      paths.repos,
      `${JSON.stringify({
        repos: [
          {
            id: profile.id,
            github: { owner, name: repo },
            path: repoRoot,
            defaultBranch: 'main',
          },
        ],
      })}\n`,
    );

    return {
      baseSha,
      headSha,
      owner,
      repo,
      number: profile.fileCount,
      paths,
      profile,
      cleanup: () =>
        Promise.all([
          rm(home, { recursive: true, force: true }),
          rm(repoRoot, { recursive: true, force: true }),
        ]).then(() => undefined),
    };
  } catch (error) {
    await Promise.all([
      rm(home, { recursive: true, force: true }),
      rm(repoRoot, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

export async function measureReviewPerformanceFixture(
  fixture: ReviewPerformanceFixture,
  samples = 5,
): Promise<ReviewFixtureTiming> {
  await readFiles(fixture);
  await readFirstPatch(fixture);
  const treeVisibleMs: number[] = [];
  const firstPatchMs: number[] = [];
  const threadsVisibleMs: number[] = [];
  let fileCount = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const treeStart = performance.now();
    const files = await readFiles(fixture);
    treeVisibleMs.push(performance.now() - treeStart);
    fileCount = files.files.length;

    const patchStart = performance.now();
    await readFirstPatch(fixture, files.files[0]?.path);
    firstPatchMs.push(performance.now() - patchStart);

    const threadsStart = performance.now();
    await fixtureThreads(fixture.profile.annotationCount);
    threadsVisibleMs.push(performance.now() - threadsStart);
  }
  return {
    fileCount,
    threadCount: fixture.profile.annotationCount,
    treeVisibleMs,
    firstPatchMs,
    threadsVisibleMs,
    treeVisibleMedianMs: median(treeVisibleMs),
    firstPatchMedianMs: median(firstPatchMs),
    threadsVisibleMedianMs: median(threadsVisibleMs),
  };
}

function fixtureThreads(count: number) {
  return Promise.resolve(
    Array.from({ length: count }, (_, index) => ({
      id: `thread-${index}`,
    })),
  );
}

function readFiles(fixture: ReviewPerformanceFixture) {
  return readLocalPullRequestFiles(
    {
      owner: fixture.owner,
      repo: fixture.repo,
      number: fixture.number,
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      baseRef: 'main',
      includePatches: false,
    },
    fixture.paths,
  );
}

function readFirstPatch(
  fixture: ReviewPerformanceFixture,
  path = 'packages/pkg-00/src/file-0000.ts',
) {
  return readLocalPullRequestFileDiff(
    {
      owner: fixture.owner,
      repo: fixture.repo,
      number: fixture.number,
      headSha: fixture.headSha,
      baseSha: fixture.baseSha,
      baseRef: 'main',
      path,
    },
    fixture.paths,
  );
}

function fixtureFiles(profile: ReviewPerformanceFixtureProfile) {
  return Array.from({ length: profile.fileCount }, (_, index) => {
    const directory = String(index % profile.directoryCount).padStart(2, '0');
    const filename = `file-${String(index).padStart(4, '0')}.ts`;
    const path = `packages/pkg-${directory}/src/${filename}`;
    const status = fixtureStatus(index);
    return {
      index,
      path,
      previousPath:
        status === 'renamed' ? `legacy/pkg-${directory}/${filename}` : null,
      status,
    };
  });
}

function fixtureStatus(index: number) {
  if (index % 17 === 0) return 'renamed' as const;
  if (index % 13 === 0) return 'deleted' as const;
  if (index % 3 === 0) return 'modified' as const;
  return 'added' as const;
}

async function writeFixtureFile(
  root: string,
  path: string,
  index: number,
  revision: 'base' | 'head',
) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(
    target,
    [
      `export const fixtureIndex = ${index};`,
      `export const fixtureRevision = '${revision}';`,
      `export const fixtureValue = ${revision === 'base' ? index : index + 1};`,
      '',
    ].join('\n'),
  );
}

function commit(root: string, message: string) {
  return git(root, [
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=Neondeck Fixture',
    '-c',
    'user.email=fixture@localhost',
    'commit',
    '-m',
    message,
  ]);
}

async function git(root: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd: root });
  return stdout.trim();
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
