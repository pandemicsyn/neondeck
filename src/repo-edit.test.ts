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
import { afterEach, describe, expect, it } from 'vitest';
import {
  patchRepoFiles,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  writeRepoFile,
} from './repo-edit';
import { runtimePaths } from './runtime-home';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('repo edit actions', () => {
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
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-repo-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  await execFileAsync('git', ['init'], { cwd: repo });
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
      'init',
    ],
    { cwd: repo },
  );
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
