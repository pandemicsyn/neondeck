import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonPreparedDiff,
  approvePreparedDiffPush,
  ensurePreparedDiffForWorktree,
  listPreparedDiffs,
  readPreparedDiffChangedFiles,
  readPreparedDiffFileDiff,
  readPreparedDiffSummary,
  requestPreparedDiffRevision,
  runPreparedDiffVerification,
} from './prepared-diffs';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { createWorktree, lockWorktree, releaseWorktreeLock } from './worktrees';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

vi.setConfig({ testTimeout: 60_000 });

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('prepared diff lifecycle', () => {
  it('creates records from prepared worktrees and reads diffs from the source worktree', async () => {
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
    const fileDiff = await readPreparedDiffFileDiff(
      { preparedDiffId: prepared.id, path: 'src/app.ts' },
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
      approvals: [
        expect.objectContaining({
          preparedDiffId: prepared.id,
          approvalType: 'push',
          status: 'pending',
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
    expect(fileDiff.diff).toContain('export const value = 2;');
  });

  it('records approval, verification, revision, and abandon decisions without pushing', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);

    const blockedApproval = await approvePreparedDiffPush(
      { preparedDiffId: prepared.id },
      paths,
    );
    const approved = await approvePreparedDiffPush(
      {
        preparedDiffId: prepared.id,
        confirm: true,
        reason: 'Looks safe.',
        approverSurface: 'test',
      },
      paths,
    );
    const verification = await runPreparedDiffVerification(
      { preparedDiffId: prepared.id, checkName: 'npm run check' },
      paths,
    );
    const revision = await requestPreparedDiffRevision(
      { preparedDiffId: prepared.id, reason: 'Tighten the test.' },
      paths,
    );
    const blockedAbandon = await abandonPreparedDiff(
      { preparedDiffId: prepared.id },
      paths,
    );
    const abandoned = await abandonPreparedDiff(
      { preparedDiffId: prepared.id, confirm: true, reason: 'Superseded.' },
      paths,
    );
    const invalidAfterAbandon = await approvePreparedDiffPush(
      { preparedDiffId: prepared.id, confirm: true },
      paths,
    );
    const filtered = await listPreparedDiffs({ repoId: 'missing' }, paths);

    expect(blockedApproval).toMatchObject({
      ok: false,
      requires: ['confirm'],
    });
    expect(approved).toMatchObject({
      ok: true,
      changed: true,
      preparedDiff: { status: 'push-approved', pushApprovalStatus: 'approved' },
      data: { nextWorkflow: 'push_pr_autofix' },
    });
    expect(verification).toMatchObject({
      ok: true,
      preparedDiff: {
        status: 'verification-requested',
        verificationStatus: 'requested',
      },
      approvals: [],
      data: { nextWorkflow: 'verify_pr_worktree' },
    });
    expect(revision).toMatchObject({
      ok: true,
      preparedDiff: { status: 'revision-requested' },
    });
    expect(blockedAbandon).toMatchObject({
      ok: false,
      requires: ['confirm'],
    });
    expect(abandoned).toMatchObject({
      ok: true,
      preparedDiff: { status: 'abandoned', abandonedAt: expect.any(String) },
    });
    expect(invalidAfterAbandon).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(filtered).toMatchObject({
      ok: true,
      preparedDiffs: [],
      approvals: [],
    });
    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [],
    });
  });

  it('preserves approval and verification state on idempotent prepared diff reads', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await approvePreparedDiffPush(
      {
        preparedDiffId: prepared.id,
        confirm: true,
        reason: 'Looks safe.',
        approverSurface: 'test',
      },
      paths,
    );
    await runPreparedDiffVerification(
      { preparedDiffId: prepared.id, checkName: 'npm run check' },
      paths,
    );

    const idempotent = await ensurePreparedDiffForWorktree(
      worktreeLikeFromPrepared(prepared),
      paths,
    );

    expect(idempotent).toMatchObject({
      id: prepared.id,
      status: 'verification-requested',
      pushApprovalStatus: 'approved',
      verificationStatus: 'requested',
    });
    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [
        expect.objectContaining({
          id: prepared.id,
          status: 'verification-requested',
          pushApprovalStatus: 'approved',
          verificationStatus: 'requested',
        }),
      ],
    });

    const regenerated = await ensurePreparedDiffForWorktree(
      worktreeLikeFromPrepared(prepared),
      paths,
      { resetDecisionState: true },
    );

    expect(regenerated).toMatchObject({
      id: prepared.id,
      status: 'prepared',
      pushApprovalStatus: 'pending',
      verificationStatus: 'not-run',
    });
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-prepared-diff-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-prepared-source-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  await createRepo(repo);
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
  return { paths, repo };
}

async function createRepo(repo: string) {
  await mkdir(join(repo, 'src'), { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Neondeck Test']);
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  await git(repo, ['checkout', '-b', 'feature']);
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 2;\n');
  await git(repo, ['commit', '-am', 'feature']);
  await git(repo, ['checkout', 'main']);
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

function worktreeLikeFromPrepared(
  prepared: Awaited<ReturnType<typeof preparedFixture>>,
) {
  return {
    id: prepared.worktreeId,
    repoId: prepared.repoId,
    repoFullName: prepared.repoFullName,
    prNumber: prepared.prNumber,
    localPath: prepared.sourceWorktreePath,
    baseRef: prepared.baseRef,
    headRef: prepared.headRef,
    headSha: prepared.headSha,
    lifecycleStatus: 'prepared-diff',
  };
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

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}
