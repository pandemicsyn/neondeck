import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { updateWorktreePolicy } from './modules/config';
import { listRepoEditEvents, readRepoFile, writeRepoFile } from './repo-edit';
import { runtimePaths } from './runtime-home';
import {
  cleanupWorktrees,
  createWorktree,
  listWorktrees,
  lockWorktree,
  readWorktreeLock,
  readWorktreeStatus,
  releaseWorktreeLock,
  revokeWorktreeLockLease,
  syncWorktree,
} from './modules/worktrees';
import {
  createSeededGitRepository,
  type SeededGitRepository,
} from './testing/git-repository-fixture';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
let repositorySeed: SeededGitRepository | undefined;

vi.setConfig({ testTimeout: 60_000 });

beforeAll(async () => {
  repositorySeed = await createSeededGitRepository({
    initialCommitMessage: 'main',
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

describe('worktree runtime foundation', () => {
  it('creates a managed worktree and lets repo-edit target it safely', async () => {
    const { paths, repo } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);

    const status = await readWorktreeStatus({ worktreeId: worktree.id }, paths);
    const read = await readRepoFile(
      { repoId: 'sample', worktreeId: worktree.id, path: 'src/app.ts' },
      paths,
    );
    const write = await writeRepoFile(
      {
        repoId: 'sample',
        worktreeId: worktree.id,
        path: 'src/app.ts',
        content: 'export const value = 3;\n',
      },
      paths,
    );

    expect(created).toMatchObject({
      ok: true,
      changed: true,
      worktree: {
        repoId: 'sample',
        prNumber: 7,
        lifecycleStatus: 'ready',
        storageKind: 'home',
      },
    });
    const worktreeRoot = await realpath(paths.worktrees);
    expect(worktree.localPath.startsWith(worktreeRoot)).toBe(true);
    expect(status).toMatchObject({
      ok: true,
      git: { dirty: false, branch: 'HEAD' },
    });
    expect(read).toMatchObject({
      ok: true,
      content: 'export const value = 2;\n',
      worktreeId: worktree.id,
    });
    expect(write).toMatchObject({ ok: true, changed: true });
    await expect(readFile(join(repo, 'src/app.ts'), 'utf8')).resolves.toBe(
      'export const value = 1;\n',
    );
    await expect(
      readFile(join(worktree.localPath, 'src/app.ts'), 'utf8'),
    ).resolves.toBe('export const value = 3;\n');
  });

  it('blocks sync when the worktree is dirty', async () => {
    const { paths } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 99;\n',
    );

    const result = await syncWorktree({ worktreeId: worktree.id }, paths);

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      error: { code: 'DIRTY_WORKTREE' },
      worktree: { lifecycleStatus: 'needs-sync' },
    });
  });

  it('rebases a clean worktree onto a refreshed head ref', async () => {
    const { paths, repo } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 20;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'local fix']);
    await git(repo, ['checkout', 'feature']);
    await writeFile(join(repo, 'src/other.ts'), 'export const other = 1;\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'new feature commit']);

    const result = await syncWorktree(
      {
        worktreeId: worktree.id,
        headRef: 'feature',
        strategy: 'rebase',
      },
      paths,
    );
    const currentHead = await gitOutput(repo, ['rev-parse', 'feature']);
    const localHead = await gitOutput(worktree.localPath, [
      'rev-parse',
      'HEAD',
    ]);

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      worktree: {
        lifecycleStatus: 'ready',
        headSha: currentHead,
        lastSyncedSha: localHead,
      },
    });
    await expect(
      readFile(join(worktree.localPath, 'src/app.ts'), 'utf8'),
    ).resolves.toBe('export const value = 20;\n');
    await expect(
      readFile(join(worktree.localPath, 'src/other.ts'), 'utf8'),
    ).resolves.toBe('export const other = 1;\n');
  });

  it('marks a rebase conflict as needs-sync', async () => {
    const { paths, repo } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 20;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'local fix']);
    await git(repo, ['checkout', 'feature']);
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 30;\n');
    await git(repo, ['commit', '-am', 'new feature commit']);

    const result = await syncWorktree(
      {
        worktreeId: worktree.id,
        headRef: 'feature',
        strategy: 'rebase',
      },
      paths,
    );

    expect(result).toMatchObject({ ok: false, action: 'worktree_sync' });
    expect(
      await readWorktreeStatus({ worktreeId: worktree.id }, paths),
    ).toMatchObject({
      worktree: { lifecycleStatus: 'needs-sync' },
    });
  });

  it('creates worktrees under repo-local roots when the repo opts in', async () => {
    const { paths, repo } = await fixture({ worktreeRoot: 'repo-local' });

    const created = await createWorktree(
      { repoId: 'sample', prNumber: 10, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    const repoLocalRoot = await realpath(join(repo, '.neondeck', 'worktrees'));

    expect(created).toMatchObject({
      ok: true,
      worktree: { storageKind: 'repo-local' },
    });
    expect(worktree.localPath.startsWith(repoLocalRoot)).toBe(true);
  });

  it('uses global defaultStorage when the repo has no worktree override', async () => {
    const { paths, repo } = await fixture();
    await updateWorktreePolicy({ defaultStorage: 'repo-local' }, paths);

    const created = await createWorktree(
      { repoId: 'sample', prNumber: 13, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    const repoLocalRoot = await realpath(join(repo, '.neondeck', 'worktrees'));

    expect(created).toMatchObject({
      ok: true,
      worktree: { storageKind: 'repo-local' },
    });
    expect(worktree.localPath.startsWith(repoLocalRoot)).toBe(true);
  });

  it('recovers stale locks before acquiring a new lock', async () => {
    const { paths } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    const first = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: 'pr',
        owner: 'workflow-a',
        ttlSeconds: 30,
      },
      paths,
    );
    const firstLock = lockFrom(first);
    expireLock(paths.neondeckDatabase, firstLock.id);

    const before = await listWorktrees(paths);
    const second = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: 'pr',
        owner: 'workflow-b',
        ttlSeconds: 30,
      },
      paths,
    );

    expect(before).toMatchObject({
      staleLocks: [expect.objectContaining({ id: firstLock.id })],
    });
    expect(second).toMatchObject({
      ok: true,
      changed: true,
      lock: { owner: 'workflow-b' },
    });
    const inventory = await listWorktrees(paths);
    expect(inventory.activeLocks).toHaveLength(1);
    expect(inventory.activeLocks[0]).toMatchObject({ owner: 'workflow-b' });
  });

  it('recovers revoked locks after the cooperative handoff grace', async () => {
    const { paths } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    const first = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: 'pr',
        owner: 'workflow-a',
        ttlSeconds: 3_600,
      },
      paths,
    );
    const firstLock = lockFrom(first);
    await revokeWorktreeLockLease(firstLock.id, paths);

    const duringGrace = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: 'pr',
        owner: 'interactive-a',
      },
      paths,
    );
    ageLockRevocation(paths.neondeckDatabase, firstLock.id);
    const afterGrace = await lockWorktree(
      {
        worktreeId: worktree.id,
        scope: 'pr',
        owner: 'interactive-b',
      },
      paths,
    );
    const recovered = readWorktreeLock(firstLock.id, paths);

    expect(duringGrace).toMatchObject({
      ok: false,
      lock: { id: firstLock.id, owner: 'workflow-a' },
    });
    expect(afterGrace).toMatchObject({
      ok: true,
      lock: { owner: 'interactive-b' },
    });
    expect(recovered).toMatchObject({
      id: firstLock.id,
      revokedAt: expect.any(String),
      releasedAt: expect.any(String),
      staleRecoveredAt: expect.any(String),
    });
  });

  it('blocks worktree-targeted repo edits while another active lock is held', async () => {
    const { paths } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    const locked = await lockWorktree(
      { worktreeId: worktree.id, owner: 'workflow-a', ttlSeconds: 30 },
      paths,
    );
    const lock = lockFrom(locked);

    const blocked = await writeRepoFile(
      {
        repoId: 'sample',
        worktreeId: worktree.id,
        path: 'src/app.ts',
        content: 'blocked\n',
      },
      paths,
    );
    const allowed = await writeRepoFile(
      {
        repoId: 'sample',
        worktreeId: worktree.id,
        worktreeLockId: lock.id,
        path: 'src/app.ts',
        content: 'allowed\n',
      },
      paths,
    );

    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'WORKTREE_LOCKED' },
    });
    expect(allowed).toMatchObject({ ok: true, changed: true });
  });

  it('releases locks and records final worktree status', async () => {
    const { paths } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    const locked = await lockWorktree(
      { worktreeId: worktree.id, owner: 'workflow-a', ttlSeconds: 30 },
      paths,
    );
    const lock = lockFrom(locked);

    const released = await releaseWorktreeLock(
      { lockId: lock.id, owner: 'workflow-a', finalStatus: 'prepared-diff' },
      paths,
    );

    expect(released).toMatchObject({
      ok: true,
      changed: true,
      worktree: { lifecycleStatus: 'prepared-diff' },
    });

    await expect(
      releaseWorktreeLock({ lockId: lock.id, finalStatus: 'deleted' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('retains dirty worktrees and deletes clean succeeded worktrees after grace', async () => {
    const { paths } = await fixture();
    const dirtyCreated = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    const dirty = worktreeFrom(dirtyCreated);
    await writeFile(join(dirty.localPath, 'src/app.ts'), 'dirty\n');
    markSucceededOld(paths.neondeckDatabase, dirty.id);

    const cleanCreated = await createWorktree(
      { repoId: 'sample', prNumber: 8, headRef: 'feature' },
      paths,
    );
    const clean = worktreeFrom(cleanCreated);
    markSucceededOld(paths.neondeckDatabase, clean.id);

    const dirtyCleanup = await cleanupWorktrees(
      { worktreeId: dirty.id },
      paths,
    );
    const cleanCleanup = await cleanupWorktrees(
      { worktreeId: clean.id },
      paths,
    );

    expect(dirtyCleanup).toMatchObject({
      ok: true,
      changed: false,
      results: [expect.objectContaining({ reason: 'worktree is dirty' })],
    });
    expect(cleanCleanup).toMatchObject({
      ok: true,
      changed: true,
      results: [expect.objectContaining({ outcome: 'deleted' })],
    });
    await expect(stat(clean.localPath)).rejects.toThrow(/ENOENT|no such file/i);
  });

  it('applies current cleanup policy to existing failed worktrees', async () => {
    const { paths } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 11, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    markLifecycleOld(paths.neondeckDatabase, worktree.id, 'failed');

    await expect(
      cleanupWorktrees({ worktreeId: worktree.id }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      results: [
        expect.objectContaining({
          reason: 'failed worktrees are retained by policy',
        }),
      ],
    });

    await updateWorktreePolicy(
      {
        cleanup: {
          retainFailed: false,
          staleAgeHours: 1,
        },
        confirm: true,
      },
      paths,
    );

    await expect(
      cleanupWorktrees({ worktreeId: worktree.id }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      results: [expect.objectContaining({ outcome: 'deleted' })],
    });
  });

  it('requires explicit prepared-diff confirmation before forced cleanup', async () => {
    const { paths } = await fixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 17, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    markLifecycleOld(paths.neondeckDatabase, worktree.id, 'prepared-diff');

    await expect(
      cleanupWorktrees({ worktreeId: worktree.id, force: true }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: false,
      results: [
        expect.objectContaining({
          reason: 'prepared-diff worktrees are retained by policy',
        }),
      ],
    });

    await expect(
      cleanupWorktrees(
        {
          worktreeId: worktree.id,
          force: true,
          confirmPreparedDiff: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      results: [
        expect.objectContaining({
          outcome: 'deleted',
          reason: 'explicit cleanup requested',
        }),
      ],
    });
  });

  it('revalidates managed worktree roots before repo-edit access', async () => {
    const { paths } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'neondeck-outside-'));
    tempRoots.push(outside);
    await mkdir(join(outside, 'src'), { recursive: true });
    await writeFile(join(outside, 'src/app.ts'), 'outside\n');
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 12, headRef: 'feature' },
      paths,
    );
    const worktree = worktreeFrom(created);
    await rm(worktree.localPath, { recursive: true, force: true });
    await symlink(outside, worktree.localPath);

    const result = await readRepoFile(
      { repoId: 'sample', worktreeId: worktree.id, path: 'src/app.ts' },
      paths,
    );
    const events = await listRepoEditEvents(paths);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PATH_OUTSIDE_WORKTREE_ROOT' },
    });
    expect(events.events[0]).toMatchObject({
      action: 'read',
      status: 'failed',
      error: { code: 'PATH_OUTSIDE_WORKTREE_ROOT' },
    });
  });

  it('rejects adopted paths outside declared worktree roots', async () => {
    const { paths, repo } = await fixture();
    const result = await createWorktree(
      {
        repoId: 'sample',
        prNumber: 9,
        headRef: 'feature',
        localPath: repo,
        adopted: true,
      },
      paths,
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PATH_OUTSIDE_WORKTREE_ROOT' },
    });
  });
});

