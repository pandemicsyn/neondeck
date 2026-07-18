import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import {
  abandonPreparedDiff,
  ensurePreparedDiffForWorktree,
  listPreparedDiffs,
  readPreparedDiffChangedFiles,
  readPreparedDiffFileDiff,
  readPreparedDiffSummary,
  requestPreparedDiffRevision,
  runPreparedDiffVerification,
} from './modules/prepared-diffs';
import { approvePreparedDiffPushWithPolicy } from './modules/autopilot';
import {
  abandonPreparedDiffWithRevisionAbort,
  runPreparedDiffRevision,
} from './modules/autopilot';
import { reconcilePreparedDiffRevisionResult } from './modules/kilo';
import type { KiloTaskRecord } from './modules/kilo';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import {
  createWorktree,
  lockWorktree,
  releaseWorktreeLock,
} from './modules/worktrees';
import {
  createSeededGitRepository,
  type SeededGitRepository,
} from './testing/git-repository-fixture';
import { reviewRevisionKey } from '../shared/review-source';

const execFileAsync = promisify(execFile);
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
    expect(files.revision).toMatchObject({
      state: 'resolved',
      kind: 'worktree-diff',
      id: expect.any(String),
      baseId: expect.any(String),
    });
    const revisionKey = reviewRevisionKey(files.revision!);
    await expect(
      readPreparedDiffFileDiff(
        {
          preparedDiffId: prepared.id,
          path: 'src/app.ts',
          expectedRevisionKey: revisionKey ?? undefined,
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true, revision: files.revision });
    await writeFile(
      join(prepared.sourceWorktreePath, 'src/app.ts'),
      'export const value = 3;\n',
    );
    await expect(
      readPreparedDiffFileDiff(
        {
          preparedDiffId: prepared.id,
          path: 'src/app.ts',
          expectedRevisionKey: revisionKey ?? undefined,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['refresh'],
      errors: ['The requested revision is stale.'],
    });
    expect(fileDiff.diff).toContain('export const value = 2;');
  });

  it('records approval, verification, revision, and abandon decisions without pushing', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);

    const blockedApproval = await approvePreparedDiffPushWithPolicy(
      { preparedDiffId: prepared.id },
      paths,
    );
    const approved = await approvePreparedDiffPushWithPolicy(
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
    const invalidAfterAbandon = await approvePreparedDiffPushWithPolicy(
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
      approvals: [
        {
          approvalType: 'push',
          status: 'approved',
          targetSha: expect.any(String),
          policyHash: expect.any(String),
          policyDecision: expect.any(String),
        },
      ],
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
    await approvePreparedDiffPushWithPolicy(
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

  it('resets approval and verification state when releasing a revised prepared-diff worktree', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await approvePreparedDiffPushWithPolicy(
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
    const locked = await lockWorktree(
      {
        worktreeId: prepared.worktreeId,
        owner: 'revision',
        ttlSeconds: 300,
      },
      paths,
    );
    const lock = objectField(locked, 'lock');

    await expect(
      releaseWorktreeLock(
        {
          lockId: stringField(lock, 'id'),
          owner: 'revision',
          finalStatus: 'prepared-diff',
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      listPreparedDiffs({ includeTerminal: true }, paths),
    ).resolves.toMatchObject({
      preparedDiffs: [
        expect.objectContaining({
          id: prepared.id,
          status: 'prepared',
          pushApprovalStatus: 'pending',
          verificationStatus: 'not-run',
        }),
      ],
    });
  });

  it('starts a Kilo revision run with the operator note and prepared-diff context', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason: 'Keep the helper pure and add a regression test.',
        approverSurface: 'test',
      },
      paths,
    );
    const startInputs: unknown[] = [];
    const fakeStart = vi.fn<(input: unknown) => Promise<unknown>>(
      async (input) => {
        startInputs.push(input);
        return {
          ok: true,
          action: 'kilo_task_start',
          changed: true,
          message: 'Started fake Kilo task.',
          taskId: 'kilo-revision-1',
          task: {
            id: 'kilo-revision-1',
            status: 'running',
            title: 'Revise prepared diff',
            cwd: prepared.sourceWorktreePath,
          },
        };
      },
    );

    const started = await runPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        approverSurface: 'test',
      },
      paths,
      { startKiloTask: fakeStart as never },
    );
    const duplicate = await runPreparedDiffRevision(
      { preparedDiffId: prepared.id },
      paths,
      { startKiloTask: fakeStart as never },
    );

    expect(started).toMatchObject({
      ok: true,
      preparedDiff: {
        status: 'revision-in-progress',
        summary: {
          revisionReason: 'Keep the helper pure and add a regression test.',
          revisionRun: {
            kiloTaskId: 'kilo-revision-1',
            reason: 'Keep the helper pure and add a regression test.',
            outcome: 'started',
            startedHeadSha: expect.any(String),
          },
        },
      },
      data: { kiloTaskId: 'kilo-revision-1' },
    });
    expect(duplicate).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]).toMatchObject({
      worktreeId: prepared.worktreeId,
      mode: 'draft-fix',
      allowAuto: true,
      confirmAuto: true,
      explicitUserRequest: true,
    });
    const prompt = stringField(
      startInputs[0] as Record<string, unknown>,
      'prompt',
    );
    expect(prompt).toContain('Keep the helper pure and add a regression test.');
    expect(prompt).toContain('pandemicsyn/sample#7');
    expect(prompt).toContain('src/app.ts');
    expect(prompt).toContain('Never push branches');
  });

  it('returns a typed revision failure when the prepared worktree is missing', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason: 'Try a smaller adapter.',
        approverSurface: 'test',
      },
      paths,
    );
    const database = new DatabaseSync(paths.neondeckDatabase);
    try {
      database
        .prepare('DELETE FROM worktrees WHERE id = ?;')
        .run(prepared.worktreeId);
    } finally {
      database.close();
    }
    const fakeStart = vi.fn<() => Promise<unknown>>(async () => ({
      ok: true,
      action: 'kilo_task_start',
      changed: true,
      message: 'Started fake Kilo task.',
      taskId: 'unexpected-task',
    }));

    await expect(
      runPreparedDiffRevision({ preparedDiffId: prepared.id }, paths, {
        startKiloTask: fakeStart as never,
      }),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      preparedDiff: { id: prepared.id, status: 'revision-requested' },
      requires: ['worktreeId'],
      error: { code: 'WORKTREE_NOT_FOUND' },
    });
    expect(fakeStart).not.toHaveBeenCalled();
  });

  it('does not clobber an admitted revision run when a duplicate start loses the Kilo lock', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    const reason = 'Keep the admitted run linked.';
    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason,
        approverSurface: 'test',
      },
      paths,
    );
    const fakeStart = vi.fn<() => Promise<unknown>>(async () => {
      setPreparedDiffRevisionInProgress(paths.neondeckDatabase, prepared, {
        taskId: 'kilo-revision-live',
        reason,
      });
      return {
        ok: false,
        action: 'kilo_task_start',
        changed: false,
        message: 'Kilo handoff concurrency limit reached (1).',
      };
    });

    const result = await runPreparedDiffRevision(
      { preparedDiffId: prepared.id },
      paths,
      { startKiloTask: fakeStart as never },
    );

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      preparedDiff: {
        status: 'revision-in-progress',
        summary: {
          revisionRun: {
            kiloTaskId: 'kilo-revision-live',
            reason,
          },
        },
      },
    });
    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [
        expect.objectContaining({
          id: prepared.id,
          status: 'revision-in-progress',
          summary: expect.objectContaining({
            revisionRun: expect.objectContaining({
              kiloTaskId: 'kilo-revision-live',
            }),
          }),
        }),
      ],
    });
  });

  it('re-enters review after a successful revision run and restores request state after failure', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason: 'Use the smaller adapter.',
        approverSurface: 'test',
      },
      paths,
    );
    const started = await runPreparedDiffRevision(
      { preparedDiffId: prepared.id },
      paths,
      { startKiloTask: fakeRevisionStarter(prepared, 'kilo-revision-ok') },
    );

    const completed = await reconcilePreparedDiffRevisionResult(
      {
        task: kiloRevisionTask(prepared, 'kilo-revision-ok', 'succeeded'),
        status: 'succeeded',
        diff: { ok: true, fileCount: 1 },
      },
      paths,
    );

    expect(completed).toMatchObject({
      id: prepared.id,
      status: 'prepared',
      pushApprovalStatus: 'pending',
      verificationStatus: 'not-run',
      summary: {
        revisionRun: {
          kiloTaskId: 'kilo-revision-ok',
          outcome: 'completed',
        },
      },
    });
    expect(started.preparedDiff?.status).toBe('revision-in-progress');

    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason: 'Try a different revision.',
        approverSurface: 'test',
      },
      paths,
    );
    await runPreparedDiffRevision({ preparedDiffId: prepared.id }, paths, {
      startKiloTask: fakeRevisionStarter(prepared, 'kilo-revision-failed'),
    });
    const failed = await reconcilePreparedDiffRevisionResult(
      {
        task: kiloRevisionTask(prepared, 'kilo-revision-failed', 'failed'),
        status: 'failed',
        error: 'Kilo failed.',
      },
      paths,
    );

    expect(failed).toMatchObject({
      id: prepared.id,
      status: 'revision-requested',
      pushApprovalStatus: 'rejected',
      summary: {
        revisionRun: {
          kiloTaskId: 'kilo-revision-failed',
          outcome: 'failed',
          error: 'Kilo failed.',
        },
      },
    });
  });

  it('treats committed and restart-recovered revision output as completed', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason: 'Commit the revision locally.',
        approverSurface: 'test',
      },
      paths,
    );
    await runPreparedDiffRevision({ preparedDiffId: prepared.id }, paths, {
      startKiloTask: fakeRevisionStarter(prepared, 'kilo-revision-commit'),
    });
    await writeFile(
      join(prepared.sourceWorktreePath, 'src/app.ts'),
      'export const value = 3;\n',
    );
    await git(prepared.sourceWorktreePath, ['add', '-A']);
    await git(prepared.sourceWorktreePath, ['commit', '-m', 'revision commit']);

    const completed = await reconcilePreparedDiffRevisionResult(
      {
        task: kiloRevisionTask(prepared, 'kilo-revision-commit', 'unknown'),
        status: 'unknown',
        diff: { ok: true, fileCount: 0 },
      },
      paths,
    );

    expect(completed).toMatchObject({
      id: prepared.id,
      status: 'prepared',
      summary: {
        revisionRun: {
          kiloTaskId: 'kilo-revision-commit',
          outcome: 'completed',
          changedFiles: 0,
          completedHeadSha: expect.any(String),
        },
      },
    });
  });

  it('requires aborting an in-progress revision before abandon and supports user-surface abort', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason: 'Stop this run.',
        approverSurface: 'test',
      },
      paths,
    );
    await runPreparedDiffRevision({ preparedDiffId: prepared.id }, paths, {
      startKiloTask: fakeRevisionStarter(prepared, 'kilo-revision-abandon'),
    });
    insertKiloTaskRow(paths.neondeckDatabase, prepared, {
      taskId: 'kilo-revision-abandon',
      status: 'running',
    });

    await expect(
      abandonPreparedDiff(
        { preparedDiffId: prepared.id, confirm: true, reason: 'Stop.' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['revisionRunAbort'],
    });

    const fakeAbort = vi.fn<() => Promise<unknown>>(async () => ({
      ok: true,
      action: 'kilo_task_abort',
      changed: true,
      message: 'Stopped fake Kilo task.',
    }));
    await expect(
      abandonPreparedDiffWithRevisionAbort(
        { preparedDiffId: prepared.id, confirm: true, reason: 'Stop.' },
        paths,
        { abortKiloTask: fakeAbort as never },
      ),
    ).resolves.toMatchObject({
      ok: true,
      preparedDiff: { status: 'abandoned' },
    });
    expect(fakeAbort).toHaveBeenCalledWith(
      { taskId: 'kilo-revision-abandon' },
      paths,
    );
    await expect(
      ensurePreparedDiffForWorktree(worktreeLikeFromPrepared(prepared), paths, {
        createdBy: 'kilo:kilo-revision-abandon',
        resetDecisionState: true,
      }),
    ).resolves.toMatchObject({
      id: prepared.id,
      status: 'abandoned',
    });
  });

  it('does not abandon a revision task that still needs reconciliation', async () => {
    const { paths } = await fixture();
    const prepared = await preparedFixture(paths);
    await requestPreparedDiffRevision(
      {
        preparedDiffId: prepared.id,
        reason: 'Reconcile before abandoning.',
        approverSurface: 'test',
      },
      paths,
    );
    await runPreparedDiffRevision({ preparedDiffId: prepared.id }, paths, {
      startKiloTask: fakeRevisionStarter(prepared, 'kilo-revision-reconcile'),
    });
    insertKiloTaskRow(paths.neondeckDatabase, prepared, {
      taskId: 'kilo-revision-reconcile',
      status: 'needs-reconcile',
    });

    await expect(
      abandonPreparedDiffWithRevisionAbort(
        { preparedDiffId: prepared.id, confirm: true, reason: 'Stop.' },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      preparedDiff: { status: 'revision-in-progress' },
      requires: ['revisionRunReconcile'],
      error: { code: 'REVISION_RUN_NEEDS_RECONCILE' },
    });
    await expect(listPreparedDiffs({}, paths)).resolves.toMatchObject({
      preparedDiffs: [
        expect.objectContaining({
          id: prepared.id,
          status: 'revision-in-progress',
        }),
      ],
    });
  });
});

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
  return { paths, repo };
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

