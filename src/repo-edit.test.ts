import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  listRepoEditEvents,
  patchRepoFiles,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  writeRepoFile,
} from './repo-edit';
import { gitDiff, gitWorktreeRevision } from './repo-edit/git';
import { recordRepoEditEvent } from './repo-edit/audit';
import { subscribeReviewSourceRevisionEvents } from './modules/review-refresh';
import { runtimePaths } from './runtime-home';
import {
  createSeededGitRepository,
  type SeededGitRepository,
} from './testing/git-repository-fixture';
import { reviewRevisionKey } from '../shared/review-source';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
let repositorySeed: SeededGitRepository | undefined;

beforeAll(async () => {
  repositorySeed = await createSeededGitRepository({
    initialCommitMessage: 'init',
    initialFiles: { 'src/app.ts': 'export const value = 1;\n' },
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

describe('repo edit actions', () => {
  it('publishes a targeted worktree revision event after an applied edit', async () => {
    const { paths } = await fixture();
    const events: Array<{
      source: { repoId: string | null; worktreeId: string | null };
    }> = [];
    const unsubscribe = subscribeReviewSourceRevisionEvents((event) =>
      events.push(event),
    );
    try {
      await recordRepoEditEvent(
        {
          repoId: 'sample',
          worktreeId: 'worktree-1',
          action: 'write',
          status: 'applied',
          paths: ['src/app.ts'],
          diffPatch: '@@ -1 +1 @@\n-old\n+new\n',
        },
        paths,
      );
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.source).toMatchObject({
      repoId: 'sample',
      worktreeId: 'worktree-1',
    });
  });

  it('reads a file from a declared workspace and rejects traversal', async () => {
    const { paths } = await fixture();
    const result = await readRepoFile(
      { repoId: 'sample', path: 'src/app.ts' },
      paths,
    );
    const blocked = await readRepoFile(
      { repoId: 'sample', path: '../secret.txt' },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      action: 'repo_file_read',
      path: 'src/app.ts',
      content: 'export const value = 1;\n',
    });
    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('previews a new file write without creating parent directories', async () => {
    const { paths, repo } = await fixture();
    const result = await writeRepoFile(
      {
        repoId: 'sample',
        path: 'generated/example.ts',
        content: 'export const generated = true;\n',
        createParentDirectories: true,
        dryRun: true,
      },
      paths,
    );

    await expect(stat(join(repo, 'generated'))).rejects.toThrow(
      /ENOENT|no such file/i,
    );
    expect(result).toMatchObject({
      ok: true,
      changed: false,
      dryRun: true,
      path: 'generated/example.ts',
    });
  });

  it('applies exact and normalized-whitespace replacements inside the workspace', async () => {
    const { paths, repo } = await fixture();
    const exact = await replaceRepoFile(
      {
        repoId: 'sample',
        path: 'src/app.ts',
        oldString: 'value = 1',
        newString: 'value = 2',
      },
      paths,
    );
    const fuzzy = await replaceRepoFile(
      {
        repoId: 'sample',
        path: 'src/app.ts',
        oldString: 'export   const   value = 2;',
        newString: 'export const value = 3;',
        fuzzy: 'safe',
      },
      paths,
    );

    expect(exact).toMatchObject({ ok: true, changed: true, matched: 'exact' });
    expect(fuzzy).toMatchObject({
      ok: true,
      changed: true,
      matched: 'normalized-whitespace',
    });
    await expect(readFile(join(repo, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 3;\n',
    );
  });

  it('applies one unambiguous high-confidence fuzzy replacement', async () => {
    const { paths, repo } = await fixture();
    await writeFile(
      join(repo, 'src/app.ts'),
      'export const value = 1;\nexport const other = true;\n',
    );

    const result = await replaceRepoFile(
      {
        repoId: 'sample',
        path: 'src/app.ts',
        oldString: 'export const value = 1;\nexport const other = false;',
        newString: 'export const value = 1;\nexport const other = "patched";',
        fuzzy: 'safe',
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      matched: 'fuzzy',
    });
    await expect(readFile(join(repo, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 1;\nexport const other = "patched";\n',
    );
  });

  it('blocks session edits when a previously read file becomes stale', async () => {
    const { paths, repo } = await fixture();
    const read = await readRepoFile(
      { repoId: 'sample', path: 'src/app.ts', sessionId: 'session-a' },
      paths,
    );
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 9;\n');

    const result = await replaceRepoFile(
      {
        repoId: 'sample',
        path: 'src/app.ts',
        oldString: 'value = 9',
        newString: 'value = 10',
        sessionId: 'session-a',
      },
      paths,
    );

    expect(read).toMatchObject({ ok: true });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'STALE_FILE' },
    });
  });

  it('applies a V4A multi-file patch all at once', async () => {
    const { paths, repo } = await fixture();
    const result = await patchRepoFiles(
      {
        repoId: 'sample',
        patch: [
          '*** Begin Patch',
          '*** Update File: src/app.ts',
          '@@',
          '-export const value = 1;',
          '+export const value = 4;',
          '*** Add File: src/added.ts',
          '+export const added = true;',
          '*** End Patch',
        ].join('\n'),
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      diffSummary: { files: 2 },
    });
    await expect(readFile(join(repo, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 4;\n',
    );
    await expect(readFile(join(repo, 'src/added.ts'), 'utf8')).resolves.toBe(
      'export const added = true;',
    );
  });

  it('simulates repeated V4A updates to the same file cumulatively', async () => {
    const { paths, repo } = await fixture();
    const result = await patchRepoFiles(
      {
        repoId: 'sample',
        patch: [
          '*** Begin Patch',
          '*** Update File: src/app.ts',
          '@@',
          '-export const value = 1;',
          '+export const value = 2;',
          '*** Update File: src/app.ts',
          '@@',
          '-export const value = 2;',
          '+export const value = 3;',
          '*** End Patch',
        ].join('\n'),
      },
      paths,
    );

    expect(result).toMatchObject({ ok: true, changed: true });
    await expect(readFile(join(repo, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 3;\n',
    );
  });

  it('requires V4A update hunks to match complete lines', async () => {
    const { paths, repo } = await fixture();
    const result = await patchRepoFiles(
      {
        repoId: 'sample',
        patch: [
          '*** Begin Patch',
          '*** Update File: src/app.ts',
          '@@',
          '-value',
          '+patched',
          '*** End Patch',
        ].join('\n'),
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PATCH_PARSE_ERROR' },
    });
    await expect(readFile(join(repo, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 1;\n',
    );
  });

  it('blocks stale V4A deletes after a session read', async () => {
    const { paths, repo } = await fixture();
    await readRepoFile(
      { repoId: 'sample', path: 'src/app.ts', sessionId: 'session-delete' },
      paths,
    );
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 11;\n');

    const result = await patchRepoFiles(
      {
        repoId: 'sample',
        sessionId: 'session-delete',
        patch: [
          '*** Begin Patch',
          '*** Delete File: src/app.ts',
          '*** End Patch',
        ].join('\n'),
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PATCH_PARSE_ERROR' },
    });
    await expect(readFile(join(repo, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 11;\n',
    );
  });

  it('blocks denied workspace paths instead of prompting for approval', async () => {
    const { paths } = await fixture();
    const result = await writeRepoFile(
      {
        repoId: 'sample',
        path: '.git/config',
        content: 'nope',
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PATH_DENIED' },
    });
    expect(JSON.stringify(result)).not.toContain('approval');
  });

  it('includes untracked files in repo diff summaries', async () => {
    const { paths, repo } = await fixture();
    await writeFile(
      join(repo, 'src/untracked.ts'),
      'export const next = true;\n',
    );

    const result = await readRepoDiff({ repoId: 'sample' }, paths);

    expect(result).toMatchObject({
      ok: true,
      files: expect.arrayContaining([
        expect.objectContaining({
          path: 'src/untracked.ts',
          status: 'untracked',
          additions: 1,
        }),
      ]),
    });
  });

  it('changes the worktree revision when content changes without changing line counts', async () => {
    const { paths, repo } = await fixture();
    const objectStateBefore = await gitOutput(repo, ['count-objects', '-v']);
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 2;\n');
    const first = await readRepoDiff({ repoId: 'sample' }, paths);
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 3;\n');
    const firstRevisionKey = first.revision
      ? reviewRevisionKey(first.revision)
      : null;
    await expect(
      readRepoDiff(
        {
          repoId: 'sample',
          paths: ['src/app.ts'],
          includePatch: true,
          expectedRevisionKey: firstRevisionKey ?? undefined,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['refresh'],
      errors: ['The requested revision is stale.'],
    });
    const second = await readRepoDiff({ repoId: 'sample' }, paths);

    expect(first).toMatchObject({
      ok: true,
      revision: {
        state: 'resolved',
        kind: 'worktree-diff',
        id: expect.any(String),
        baseId: expect.any(String),
      },
    });
    expect(second).toMatchObject({
      ok: true,
      revision: { state: 'resolved', kind: 'worktree-diff' },
    });
    if (
      first.revision?.state !== 'resolved' ||
      second.revision?.state !== 'resolved'
    ) {
      throw new Error('Expected resolved worktree revisions.');
    }
    expect(second.revision.id).not.toBe(first.revision.id);
    const currentDiff = await gitDiff(repo, {});
    const reordered = await gitWorktreeRevision(repo, {
      files: [...currentDiff.files].reverse(),
    });
    expect(reordered.id).toBe(second.revision.id);
    await expect(gitOutput(repo, ['count-objects', '-v'])).resolves.toBe(
      objectStateBefore,
    );
  });

  it('allows changed paths whose names begin with two dots', async () => {
    const { paths, repo } = await fixture();
    await writeFile(join(repo, '..notes.ts'), 'export const note = true;\n');

    const result = await readRepoDiff({ repoId: 'sample' }, paths);

    expect(result).toMatchObject({
      ok: true,
      files: expect.arrayContaining([
        expect.objectContaining({ path: '..notes.ts', status: 'untracked' }),
      ]),
      revision: { state: 'resolved', kind: 'worktree-diff' },
    });
  });

  it('exposes a retained patch hash for historical repo-edit review', async () => {
    const { paths } = await fixture();
    await replaceRepoFile(
      {
        repoId: 'sample',
        path: 'src/app.ts',
        oldString: 'value = 1',
        newString: 'value = 2',
      },
      paths,
    );

    const events = await listRepoEditEvents(paths);

    expect(events.events[0]).toMatchObject({
      reviewRevision: {
        state: 'resolved',
        kind: 'retained-patch',
        id: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('reads explicit head diffs without including worktree-only files', async () => {
    const { repo } = await fixture();
    const baseSha = await gitOutput(repo, ['rev-parse', 'HEAD']);
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 2;\n');
    await writeFile(
      join(repo, 'src/head-only.ts'),
      'export const head = true;\n',
    );
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'head',
      ],
      { cwd: repo },
    );
    const headSha = await gitOutput(repo, ['rev-parse', 'HEAD']);
    await writeFile(
      join(repo, 'src/worktree-only.ts'),
      'export const local = true;\n',
    );

    const diff = await gitDiff(repo, {
      base: baseSha,
      head: headSha,
      includePatch: true,
    });

    expect(diff.files.map((file) => file.path).sort()).toEqual([
      'src/app.ts',
      'src/head-only.ts',
    ]);
    expect(
      diff.files.find((file) => file.path === 'src/app.ts')?.patch,
    ).toContain('+export const value = 2;');
  });

  it('maps renamed files with edits to the destination path', async () => {
    const { repo } = await fixture();
    await writeFile(
      join(repo, 'src/old-name.ts'),
      [
        'export const one = 1;',
        'export const two = 2;',
        'export const three = 3;',
        'export const four = 4;',
      ].join('\n') + '\n',
    );
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'old name',
      ],
      { cwd: repo },
    );
    const baseSha = await gitOutput(repo, ['rev-parse', 'HEAD']);
    await execFileAsync('git', ['mv', 'src/old-name.ts', 'src/new-name.ts'], {
      cwd: repo,
    });
    await writeFile(
      join(repo, 'src/new-name.ts'),
      [
        'export const one = 1;',
        'export const two = 22;',
        'export const three = 3;',
        'export const four = 4;',
      ].join('\n') + '\n',
    );
    await execFileAsync('git', ['add', '-A'], { cwd: repo });
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'rename with edits',
      ],
      { cwd: repo },
    );
    const headSha = await gitOutput(repo, ['rev-parse', 'HEAD']);

    const diff = await gitDiff(repo, { base: baseSha, head: headSha });

    expect(diff.files).toEqual([
      expect.objectContaining({
        path: 'src/new-name.ts',
        previousPath: 'src/old-name.ts',
        status: 'R',
        additions: 1,
        deletions: 1,
      }),
    ]);
  });

  it('rejects unsafe git diff refs and pathspecs', async () => {
    const { paths } = await fixture();

    await expect(
      readRepoDiff({ repoId: 'sample', base: '--cached' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    await expect(
      readRepoDiff({ repoId: 'sample', paths: ['../../../secret'] }, paths),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('preserves executable mode when replacing files', async () => {
    const { paths, repo } = await fixture();
    const script = join(repo, 'src/run.sh');
    await writeFile(script, '#!/bin/sh\necho old\n');
    await chmod(script, 0o755);

    const result = await replaceRepoFile(
      {
        repoId: 'sample',
        path: 'src/run.sh',
        oldString: 'echo old',
        newString: 'echo new',
      },
      paths,
    );
    const mode = (await stat(script)).mode & 0o777;

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(mode).toBe(0o755);
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  const repoRoot = await mkdtemp(join(tmpdir(), 'neondeck-repo-'));
  const repo = join(repoRoot, 'repository');
  tempRoots.push(home, repoRoot);
  const paths = runtimePaths(home);
  if (!repositorySeed) {
    throw new Error('Repo edit Git repository seed is unavailable.');
  }
  await repositorySeed.copyTo(repo);
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
  return { home, repo, paths };
}

async function gitOutput(repo: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd: repo });
  return stdout.trim();
}