async function fixture(options: { worktreeRoot?: 'home' | 'repo-local' } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-home-'));
  const repoRoot = await mkdtemp(join(tmpdir(), 'neondeck-repo-'));
  const repo = join(repoRoot, 'repository');
  tempRoots.push(home, repoRoot);
  const paths = runtimePaths(home);

  if (!repositorySeed) {
    throw new Error('Worktree Git repository seed is unavailable.');
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
            ...(options.worktreeRoot
              ? { worktreeRoot: options.worktreeRoot }
              : {}),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  return { home, repo, paths };
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd, env: unsignedGitEnv() });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: unsignedGitEnv(),
  });
  return stdout.trim();
}

function unsignedGitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
  };
}

function worktreeFrom(result: unknown) {
  expect(result).toMatchObject({ ok: true, worktree: expect.any(Object) });
  return (result as { worktree: { id: string; localPath: string } }).worktree;
}

function lockFrom(result: unknown) {
  expect(result).toMatchObject({ ok: true, lock: expect.any(Object) });
  return (result as { lock: { id: string } }).lock;
}

function expireLock(databasePath: string, id: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
        UPDATE worktree_locks
        SET expires_at = ?
        WHERE id = ?;
      `,
      )
      .run(new Date(Date.now() - 60_000).toISOString(), id);
  } finally {
    database.close();
  }
}

function ageLockRevocation(databasePath: string, id: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
        UPDATE worktree_locks
        SET revoked_at = ?
        WHERE id = ?;
      `,
      )
      .run(new Date(Date.now() - 60_000).toISOString(), id);
  } finally {
    database.close();
  }
}

function markLifecycleOld(databasePath: string, id: string, status: string) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
        UPDATE worktrees
        SET lifecycle_status = ?,
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        status,
        new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        id,
      );
  } finally {
    database.close();
  }
}

function markSucceededOld(databasePath: string, id: string) {
  markLifecycleOld(databasePath, id, 'succeeded');
}
