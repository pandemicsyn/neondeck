import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  listPreparedDiffs,
  readPreparedDiffChangedFiles,
  readPreparedDiffFileDiff,
  readPreparedDiffSummary,
} from './modules/prepared-diffs';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { gitDiff, gitWorktreeRevision } from './repo-edit/git';
import {
  createWorktree,
  lockWorktree,
  releaseWorktreeLock,
} from './modules/worktrees';
import {
  createSeededGitRepository,
  type SeededGitRepository,
} from './testing/git-repository-fixture';
import {
  resolvedReviewRevision,
  reviewRevisionKey,
} from '../shared/review-source';

const tempRoots: string[] = [];
let repositorySeed: SeededGitRepository | undefined;

vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
  repositorySeed = await createSeededGitRepository({
    initialFiles: { 'src/app.ts': 'export const value = 1;\n' },
    feature: {
      files: { 'src/app.ts': 'export const value = 2;\n' },
    },
  });
});

afterAll(async () => {
  await repositorySeed?.dispose();
});

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('prepared diff readers', () => {
  it('reads prepared worktree diffs and rejects a stale revision', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);

    const listed = await listPreparedDiffs({}, paths);
    const summary = await readPreparedDiffSummary(
      { preparedDiffId: prepared.id },
      paths,
    );
    const files = await readPreparedDiffChangedFiles(
      { preparedDiffId: prepared.id },
      paths,
    );
    expect(listed).toMatchObject({
      ok: true,
      preparedDiffs: [
        expect.objectContaining({
          id: prepared.id,
          worktreeId: prepared.worktreeId,
          sourceOfTruth: 'worktree',
          status: 'prepared',
        }),
      ],
    });
    expect(summary).toMatchObject({
      ok: true,
      diffSummary: { files: 1, additions: 1, deletions: 1 },
    });
    expect(files.files).toEqual([
      expect.objectContaining({ path: 'src/app.ts', status: 'M' }),
    ]);
    expect(files.revision).toMatchObject({
      state: 'resolved',
      kind: 'worktree-diff',
      id: expect.any(String),
      baseId: expect.any(String),
    });
    const revisionKey = reviewRevisionKey(files.revision!);
    const fileDiff = await readPreparedDiffFileDiff(
      {
        preparedDiffId: prepared.id,
        path: 'src/app.ts',
        expectedRevisionKey: revisionKey ?? '',
      },
      paths,
    );
    expect(fileDiff).toMatchObject({ ok: true, revision: files.revision });
    await writeFile(
      join(prepared.sourceWorktreePath, 'src/app.ts'),
      'export const value = 3;\n',
    );
    await expect(
      readPreparedDiffFileDiff(
        {
          preparedDiffId: prepared.id,
          path: 'src/app.ts',
          expectedRevisionKey: revisionKey ?? '',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['refresh'],
      errors: ['The requested revision is stale.'],
    });
  });

  it('rejects a patch when the worktree changes during its read', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    const before = resolvedReviewRevision({
      kind: 'worktree-diff',
      id: 'revision-a',
      baseId: 'base',
    });
    const after = resolvedReviewRevision({
      kind: 'worktree-diff',
      id: 'revision-b',
      baseId: 'base',
    });
    const metadata = diffMetadata('src/app.ts');
    const patch = {
      ...metadata,
      files: [{ ...metadata.files[0]!, patch: 'patch from revision-a' }],
    };
    const gitDiffMock = vi
      .fn<typeof gitDiff>()
      .mockResolvedValueOnce(metadata)
      .mockResolvedValueOnce(patch)
      .mockResolvedValueOnce(metadata);
    const gitWorktreeRevisionMock = vi
      .fn<typeof gitWorktreeRevision>()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    await expect(
      readPreparedDiffFileDiff(
        {
          preparedDiffId: prepared.id,
          path: 'src/app.ts',
          expectedRevisionKey: reviewRevisionKey(before)!,
        },
        paths,
        {
          gitDiff: gitDiffMock,
          gitWorktreeRevision: gitWorktreeRevisionMock,
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      revision: after,
      requires: ['refresh'],
    });
  });

  it.each([
    ['changed files', readPreparedDiffChangedFiles],
    ['summary', readPreparedDiffSummary],
  ] as const)(
    'rejects %s metadata when the worktree mutates during fingerprinting',
    async (_label, read) => {
      const { paths } = await fixture();
      const prepared = await preparedFixture(paths);
      const revision = resolvedReviewRevision({
        kind: 'worktree-diff',
        id: 'revision-b',
        baseId: 'base',
      });
      const metadataA = diffMetadata('src/old.ts');
      const metadataB = diffMetadata('src/current.ts');
      let mutated = false;
      const gitDiffMock = vi.fn<typeof gitDiff>(async () =>
        mutated ? metadataB : metadataA,
      );
      const gitWorktreeRevisionMock = vi.fn<typeof gitWorktreeRevision>(
        async () => {
          mutated = true;
          return revision;
        },
      );

      await expect(
        read({ preparedDiffId: prepared.id }, paths, {
          gitDiff: gitDiffMock,
          gitWorktreeRevision: gitWorktreeRevisionMock,
        }),
      ).resolves.toMatchObject({
        ok: false,
        revision,
        requires: ['refresh'],
      });
    },
  );
});

function diffMetadata(path: string) {
  return {
    base: 'HEAD',
    files: [
      {
        path,
        status: 'M',
        additions: 1,
        deletions: 1,
        binary: false,
        generatedLike: false,
      },
    ],
    summary: {
      files: 1,
      additions: 1,
      deletions: 1,
      binaryFiles: 0,
    },
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-prepared-diff-'));
  const repoRoot = await mkdtemp(join(tmpdir(), 'neondeck-prepared-source-'));
  const repo = join(repoRoot, 'repository');
  tempRoots.push(home, repoRoot);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  if (!repositorySeed) {
    throw new Error('Prepared diff Git repository seed is unavailable.');
  }
  await repositorySeed.copyTo(repo);
  await writeFile(
    paths.repos,
    `${JSON.stringify(
      {
        repos: [
          {
            id: 'sample',
            github: { owner: 'pandemicsyn', name: 'sample' },
            path: repo,
            defaultBranch: 'main',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { paths };
}

async function preparedFixture(paths: ReturnType<typeof runtimePaths>) {
  const created = await createWorktree(
    { repoId: 'sample', prNumber: 7, baseRef: 'main', headRef: 'feature' },
    paths,
  );
  const worktree = objectField(created, 'worktree');
  const worktreeId = stringField(worktree, 'id');
  const locked = await lockWorktree(
    { worktreeId, scope: 'pr', owner: 'test', ttlSeconds: 300 },
    paths,
  );
  const lock = objectField(locked, 'lock');
  const released = await releaseWorktreeLock(
    {
      lockId: stringField(lock, 'id'),
      owner: 'test',
      finalStatus: 'prepared-diff',
    },
    paths,
  );
  expect(released).toMatchObject({ ok: true });
  const listed = await listPreparedDiffs({}, paths);
  const prepared = listed.preparedDiffs?.[0];
  if (!prepared) throw new Error('Missing prepared diff fixture.');
  return prepared;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(`Missing object field ${field}.`);
  }
  const child = (value as Record<string, unknown>)[field];
  if (!child || typeof child !== 'object') {
    throw new Error(`Missing object field ${field}.`);
  }
  return child as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string) {
  const child = value[field];
  if (typeof child !== 'string') {
    throw new Error(`Missing string field ${field}.`);
  }
  return child;
}
