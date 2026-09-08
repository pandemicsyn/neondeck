import { execFileSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureCandidateTree } from './evidence';
import { CandidateEvidenceError } from './evidence-errors';
import { snapshotEntry } from './evidence-snapshot';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'snapshot-test-')));
  roots.push(home);
  const root = join(home, 'repo');
  const directory = join(home, 'capture');
  await mkdir(root);
  await mkdir(directory);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'base.txt'), 'base\n');
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
  };
  commit();
  return {
    home,
    root,
    directory,
    git,
    commit,
    capture: () => captureCandidateTree(root, directory),
  };
}

it('reuses verified unchanged blobs above both per-file and changed-content budgets', async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, 'large.bin'),
    Buffer.alloc(4 * 1024 * 1024, 0xa5),
  );
  for (let n = 0; n < 8; n++)
    await copyFile(join(f.root, 'large.bin'), join(f.root, `copy-${n}.bin`));
  f.commit();
  const head = f.git('rev-parse', 'HEAD');
  const index = await readFile(join(f.root, '.git/index'));
  const tree = await f.capture();
  expect(tree).toBe(f.git('rev-parse', 'HEAD^{tree}').trim());
  expect(f.git('rev-parse', 'HEAD')).toBe(head);
  expect(await readFile(join(f.root, '.git/index'))).toEqual(index);
  await writeFile(join(f.root, 'base.txt'), 'changed\n');
  const changed = await f.capture();
  expect(f.git('show', `${changed}:base.txt`)).toBe('changed\n');
  expect(f.git('rev-parse', `${changed}:large.bin`)).toBe(
    f.git('rev-parse', 'HEAD:large.bin'),
  );
});

it('rejects modified large tracked bytes even when the index promises assume-unchanged', async () => {
  const f = await fixture();
  const path = join(f.root, 'large.bin');
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 1));
  f.commit();
  const before = await stat(path);
  f.git('update-index', '--assume-unchanged', 'large.bin');
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 2));
  await utimes(path, before.atime, before.mtime);
  expect(f.git('status', '--porcelain')).toBe('');
  await expect(f.capture()).rejects.toMatchObject({ code: 'file-too-large' });
});

it('keeps the large untracked file limit and safe failure text', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'large.bin'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await expect(f.capture()).rejects.toEqual(
    new CandidateEvidenceError('file-too-large', {
      path: 'large.bin',
      observedBytes: 2097153,
      limitBytes: 2097152,
    }),
  );
  const missing = captureCandidateTree(join(f.home, 'absent'), f.directory);
  await expect(missing).rejects.toEqual(
    new CandidateEvidenceError('capture-failed'),
  );
});

it('captures raw content, actual executable mode, deletions, and untracked symlinks', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'nested'));
  await writeFile(join(f.root, 'nested/deleted.txt'), 'delete me');
  await writeFile(join(f.root, '.gitattributes'), '*.txt text eol=lf\n');
  f.commit();
  f.git('config', 'core.filemode', 'false');
  await chmod(join(f.root, 'base.txt'), 0o755);
  await rm(join(f.root, 'nested'), { recursive: true });
  await writeFile(join(f.root, 'raw.txt'), 'raw\r\n');
  await symlink('../outside', join(f.root, 'link'));
  const tree = await f.capture();
  expect(f.git('ls-tree', tree, 'base.txt')).toMatch(/^100755 blob/);
  expect(f.git('rev-parse', `${tree}:base.txt`)).toBe(
    f.git('rev-parse', 'HEAD:base.txt'),
  );
  expect(f.git('ls-tree', '-r', '--name-only', tree)).not.toContain(
    'deleted.txt',
  );
  expect(f.git('show', `${tree}:raw.txt`)).toBe('raw\r\n');
  expect(f.git('ls-tree', tree, 'link')).toMatch(/^120000 blob/);
  expect(f.git('show', `${tree}:link`)).toBe('../outside');
});

