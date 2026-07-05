import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { readAutopilotState } from './modules/autopilot/state';
import { addNotification } from './modules/app-state';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('autopilot operator state', () => {
  it('normalizes global, repo, and watch policy modes for dashboard display', async () => {
    const paths = await fixture();
    await writeFile(
      paths.config,
      `${JSON.stringify(
        {
          version: 1,
          autopilot: {
            defaultMode: 'draft-fix',
            limits: { maxFilesChanged: 3 },
            concurrency: { maxAutonomousJobs: 2 },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      paths.repos,
      `${JSON.stringify(
        {
          repos: [
            {
              id: 'neondeck',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: '/tmp/neondeck',
              defaultBranch: 'main',
              metadata: {
                autopilot: {
                  mode: 'auto-fix-no-push',
                  reason: 'Repo is safe for prepared local fixes.',
                  limits: { requiredChecks: ['npm run check'] },
                  concurrency: { maxPerRepoAutonomousJobs: 1 },
                  watchOverrides: [
                    {
                      prNumber: 42,
                      mode: 'notify-only',
                      reason: 'High-risk PR stays notification-only.',
                    },
                  ],
                },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    insertWatch(paths, {
      id: 'pandemicsyn/neondeck#42',
      prNumber: 42,
      status: 'watching',
      title: 'Autopilot policy surface',
    });

    const state = await readAutopilotState(paths);

    expect(state.policies.global).toMatchObject({
      mode: 'prepare-only',
      limits: { maxFilesChanged: 3 },
      concurrency: expect.objectContaining({ maxAutonomousJobs: 2 }),
    });
    expect(state.policies.repos).toEqual([
      expect.objectContaining({
        repoId: 'neondeck',
        mode: 'autofix-with-approval',
        source: 'repo-metadata',
        limits: expect.objectContaining({
          requiredChecks: ['npm run check'],
        }),
        concurrency: expect.objectContaining({
          maxPerRepoAutonomousJobs: 1,
        }),
      }),
    ]);
    expect(state.policies.watches).toEqual([
      expect.objectContaining({
        watchId: 'pandemicsyn/neondeck#42',
        mode: 'notify-only',
        source: 'watch-override',
      }),
    ]);
    expect(state.queue).toEqual([
      expect.objectContaining({
        source: 'watch',
        mode: 'notify-only',
        status: 'watching',
      }),
    ]);
    expect(state.summary.placeholderAdapters.length).toBeGreaterThan(0);
  });

  it('adapts watches, prepared worktrees, approvals, checks, and events into one read model', async () => {
    const paths = await fixture();
    await writeRepoRegistry(paths);
    insertWatch(paths, {
      id: 'pandemicsyn/neondeck#43',
      prNumber: 43,
      status: 'attention-needed',
      title: 'Failing check',
    });
    insertWorktree(paths, {
      id: 'wt-43',
      prNumber: 43,
      lifecycleStatus: 'prepared-diff',
      localPath: join(paths.worktrees, 'pandemicsyn-neondeck-pr-43'),
      workflowRunId: 'run-verify',
    });
    insertPreparedDiff(paths, {
      id: 'pd-43',
      worktreeId: 'wt-43',
      prNumber: 43,
      localPath: join(paths.worktrees, 'pandemicsyn-neondeck-pr-43'),
    });
    insertExecutionApproval(paths, {
      id: 'approval-1',
      command: 'git push origin HEAD:feature',
      cwd: join(paths.worktrees, 'pandemicsyn-neondeck-pr-43'),
    });
    insertWorkflowRun(paths, {
      runId: 'run-verify',
      workflow: 'verify-pr-worktree',
      message: 'Running npm run check.',
    });
    insertWorkflowRun(paths, {
      runId: 'run-verify-failed',
      workflow: 'verify-pr-worktree',
      message: 'npm run check failed.',
      status: 'failed',
      isError: true,
    });
    insertWorktreeEvent(paths, {
      id: 'event-1',
      worktreeId: 'wt-43',
      message: 'Prepared diff retained for review.',
    });
    await addNotification(
      {
        level: 'attention',
        title: 'Autopilot needs review',
        message: 'A prepared diff needs attention.',
        source: 'autopilot',
        sourceId: 'test-attention',
      },
      paths,
    );
    await addNotification(
      {
        level: 'attention',
        title: 'Kilo task needs review',
        message: 'A delegated task needs attention.',
        source: 'kilo',
        sourceId: 'test-kilo-attention',
      },
      paths,
    );

    const state = await readAutopilotState(paths);

    expect(state.summary).toMatchObject({
      activeWatches: 1,
      preparedDiffs: 1,
      pendingApprovals: 1,
      runningChecks: 1,
      unreadNotifications: 1,
      failedChecks: 1,
    });
    expect(state.preparedDiffs[0]).toMatchObject({
      worktreeId: 'wt-43',
      sourceOfTruth: 'worktree',
    });
    expect(state.pendingApprovals[0]).toMatchObject({
      id: 'approval-1',
      repoFullName: 'pandemicsyn/neondeck',
      prNumber: 43,
    });
    expect(state.runningChecks[0]).toMatchObject({
      runId: 'run-verify',
      workflow: 'verify-pr-worktree',
    });
    expect(state.recentActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'worktree',
          message: 'Prepared diff retained for review.',
        }),
      ]),
    );
    expect(state.queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'approval',
          status: 'waiting-approval',
        }),
        expect.objectContaining({ source: 'workflow', status: 'running' }),
        expect.objectContaining({ source: 'watch', status: 'prepared' }),
      ]),
    );
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-autopilot-'));
  tempRoots.push(home);
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  return paths;
}

async function writeRepoRegistry(paths: RuntimePaths) {
  await writeFile(
    paths.repos,
    `${JSON.stringify(
      {
        repos: [
          {
            id: 'neondeck',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: '/tmp/neondeck',
            defaultBranch: 'main',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function insertWatch(
  paths: RuntimePaths,
  input: {
    id: string;
    prNumber: number;
    status: string;
    title: string;
  },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO pr_watches (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          pr_number,
          desired_terminal_state,
          status,
          pr_state,
          title,
          url,
          merge_commit_sha,
          last_snapshot_json,
          last_outcome,
          last_checked_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.id,
        'neondeck',
        'pandemicsyn/neondeck',
        'pandemicsyn',
        'neondeck',
        input.prNumber,
        'checks',
        input.status,
        'open',
        input.title,
        `https://github.com/pandemicsyn/neondeck/pull/${input.prNumber}`,
        null,
        null,
        'created',
        now,
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function insertWorktree(
  paths: RuntimePaths,
  input: {
    id: string;
    prNumber: number;
    lifecycleStatus: string;
    localPath: string;
    workflowRunId: string;
  },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO worktrees (
          id,
          repo_id,
          repo_full_name,
          github_owner,
          github_name,
          pr_number,
          base_ref,
          head_owner,
          head_name,
          head_ref,
          head_sha,
          local_path,
          storage_kind,
          owning_workflow_run_id,
          lifecycle_status,
          last_synced_sha,
          last_pushed_sha,
          cleanup_policy_json,
          direct_push_allowed,
          adopted,
          created_by,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.id,
        'neondeck',
        'pandemicsyn/neondeck',
        'pandemicsyn',
        'neondeck',
        input.prNumber,
        'main',
        'pandemicsyn',
        'neondeck',
        'feature',
        'abc123',
        input.localPath,
        'home',
        input.workflowRunId,
        input.lifecycleStatus,
        'abc123',
        null,
        JSON.stringify({
          retainFailed: true,
          retainPreparedDiff: true,
          successfulGraceHours: 24,
          staleAgeHours: 168,
        }),
        1,
        0,
        'neondeck',
        now,
        now,
      );
  } finally {
    database.close();
  }
}

function insertPreparedDiff(
  paths: RuntimePaths,
  input: {
    id: string;
    worktreeId: string;
    prNumber: number;
    localPath: string;
  },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO prepared_diffs (
          id,
          worktree_id,
          repo_id,
          repo_full_name,
          pr_number,
          title,
          source_worktree_path,
          base_ref,
          head_ref,
          head_sha,
          status,
          push_approval_status,
          verification_status,
          summary_json,
          created_by,
          created_at,
          updated_at,
          abandoned_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.id,
        input.worktreeId,
        'neondeck',
        'pandemicsyn/neondeck',
        input.prNumber,
        `pandemicsyn/neondeck#${input.prNumber}`,
        input.localPath,
        'main',
        'feature',
        'abc123',
        'prepared',
        'pending',
        'not-run',
        null,
        'test',
        now,
        now,
        null,
      );
  } finally {
    database.close();
  }
}

function insertExecutionApproval(
  paths: RuntimePaths,
  input: { id: string; command: string; cwd: string },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO execution_approvals (
          id,
          command,
          backend,
          cwd,
          context,
          risk,
          policy_decision,
          status,
          approval_decision,
          approver_surface,
          session_id,
          request_context_json,
          result_json,
          exit_code,
          stdout_preview,
          stderr_preview,
          error,
          created_at,
          resolved_at,
          executed_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.id,
        input.command,
        'local',
        input.cwd,
        'interactive',
        'safe-mutation',
        'ask',
        'pending',
        null,
        null,
        null,
        JSON.stringify({ source: 'autopilot' }),
        null,
        null,
        null,
        null,
        null,
        now,
        null,
        null,
        now,
      );
  } finally {
    database.close();
  }
}

function insertWorkflowRun(
  paths: RuntimePaths,
  input: {
    runId: string;
    workflow: string;
    message: string;
    status?: string;
    isError?: boolean;
  },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO workflow_run_observations (
          run_id,
          workflow,
          status,
          started_at,
          ended_at,
          last_event_at,
          last_message,
          event_count,
          duration_ms,
          is_error,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.runId,
        input.workflow,
        input.status ?? 'active',
        now,
        input.status && input.status !== 'active' ? now : null,
        now,
        input.message,
        1,
        null,
        input.isError ? 1 : 0,
        now,
      );
  } finally {
    database.close();
  }
}

function insertWorktreeEvent(
  paths: RuntimePaths,
  input: { id: string; worktreeId: string; message: string },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO worktree_events (
          id,
          worktree_id,
          repo_id,
          event_type,
          status,
          message,
          data_json,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.id,
        input.worktreeId,
        'neondeck',
        'prepared_diff',
        'prepared-diff',
        input.message,
        null,
        now,
      );
  } finally {
    database.close();
  }
}
