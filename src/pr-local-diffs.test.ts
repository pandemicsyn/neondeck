import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readLocalPullRequestFileDiff,
  readLocalPullRequestFiles,
} from './modules/pr-local-diffs';
import { resolvePrReviewerWorkspace } from './modules/pr-reviewer';
import { runtimePaths, type RuntimePaths } from './runtime-home';

const gitDiffMock = vi.hoisted(() =>
  vi.fn<typeof import('./repo-edit/git').gitDiff>(),
);

vi.mock('./repo-edit/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('./repo-edit/git')>();
  gitDiffMock.mockImplementation(original.gitDiff);
  return { ...original, gitDiff: gitDiffMock };
});

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  gitDiffMock.mockClear();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('local PR diffs', () => {
  it('reads metadata and per-file patches from local git refs', async () => {
    const { baseSha, headSha, paths } = await fixture();

    const files = await readLocalPullRequestFiles(
      {
        owner: 'example',
        repo: 'sample',
        number: 42,
        headSha,
        baseSha,
        baseRef: 'main',
        includePatches: false,
      },
      paths,
    );

    expect(files).toMatchObject({
      repo: 'example/sample',
      number: 42,
      diffSummary: { files: 2, additions: 2, deletions: 1 },
    });
    expect(files.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/app.ts',
          status: 'modified',
          patch: null,
        }),
        expect.objectContaining({
          path: 'src/added.ts',
          status: 'added',
          patch: null,
        }),
      ]),
    );

    const patch = await readLocalPullRequestFileDiff(
      {
        owner: 'example',
        repo: 'sample',
        number: 42,
        headSha,
        baseSha,
        baseRef: 'main',
        path: 'src/app.ts',
      },
      paths,
    );

    expect(patch.file).toMatchObject({
      path: 'src/app.ts',
      status: 'modified',
      patch: expect.stringContaining('+export const value = 2;'),
    });
    expect(patch.diff).toContain('diff --git a/src/app.ts b/src/app.ts');
    expect(metadataDiffCalls()).toHaveLength(1);
    expect(patchDiffCalls()).toHaveLength(1);
  });

  it('gives the reviewer read-only traversal at the exact reviewed revision', async () => {
    const { baseSha, headSha, paths, repo } = await fixture();
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 3;\n');
    await commitAll(repo, 'later local commit');

    const workspace = await resolvePrReviewerWorkspace(
      {
        repoFullName: 'example/sample',
        prNumber: 42,
        headSha,
        baseSha,
        baseRef: 'main',
      },
      paths,
    );

    expect(workspace.available).toBe(true);
    if (!workspace.available) return;
    const readTool = workspace.tools.find(
      (tool) => tool.name === 'neondeck_review_workspace_read',
    );
    const searchTool = workspace.tools.find(
      (tool) => tool.name === 'neondeck_review_workspace_search',
    );
    const diffTool = workspace.tools.find(
      (tool) => tool.name === 'neondeck_review_workspace_diff',
    );

    await expect(
      readTool?.run({ input: { path: 'src/app.ts' } } as never),
    ).resolves.toMatchObject({
      revision: headSha,
      path: 'src/app.ts',
      content: expect.stringContaining('export const value = 2;'),
    });
    await expect(
      searchTool?.run({ input: { query: 'value = 3' } } as never),
    ).resolves.toMatchObject({ matches: [] });
    await expect(
      diffTool?.run({ input: { path: 'src/app.ts' } } as never),
    ).resolves.toMatchObject({
      available: true,
      base: baseSha,
      head: headSha,
      patch: expect.stringContaining('+export const value = 2;'),
    });
    await expect(
      diffTool?.run({
        input: { path: 'src/app.ts', rightLine: 1, contextLines: 2 },
      } as never),
    ).resolves.toMatchObject({
      targetChanged: true,
      rightLine: 1,
      lines: expect.arrayContaining([
        expect.objectContaining({
          kind: 'addition',
          rightLine: 1,
          text: 'export const value = 2;',
        }),
      ]),
    });
  });

  it('verifies a target line without buffering a diff larger than 16 MiB', async () => {
    const { baseSha, headSha, paths } = await largeLineFixture();
    const workspace = await resolvePrReviewerWorkspace(
      {
        repoFullName: 'example/sample',
        prNumber: 45,
        headSha,
        baseSha,
        baseRef: 'main',
      },
      paths,
    );

    expect(workspace.available).toBe(true);
    if (!workspace.available) return;
    const diffTool = workspace.tools.find(
      (tool) => tool.name === 'neondeck_review_workspace_diff',
    );

    await expect(
      diffTool?.run({
        input: { path: 'src/large.ts', rightLine: 1, contextLines: 0 },
      } as never),
    ).resolves.toMatchObject({
      targetChanged: true,
      truncated: true,
      lines: [
        expect.objectContaining({
          kind: 'addition',
          rightLine: 1,
          textTruncated: true,
        }),
      ],
    });
  });

  it('single-flights metadata across concurrent per-file patch reads', async () => {
    const { baseSha, headSha, paths } = await fixture();

    const patches = await Promise.all(
      ['src/app.ts', 'src/added.ts'].map((path) =>
        readLocalPullRequestFileDiff(
          {
            owner: 'example',
            repo: 'sample',
            number: 42,
            headSha,
            baseSha,
            baseRef: 'main',
            path,
          },
          paths,
        ),
      ),
    );

    expect(patches.map((patch) => patch.file?.path)).toEqual([
      'src/app.ts',
      'src/added.ts',
    ]);
    expect(metadataDiffCalls()).toHaveLength(1);
    expect(patchDiffCalls()).toHaveLength(2);
  });

  it('does not reuse metadata across immutable revision keys', async () => {
    const { baseSha, headSha, paths, repo } = await fixture();
    const input = {
      owner: 'example',
      repo: 'sample',
      number: 42,
      baseSha,
      baseRef: 'main',
      includePatches: false,
    } as const;

    await readLocalPullRequestFiles({ ...input, headSha }, paths);
    await readLocalPullRequestFiles({ ...input, headSha }, paths);
    await writeFile(join(repo, 'src/next.ts'), 'export const next = true;\n');
    await commitAll(repo, 'next head');
    const nextHeadSha = await git(repo, ['rev-parse', 'HEAD']);
    const next = await readLocalPullRequestFiles(
      { ...input, headSha: nextHeadSha },
      paths,
    );

    expect(next.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/next.ts', status: 'added' }),
      ]),
    );
    expect(metadataDiffCalls()).toHaveLength(2);
  });

  it('keeps renamed files with edits keyed by destination path', async () => {
    const { baseSha, headSha, paths } = await renameFixture();

    const files = await readLocalPullRequestFiles(
      {
        owner: 'example',
        repo: 'sample',
        number: 43,
        headSha,
        baseSha,
        baseRef: 'main',
        includePatches: false,
      },
      paths,
    );

    expect(files.files).toEqual([
      expect.objectContaining({
        path: 'src/new-name.ts',
        previousPath: 'src/old-name.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
      }),
    ]);

    const patch = await readLocalPullRequestFileDiff(
      {
        owner: 'example',
        repo: 'sample',
        number: 43,
        headSha,
        baseSha,
        baseRef: 'main',
        path: 'src/new-name.ts',
      },
      paths,
    );

    expect(patch.file?.path).toBe('src/new-name.ts');
    expect(patch.diff).toContain('rename from src/old-name.ts');
    expect(patch.diff).toContain('rename to src/new-name.ts');

    const workspace = await resolvePrReviewerWorkspace(
      {
        repoFullName: 'example/sample',
        prNumber: 43,
        headSha,
        baseSha,
        baseRef: 'main',
      },
      paths,
    );
    expect(workspace.available).toBe(true);
    if (!workspace.available) return;
    const diffTool = workspace.tools.find(
      (tool) => tool.name === 'neondeck_review_workspace_diff',
    );

    await expect(
      diffTool?.run({
        input: {
          path: 'src/new-name.ts',
          rightLine: 1,
          contextLines: 1,
        },
      } as never),
    ).resolves.toMatchObject({
      targetChanged: false,
      lines: expect.arrayContaining([
        expect.objectContaining({
          kind: 'context',
          rightLine: 1,
          text: 'export const one = 1;',
        }),
      ]),
    });
    await expect(
      diffTool?.run({
        input: {
          path: 'src/new-name.ts',
          rightLine: 2,
          contextLines: 1,
        },
      } as never),
    ).resolves.toMatchObject({
      targetChanged: true,
      lines: expect.arrayContaining([
        expect.objectContaining({
          kind: 'addition',
          rightLine: 2,
          text: 'export const two = 22;',
        }),
      ]),
    });
  });

  it('fetches base refs into the Neondeck namespace', async () => {
    const { baseSha, headSha, movedBaseSha, paths, repo } =
      await fetchRefFixture();

    const files = await readLocalPullRequestFiles(
      {
        owner: 'example',
        repo: 'sample',
        number: 44,
        headSha,
        baseRef: 'main',
        includePatches: false,
      },
      paths,
    );

    expect(files.files).toEqual([
      expect.objectContaining({
        path: 'src/app.ts',
        status: 'modified',
      }),
    ]);
    expect(await git(repo, ['rev-parse', 'refs/remotes/origin/main'])).toBe(
      baseSha,
    );
    expect(await git(repo, ['rev-parse', 'refs/neondeck/base/main'])).toBe(
      movedBaseSha,
    );
    expect(await git(repo, ['rev-parse', 'refs/neondeck/pull/44/head'])).toBe(
      headSha,
    );
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-repo-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  await git(repo, ['init', '-b', 'main']);
  await git(repo, [
    'remote',
    'add',
    'origin',
    'git@github.com:example/sample.git',
  ]);
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
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 2;\n');
  await writeFile(join(repo, 'src/added.ts'), 'export const added = true;\n');
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
          id: 'sample',
          github: { owner: 'example', name: 'sample' },
          path: repo,
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
  return { baseSha, headSha, paths, repo };
}

async function renameFixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-repo-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(
    join(repo, 'src/old-name.ts'),
    [
      'export const one = 1;',
      'export const two = 2;',
      'export const three = 3;',
      'export const four = 4;',
    ].join('\n') + '\n',
  );
  await git(repo, ['init', '-b', 'main']);
  await git(repo, [
    'remote',
    'add',
    'origin',
    'git@github.com:example/sample.git',
  ]);
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
  await git(repo, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
  await writeFile(
    join(repo, 'src/new-name.ts'),
    [
      'export const one = 1;',
      'export const two = 22;',
      'export const three = 3;',
      'export const four = 4;',
    ].join('\n') + '\n',
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
  await writeRepoRegistry(paths, repo);
  return { baseSha, headSha, paths };
}

async function fetchRefFixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  const root = await mkdtemp(join(tmpdir(), 'neondeck-fetch-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const repo = join(root, 'work');
  tempRoots.push(home, root);
  const paths = runtimePaths(home);

  await git(root, ['init', '--bare', '-b', 'main', remote]);
  await git(root, ['init', '-b', 'main', seed]);
  await git(seed, ['remote', 'add', 'origin', remote]);
  await mkdir(join(seed, 'src'), { recursive: true });
  await writeFile(join(seed, 'src/app.ts'), 'export const value = 1;\n');
  await commitAll(seed, 'base');
  const baseSha = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', 'origin', 'main']);

  await execFileAsync('git', ['clone', remote, repo]);
  await git(repo, [
    'remote',
    'set-url',
    'origin',
    'git@github.com:example/sample.git',
  ]);
  await git(repo, [
    'config',
    `url.file://${remote}.insteadOf`,
    'git@github.com:example/sample.git',
  ]);

  await git(seed, ['switch', '-c', 'feature']);
  await writeFile(join(seed, 'src/app.ts'), 'export const value = 2;\n');
  await commitAll(seed, 'head');
  const headSha = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', 'origin', `HEAD:refs/pull/44/head`]);

  await git(seed, ['switch', 'main']);
  await writeFile(join(seed, 'README.md'), '# sample\n');
  await commitAll(seed, 'move base');
  const movedBaseSha = await git(seed, ['rev-parse', 'HEAD']);
  await git(seed, ['push', 'origin', 'main']);

  await writeRepoRegistry(paths, repo);
  return { baseSha, headSha, movedBaseSha, paths, repo };
}

async function largeLineFixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-large-diff-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'README.md'), '# sample\n');
  await git(repo, ['init', '-b', 'main']);
  await git(repo, [
    'remote',
    'add',
    'origin',
    'git@github.com:example/sample.git',
  ]);
  await commitAll(repo, 'base');
  const baseSha = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(
    join(repo, 'src/large.ts'),
    `export const payload = '${'x'.repeat(17 * 1024 * 1024)}';\n`,
  );
  await commitAll(repo, 'large head');
  const headSha = await git(repo, ['rev-parse', 'HEAD']);
  await writeRepoRegistry(paths, repo);
  return { baseSha, headSha, paths };
}

async function commitAll(repo: string, message: string) {
  await git(repo, ['add', '-A']);
  await git(repo, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    message,
  ]);
}

async function writeRepoRegistry(paths: RuntimePaths, repo: string) {
  await mkdir(paths.home, { recursive: true });
  await writeFile(
    paths.repos,
    `${JSON.stringify({
      repos: [
        {
          id: 'sample',
          github: { owner: 'example', name: 'sample' },
          path: repo,
          defaultBranch: 'main',
        },
      ],
    })}\n`,
  );
}

async function git(repo: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd: repo });
  return stdout.trim();
}

function metadataDiffCalls() {
  return gitDiffMock.mock.calls.filter(([, input]) => {
    const value = input as { includePatch?: boolean; paths?: string[] };
    return value.includePatch === false && value.paths === undefined;
  });
}

function patchDiffCalls() {
  return gitDiffMock.mock.calls.filter(([, input]) => {
    const value = input as { includePatch?: boolean; paths?: string[] };
    return value.includePatch === true && Boolean(value.paths?.length);
  });
}