it('preserves tracked symlink replacement bytes and rejects a symlink parent', async () => {
  const f = await fixture();
  await symlink('base.txt', join(f.root, 'link'));
  await mkdir(join(f.root, 'nested'));
  await writeFile(join(f.root, 'nested/child.txt'), 'tracked');
  f.commit();
  await rm(join(f.root, 'link'));
  await symlink('new-target', join(f.root, 'link'));
  const tree = await f.capture();
  expect(f.git('show', `${tree}:link`)).toBe('new-target');
  await rm(join(f.root, 'nested'), { recursive: true });
  await symlink(f.directory, join(f.root, 'nested'));
  await expect(f.capture()).rejects.toMatchObject({ code: 'path-invalid' });
});

it('bounds changed content before writing another object', async () => {
  const f = await fixture();
  const budget = { scanned: 0, changed: 32 * 1024 * 1024 };
  await expect(
    snapshotEntry(f.root, 'base.txt', undefined, budget, async () => {
      throw new Error('must not write');
    }),
  ).rejects.toMatchObject({ code: 'total-too-large' });
});

it('detects mutation between reading content and publishing its entry', async () => {
  const f = await fixture();
  await expect(
    snapshotEntry(
      f.root,
      'base.txt',
      undefined,
      { scanned: 0, changed: 0 },
      async () => {
        await writeFile(join(f.root, 'base.txt'), 'drift');
        return f.git('rev-parse', 'HEAD:base.txt');
      },
    ),
  ).rejects.toMatchObject({ code: 'stale' });
});

it.each(['new', 'modified', 'committed'] as const)(
  'does not exempt %s large content from the pinned baseline budget',
  async (kind) => {
    const f = await fixture();
    const path = join(f.root, 'large.bin');
    if (kind === 'modified') {
      await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 1));
      f.commit();
    }
    const baseSha = f.git('rev-parse', 'HEAD').trim();
    await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 2));
    f.git('add', 'large.bin');
    if (kind === 'committed') f.git('commit', '-qm', 'candidate');
    await expect(
      captureCandidateTree(f.root, f.directory, baseSha),
    ).rejects.toMatchObject({
      code: 'file-too-large',
      details: {
        path: 'large.bin',
        observedBytes: 4 * 1024 * 1024,
        limitBytes: 2 * 1024 * 1024,
      },
    });
  },
);

it('rejects oversized same-length content hidden by skip-worktree', async () => {
  const f = await fixture();
  const path = join(f.root, 'large.bin');
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 1));
  f.commit();
  f.git('update-index', '--skip-worktree', 'large.bin');
  await writeFile(path, Buffer.alloc(4 * 1024 * 1024, 2));
  expect(f.git('status', '--porcelain')).toBe('');
  await expect(f.capture()).rejects.toMatchObject({ code: 'file-too-large' });
});

it('keeps unsafe detail values out of diagnostics', () => {
  for (const path of [
    '/absolute/path',
    '../escape',
    'bad\nname',
    'C:\\path',
    'x'.repeat(513),
  ]) {
    const error = new CandidateEvidenceError('file-too-large', {
      path,
      observedBytes: Infinity,
      limitBytes: -1,
    });
    expect(error.details).toEqual({});
    expect(error.message).toContain('2097152');
    expect(error.message).not.toContain(path);
  }
});

it('preserves file/directory replacements rather than resurrecting baseline paths', async () => {
  const f = await fixture();
  await mkdir(join(f.root, 'nested'));
  await writeFile(join(f.root, 'nested/old.txt'), 'old');
  f.commit();
  await rm(join(f.root, 'nested'), { recursive: true });
  await writeFile(join(f.root, 'nested'), 'now a file');
  await rm(join(f.root, 'base.txt'));
  await mkdir(join(f.root, 'base.txt'));
  await writeFile(join(f.root, 'base.txt/new.txt'), 'now nested');
  const tree = await f.capture();
  expect(f.git('show', `${tree}:nested`)).toBe('now a file');
  expect(f.git('show', `${tree}:base.txt/new.txt`)).toBe('now nested');
});