function fakeRevisionStarter(
  prepared: Awaited<ReturnType<typeof preparedFixture>>,
  taskId: string,
) {
  return vi.fn<() => Promise<unknown>>(async () => ({
    ok: true,
    action: 'kilo_task_start',
    changed: true,
    message: 'Started fake Kilo task.',
    taskId,
    task: {
      id: taskId,
      status: 'running',
      title: 'Revision fixture',
      cwd: prepared.sourceWorktreePath,
    },
  })) as never;
}

function kiloRevisionTask(
  prepared: Awaited<ReturnType<typeof preparedFixture>>,
  taskId: string,
  status: KiloTaskRecord['status'],
): KiloTaskRecord {
  const now = new Date().toISOString();
  return {
    id: taskId,
    title: 'Revision fixture',
    prompt: 'Revise the prepared diff.',
    repoId: prepared.repoId,
    repoFullName: prepared.repoFullName,
    worktreeId: prepared.worktreeId,
    lockId: null,
    cwd: prepared.sourceWorktreePath,
    mode: 'draft-fix',
    status,
    explicitUserRequest: true,
    autoEnabled: true,
    cliPath: 'kilo',
    args: [],
    pid: null,
    processStartedAt: null,
    rootSessionId: null,
    childSessionIds: [],
    rawLogPath: null,
    summary: null,
    exitCode: status === 'succeeded' ? 0 : 1,
    error: status === 'succeeded' ? null : 'Kilo failed.',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
}

function insertKiloTaskRow(
  databasePath: string,
  prepared: Awaited<ReturnType<typeof preparedFixture>>,
  input: { taskId: string; status: KiloTaskRecord['status'] },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
        INSERT INTO kilo_tasks (
          id, title, prompt, repo_id, repo_full_name, worktree_id, lock_id, cwd,
          mode, status, explicit_user_request, auto_enabled, cli_path,
          args_json, pid, process_started_at, root_session_id,
          child_session_ids_json, raw_log_path, summary, exit_code, error,
          created_at, updated_at, completed_at
        )
        VALUES (?, 'Revision fixture', 'Revise.', ?, ?, ?, NULL, ?,
          'draft-fix', ?, 1, 1, 'kilo', '[]', NULL, NULL, NULL, '[]',
          NULL, NULL, NULL, NULL, ?, ?, NULL);
      `,
      )
      .run(
        input.taskId,
        prepared.repoId,
        prepared.repoFullName,
        prepared.worktreeId,
        prepared.sourceWorktreePath,
        input.status,
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function setPreparedDiffRevisionInProgress(
  databasePath: string,
  prepared: Awaited<ReturnType<typeof preparedFixture>>,
  input: { taskId: string; reason: string },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(databasePath);
  const summary = {
    ...plainObject(prepared.summary),
    revisionReason: input.reason,
    revisionRun: {
      kiloTaskId: input.taskId,
      reason: input.reason,
      startedAt: now,
      startedHeadSha: prepared.headSha ?? 'revision-start',
      outcome: 'started',
      status: 'running',
      title: 'Revision fixture',
      cwd: prepared.sourceWorktreePath,
    },
  };
  try {
    database
      .prepare(
        `
        UPDATE prepared_diffs
        SET status = 'revision-in-progress',
            summary_json = ?,
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(JSON.stringify(summary), now, prepared.id);
  } finally {
    database.close();
  }
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  await execFileAsync('git', args, { cwd, env: unsignedGitEnv() });
}

function unsignedGitEnv() {
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
  };
}
