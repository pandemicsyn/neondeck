import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvePreparedDiffPush } from './prepared-diffs';
import { readKiloTaskStatus } from './kilo-actions';
import {
  listKiloResultStates,
  promoteKiloResult,
  reviewKiloResult,
  verifyKiloResult,
} from './kilo-results';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { createWorktree } from './worktrees';

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

describe('Kilo result review, verification, and promotion', () => {
  it('reviews, verifies, and admits a managed Kilo result without pushing', async () => {
    const { paths, worktreeId, worktreePath } = await fixture();
    await writeFile(join(worktreePath, 'README.md'), '# sample\n\nchanged\n');
    insertKiloTask(paths, {
      taskId: 'kilo-task-1',
      worktreeId,
      cwd: worktreePath,
    });

    const reviewed = await reviewKiloResult({ taskId: 'kilo-task-1' }, paths);
    const preparedDiffId = resultPreparedDiffId(reviewed);

    expect(reviewed).toMatchObject({
      ok: true,
      changed: true,
      action: 'kilo_result_review',
      resultState: {
        classification: 'ready-to-verify',
        verificationStatus: 'not-run',
        pendingApprovals: [
          expect.objectContaining({ type: 'prepared-diff-push' }),
        ],
      },
      diff: {
        ok: true,
        fileCount: 1,
      },
    });
    await expect(
      readKiloTaskStatus({ taskId: 'kilo-task-1' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      task: {
        reviewClassification: 'ready-to-verify',
        verificationState: 'not-run',
        pendingApprovals: [
          expect.objectContaining({ type: 'prepared-diff-push' }),
        ],
      },
    });

    const verified = await verifyKiloResult(
      {
        taskId: 'kilo-task-1',
        checks: ['node --version'],
        context: 'unattended',
      },
      paths,
    );

    expect(verified).toMatchObject({
      ok: true,
      changed: true,
      action: 'kilo_result_verify',
      resultState: {
        classification: 'ready-to-push',
        verificationStatus: 'passed',
      },
    });

    await expect(
      approvePreparedDiffPush(
        {
          preparedDiffId,
          confirm: true,
          approverSurface: 'test',
          reason: 'fixture approval',
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true });

    const promoted = await promoteKiloResult({ taskId: 'kilo-task-1' }, paths);

    expect(promoted).toMatchObject({
      ok: true,
      changed: true,
      action: 'kilo_result_promote',
      resultState: {
        promotionStatus: 'deferred',
      },
      data: {
        admitted: true,
        deferred: true,
        actualMutations: [],
      },
      requires: ['push_pr_autofix'],
    });
  });

  it('discards a completed Kilo task with no diff', async () => {
    const { paths, worktreeId, worktreePath } = await fixture();
    insertKiloTask(paths, {
      taskId: 'kilo-task-empty',
      worktreeId,
      cwd: worktreePath,
    });

    await expect(
      reviewKiloResult({ taskId: 'kilo-task-empty' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      resultState: { classification: 'discard', pendingApprovals: [] },
      diff: { fileCount: 0 },
    });

    await expect(
      listKiloResultStates({ taskId: 'kilo-task-empty' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      resultStates: [
        {
          taskId: 'kilo-task-empty',
          classification: 'discard',
        },
      ],
    });
  });

  it('keeps Kilo result review recoverable when the task workspace is missing', async () => {
    const { paths, worktreeId } = await fixture();
    const missingWorktreePath = join(paths.home, 'missing-kilo-worktree');
    insertKiloTask(paths, {
      taskId: 'kilo-task-missing-cwd',
      worktreeId,
      cwd: missingWorktreePath,
    });

    await expect(
      reviewKiloResult({ taskId: 'kilo-task-missing-cwd' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      changed: true,
      resultState: {
        classification: 'discard',
        pendingApprovals: [],
      },
      diff: {
        ok: false,
        path: missingWorktreePath,
        fileCount: 0,
        error: expect.any(String),
      },
    });
  });

  it('blocks review and verification before a terminal reviewed Kilo result exists', async () => {
    const { paths, worktreeId, worktreePath } = await fixture();
    await writeFile(join(worktreePath, 'README.md'), '# sample\n\nchanged\n');
    insertKiloTask(paths, {
      taskId: 'kilo-task-running',
      worktreeId,
      cwd: worktreePath,
      status: 'running',
    });

    await expect(
      reviewKiloResult({ taskId: 'kilo-task-running' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['completed-kilo-task'],
    });
    await expect(
      promoteKiloResult({ taskId: 'kilo-task-running' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['completed-kilo-task'],
    });

    insertKiloTask(paths, {
      taskId: 'kilo-task-unreviewed',
      worktreeId,
      cwd: worktreePath,
    });
    await expect(
      verifyKiloResult(
        {
          taskId: 'kilo-task-unreviewed',
          checks: ['node --version'],
          context: 'unattended',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: true,
      requires: ['review_kilo_result'],
    });
  });

  it('invalidates stale verification and push approval when the diff changes', async () => {
    const { paths, worktreeId, worktreePath } = await fixture();
    await writeFile(join(worktreePath, 'README.md'), '# sample\n\nfirst\n');
    insertKiloTask(paths, {
      taskId: 'kilo-task-stale',
      worktreeId,
      cwd: worktreePath,
    });
    const reviewed = await reviewKiloResult(
      { taskId: 'kilo-task-stale' },
      paths,
    );
    const preparedDiffId = resultPreparedDiffId(reviewed);
    await verifyKiloResult(
      {
        taskId: 'kilo-task-stale',
        checks: ['node --version'],
        context: 'unattended',
      },
      paths,
    );
    await approvePreparedDiffPush(
      {
        preparedDiffId,
        confirm: true,
        approverSurface: 'test',
        reason: 'fixture approval',
      },
      paths,
    );

    await writeFile(join(worktreePath, 'README.md'), '# sample\n\nsecond\n');
    await expect(
      reviewKiloResult({ taskId: 'kilo-task-stale' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      resultState: {
        verificationStatus: 'not-run',
        promotionStatus: 'not-requested',
        verifiedDiffFingerprint: null,
        pendingApprovals: [
          expect.objectContaining({
            type: 'prepared-diff-push',
            status: 'pending',
          }),
        ],
      },
    });

    await expect(
      promoteKiloResult({ taskId: 'kilo-task-stale' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      resultState: {
        promotionStatus: 'blocked',
      },
      requires: expect.arrayContaining([
        'verification',
        'verified-diff',
        'prepared-diff-approval',
      ]),
    });
  });
});

async function fixture() {
  const home = await tempDir();
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  const repo = join(home, 'repo');
  await mkdir(repo, { recursive: true });
  await setupGitRepo(repo);
  await writeFile(
    paths.config,
    JSON.stringify(
      {
        version: 1,
        execution: {
          enabledBackends: ['local'],
          unattended: 'allow-preapproved',
          preapprovedCommands: [
            {
              id: 'node-version',
              command: 'node --version',
              match: 'exact',
              backends: ['local'],
            },
          ],
        },
        autopilot: {
          defaultMode: 'autofix-push-when-safe',
          limits: {
            requiredChecks: ['node --version'],
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    paths.repos,
    JSON.stringify(
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
    ),
  );
  const created = await createWorktree(
    {
      repoId: 'sample',
      prNumber: 7,
      headRef: 'main',
      directPushAllowed: true,
    },
    paths,
  );
  const worktree = worktreeFrom(created);
  return {
    paths,
    repo,
    worktreeId: worktree.id,
    worktreePath: worktree.localPath,
  };
}

async function setupGitRepo(repo: string) {
  await writeFile(join(repo, 'README.md'), '# sample\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'neon@example.test'], {
    cwd: repo,
  });
  await execFileAsync('git', ['config', 'user.name', 'Neon Test'], {
    cwd: repo,
  });
  await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-kilo-result-test-'));
  tempRoots.push(path);
  return path;
}

function insertKiloTask(
  paths: RuntimePaths,
  input: { taskId: string; worktreeId: string; cwd: string; status?: string },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.taskId,
        'Kilo result fixture',
        'Change README.',
        'sample',
        'pandemicsyn/sample',
        input.worktreeId,
        null,
        input.cwd,
        'draft-fix',
        input.status ?? 'succeeded',
        1,
        1,
        'kilo',
        JSON.stringify(['run', 'Change README.']),
        null,
        null,
        'ses_root',
        JSON.stringify([]),
        null,
        null,
        0,
        null,
        now,
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function worktreeFrom(result: Awaited<ReturnType<typeof createWorktree>>) {
  if (
    !('worktree' in result) ||
    !result.worktree ||
    typeof result.worktree !== 'object' ||
    !('id' in result.worktree) ||
    !('localPath' in result.worktree) ||
    typeof result.worktree.id !== 'string' ||
    typeof result.worktree.localPath !== 'string'
  ) {
    throw new Error('Expected worktree record.');
  }
  return result.worktree;
}

function resultPreparedDiffId(
  result: Awaited<ReturnType<typeof reviewKiloResult>>,
) {
  const state = 'resultState' in result ? result.resultState : undefined;
  if (!state?.preparedDiffId) {
    throw new Error('Expected prepared diff id.');
  }
  return state.preparedDiffId;
}
