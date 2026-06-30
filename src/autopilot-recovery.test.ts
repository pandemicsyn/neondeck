import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { notifyAutopilotState } from './autopilot-notifications';
import {
  readAutopilotRecoveryOptions,
  runAutopilotRecoveryAction,
} from './autopilot-recovery';
import { listNotifications } from './app-state';
import { ensurePreparedDiffForWorktree } from './prepared-diffs';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';
import { createWorktree, readWorktreeRecord } from './worktrees';

const tempRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('autopilot recovery and notifications', () => {
  it('dedupes repeated autopilot state notifications while preserving state changes', async () => {
    const paths = await fixture();
    insertPreparedDiff(paths.neondeckDatabase, {
      id: 'pd-notify',
      status: 'prepared',
    });

    await notifyAutopilotState(
      {
        state: 'verify',
        outcome: 'failed',
        preparedDiffId: 'pd-notify',
        worktreeId: 'wt-notify',
        repoFullName: 'example/sample',
        prNumber: 7,
        workflow: 'verify_pr_worktree',
        message: 'One or more verification checks failed.',
      },
      paths,
    );
    await notifyAutopilotState(
      {
        state: 'verify',
        outcome: 'failed',
        preparedDiffId: 'pd-notify',
        worktreeId: 'wt-notify',
        repoFullName: 'example/sample',
        prNumber: 7,
        workflow: 'verify_pr_worktree',
        message: 'One or more verification checks failed.',
      },
      paths,
    );
    await notifyAutopilotState(
      {
        state: 'verify',
        outcome: 'passed',
        preparedDiffId: 'pd-notify',
        worktreeId: 'wt-notify',
        repoFullName: 'example/sample',
        prNumber: 7,
        workflow: 'verify_pr_worktree',
        message: 'Verification passed.',
      },
      paths,
    );

    const notifications = await listNotifications(paths);

    expect(notifications).toHaveLength(2);
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'attention',
          sourceId: 'prepared-diff:pd-notify:verify:failed',
          occurrenceCount: 2,
        }),
        expect.objectContaining({
          level: 'ready',
          sourceId: 'prepared-diff:pd-notify:verify:passed',
          occurrenceCount: 1,
        }),
      ]),
    );
  });

  it('lists and runs bounded prepared-diff recovery actions', async () => {
    const paths = await fixture();
    insertPreparedDiff(paths.neondeckDatabase, {
      id: 'pd-recovery',
      status: 'push-blocked',
      pushApprovalStatus: 'approved',
      verificationStatus: 'passed',
    });

    const options = await readAutopilotRecoveryOptions(
      { preparedDiffId: 'pd-recovery' },
      paths,
    );
    const revision = await runAutopilotRecoveryAction(
      {
        preparedDiffId: 'pd-recovery',
        recoveryAction: 'request-revision',
        reason: 'Tighten the implementation.',
      },
      paths,
    );
    const blockedAbandon = await runAutopilotRecoveryAction(
      {
        preparedDiffId: 'pd-recovery',
        recoveryAction: 'abandon',
      },
      paths,
    );
    const abandoned = await runAutopilotRecoveryAction(
      {
        preparedDiffId: 'pd-recovery',
        recoveryAction: 'abandon',
        confirm: true,
        reason: 'Superseded.',
      },
      paths,
    );

    expect(options).toMatchObject({
      ok: true,
      options: expect.arrayContaining([
        expect.objectContaining({ id: 'inspect-worktree' }),
        expect.objectContaining({ id: 'retry-after-new-commit' }),
        expect.objectContaining({ id: 'rebase-resync-worktree' }),
        expect.objectContaining({ id: 'retry-verify' }),
        expect.objectContaining({ id: 'retry-push' }),
        expect.objectContaining({ id: 'retry-comment' }),
        expect.objectContaining({ id: 'request-revision' }),
        expect.objectContaining({ id: 'cleanup-worktree', destructive: true }),
        expect.objectContaining({ id: 'abandon', destructive: true }),
      ]),
    });
    expect(revision).toMatchObject({
      ok: true,
      action: 'autopilot_recovery_run',
      result: {
        action: 'prepared_diff_request_revision',
        preparedDiff: { status: 'revision-requested' },
      },
    });
    expect(blockedAbandon).toMatchObject({
      ok: false,
      requires: ['confirm'],
    });
    await expect(
      runAutopilotRecoveryAction(
        {
          preparedDiffId: 'pd-recovery',
          recoveryAction: 'cleanup-worktree',
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['confirm'],
    });
    expect(abandoned).toMatchObject({
      ok: true,
      result: {
        action: 'prepared_diff_abandon',
        preparedDiff: { status: 'abandoned' },
      },
    });
  });

  it('rebases a prepared diff against current PR head and preserves prepared-diff lifecycle', async () => {
    const { paths, repo } = await gitFixture();
    const created = await createWorktree(
      { repoId: 'sample', prNumber: 7, headRef: 'feature' },
      paths,
    );
    expect(created).toMatchObject({ ok: true });
    const worktree = (
      created as {
        worktree: {
          id: string;
          repoId: string;
          repoFullName: string;
          prNumber: number;
          localPath: string;
          baseRef: string;
          headRef: string;
          headSha: string;
          lifecycleStatus: string;
        };
      }
    ).worktree;
    await writeFile(
      join(worktree.localPath, 'src/app.ts'),
      'export const value = 20;\n',
    );
    await git(worktree.localPath, ['add', '-A']);
    await git(worktree.localPath, ['commit', '-m', 'local fix']);
    markLifecycle(paths.neondeckDatabase, worktree.id, 'prepared-diff');
    const preparedDiff = await ensurePreparedDiffForWorktree(
      { ...worktree, lifecycleStatus: 'prepared-diff' },
      paths,
    );
    await git(repo, ['checkout', 'feature']);
    await writeFile(join(repo, 'src/other.ts'), 'export const other = 1;\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'new feature commit']);
    const currentHead = await gitOutput(repo, ['rev-parse', 'HEAD']);

    const result = await runAutopilotRecoveryAction(
      {
        preparedDiffId: preparedDiff.id,
        recoveryAction: 'retry-after-new-commit',
      },
      paths,
      {
        token: 'token',
        fetchPullRequestEventState: async () =>
          ({
            headSha: currentHead,
            headRef: 'feature',
          }) as never,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      result: {
        preparedDiff: {
          id: preparedDiff.id,
          status: 'prepared',
          verificationStatus: 'not-run',
        },
        currentPrHead: {
          headSha: currentHead,
          source: 'github-pr-event-state',
        },
      },
    });
    expect(readWorktreeRecord(worktree.id, paths)).toMatchObject({
      lifecycleStatus: 'prepared-diff',
    });
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-recovery-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

async function gitFixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-recovery-'));
  const repo = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-repo-'));
  tempRoots.push(home, repo);
  const paths = runtimePaths(home);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'main']);
  await git(repo, ['checkout', '-b', 'feature']);
  await writeFile(join(repo, 'src/app.ts'), 'export const value = 2;\n');
  await git(repo, ['commit', '-am', 'feature']);
  await git(repo, ['checkout', 'main']);
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
  await ensureRuntimeHome(paths);
  return { paths, repo };
}

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, { cwd });
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function markLifecycle(
  databasePath: string,
  worktreeId: string,
  status: string,
) {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
        UPDATE worktrees
        SET lifecycle_status = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(status, new Date().toISOString(), worktreeId);
  } finally {
    database.close();
  }
}

function insertPreparedDiff(
  databasePath: string,
  input: {
    id: string;
    status: string;
    pushApprovalStatus?: string;
    verificationStatus?: string;
  },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare(
        `
        INSERT INTO prepared_diffs (
          id, worktree_id, repo_id, repo_full_name, pr_number, title,
          source_worktree_path, base_ref, head_ref, head_sha, status,
          push_approval_status, verification_status, summary_json, created_by,
          created_at, updated_at, abandoned_at
        )
        VALUES (?, ?, 'sample', 'example/sample', 7, 'Prepared diff',
          '/tmp/neondeck-wt', 'main', 'feature', 'head-sha', ?,
          ?, ?, NULL, 'test', ?, ?, NULL);
      `,
      )
      .run(
        input.id,
        `wt-${input.id}`,
        input.status,
        input.pushApprovalStatus ?? 'pending',
        input.verificationStatus ?? 'not-run',
        now,
        now,
      );
  } finally {
    database.close();
  }
}
