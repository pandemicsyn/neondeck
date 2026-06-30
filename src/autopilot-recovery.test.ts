import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { notifyAutopilotState } from './autopilot-notifications';
import {
  readAutopilotRecoveryOptions,
  runAutopilotRecoveryAction,
} from './autopilot-recovery';
import { listNotifications } from './app-state';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

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
        expect.objectContaining({ id: 'retry-verify' }),
        expect.objectContaining({ id: 'retry-push' }),
        expect.objectContaining({ id: 'retry-comment' }),
        expect.objectContaining({ id: 'request-revision' }),
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
    expect(abandoned).toMatchObject({
      ok: true,
      result: {
        action: 'prepared_diff_abandon',
        preparedDiff: { status: 'abandoned' },
      },
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
