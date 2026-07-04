import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { listExecutionApprovals } from './modules/execution';
import { syncExeDevCheckout } from './modules/execution';
import { ensureRuntimeHome, runtimePaths } from './runtime-home';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('exe.dev checkout sync', () => {
  it('routes remote checkout commands through execution approval records', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    const repoPath = join(paths.home, 'repo');
    await mkdir(repoPath, { recursive: true });
    await writeFile(
      paths.repos,
      JSON.stringify(
        {
          repos: [
            {
              id: 'app',
              github: { owner: 'pandemicsyn', name: 'neondeck' },
              path: repoPath,
              defaultBranch: 'main',
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFile(
      paths.config,
      JSON.stringify(
        {
          version: 1,
          execution: {
            enabledBackends: ['local', 'exe.dev'],
            exeDev: {
              lifecycle: 'existing-vm',
              remoteRoot: '/home/user/sandboxes',
            },
          },
        },
        null,
        2,
      ),
    );

    const result = await syncExeDevCheckout({ repoId: 'app' }, paths);

    expect(result).toMatchObject({
      ok: false,
      action: 'exedev_checkout_sync',
      blockedStep: 'mkdir-parent',
      requires: ['approval'],
      checkout: {
        repoId: 'app',
        repoFullName: 'pandemicsyn/neondeck',
        remotePath: '/home/user/sandboxes/pandemicsyn-neondeck-repo',
      },
    });
    const approvals = await listExecutionApprovals(paths, {
      includeResolved: true,
    });
    expect(approvals.approvals).toEqual([
      expect.objectContaining({
        backend: 'exe.dev',
        command: "mkdir -p '/home/user/sandboxes'",
        status: 'pending',
        requestContext: expect.objectContaining({
          action: 'exedev_checkout_sync',
          step: 'mkdir-parent',
          repoId: 'app',
        }),
      }),
    ]);
  });

  it('rejects unsafe checkout refs at the action boundary', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);

    await expect(
      syncExeDevCheckout({ repoId: 'app', ref: '--detach' }, paths),
    ).resolves.toMatchObject({
      ok: false,
      action: 'exedev_checkout_sync',
      requires: ['repoId'],
      message: expect.stringContaining('Expected a safe git ref or SHA'),
    });
  });

  it('does not treat an approval-blocked probe as a missing checkout', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeRepo(paths);
    const calls: Array<Record<string, unknown>> = [];

    const result = await syncExeDevCheckout({ repoId: 'app' }, paths, {
      async runExecution(input: unknown) {
        calls.push(input as Record<string, unknown>);
        if (calls.length === 1) {
          return {
            ok: true,
            action: 'execution_run',
            changed: true,
            message: 'mkdir ok',
            approval: { id: 'approval-mkdir', status: 'executed' },
            result: { exitCode: 0, stdout: '', stderr: '' },
          };
        }
        return {
          ok: false,
          action: 'execution_run',
          changed: true,
          message: 'Execution requires user approval before running.',
          requires: ['approval'],
          approval: { id: 'approval-probe', status: 'pending' },
        };
      },
    });

    expect(result).toMatchObject({
      ok: false,
      blockedStep: 'probe',
      requires: ['approval'],
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.command)).toEqual([
      "mkdir -p '/home/user/neondeck/checkouts'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-repo' rev-parse --is-inside-work-tree",
    ]);
  });

  it('passes per-step approval ids when retrying a blocked sync step', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeRepo(paths);
    const calls: Array<Record<string, unknown>> = [];

    await syncExeDevCheckout(
      {
        repoId: 'app',
        approvals: { 'mkdir-parent': 'approval-once' },
      },
      paths,
      {
        async runExecution(input: unknown) {
          calls.push(input as Record<string, unknown>);
          return {
            ok: false,
            action: 'execution_run',
            changed: true,
            message:
              'exe.dev VM host environment variable EXE_VM_HOST is not set.',
            requires: ['EXE_VM_HOST'],
            approval: { id: 'approval-once', status: 'failed' },
            result: { exitCode: null, stdout: '', stderr: '' },
          };
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "mkdir -p '/home/user/neondeck/checkouts'",
      approvalId: 'approval-once',
    });
  });

  it('checks out the fetched remote branch for repo branch refs', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeRepo(paths);
    const calls: Array<Record<string, unknown>> = [];

    const result = await syncExeDevCheckout({ repoId: 'app' }, paths, {
      async runExecution(input: unknown) {
        calls.push(input as Record<string, unknown>);
        return executedOk(
          calls.length === 5 ? 'remote-head-sha\n' : '',
          calls.length === 2,
        );
      },
    });

    expect(result).toMatchObject({
      ok: true,
      checkout: {
        ref: 'origin/main',
        headSha: 'remote-head-sha',
      },
    });
    expect(calls.map((call) => call.command)).toEqual([
      "mkdir -p '/home/user/neondeck/checkouts'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-repo' rev-parse --is-inside-work-tree",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-repo' fetch --all --prune",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-repo' checkout --detach 'origin/main'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-repo' rev-parse HEAD",
    ]);
  });

  it('checks out FETCH_HEAD for fetched fork worktree branch refs', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeRepo(paths);
    insertWorktree(paths, {
      id: 'wt_fork',
      localPath: join(paths.home, 'worktree'),
      headOwner: 'contributor',
      headName: 'neondeck-fork',
      headRef: 'feature',
      headSha: null,
      lifecycleStatus: 'ready',
    });
    const calls: Array<Record<string, unknown>> = [];

    const result = await syncExeDevCheckout({ worktreeId: 'wt_fork' }, paths, {
      async runExecution(input: unknown) {
        calls.push(input as Record<string, unknown>);
        return executedOk(
          calls.length === 6 ? 'fork-head-sha\n' : '',
          calls.length === 2,
        );
      },
    });

    expect(result).toMatchObject({
      ok: true,
      checkout: {
        ref: 'FETCH_HEAD',
        headSha: 'fork-head-sha',
      },
    });
    expect(calls.map((call) => call.command)).toEqual([
      "mkdir -p '/home/user/neondeck/checkouts'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' rev-parse --is-inside-work-tree",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' fetch --all --prune",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' fetch 'https://github.com/contributor/neondeck-fork.git' 'feature'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' checkout --detach 'FETCH_HEAD'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' rev-parse HEAD",
    ]);
  });

  it('detects unreachable local worktree head SHAs before checkout', async () => {
    const paths = runtimePaths(await tempDir());
    await ensureRuntimeHome(paths);
    await writeRepo(paths);
    insertWorktree(paths, {
      id: 'wt_local',
      localPath: join(paths.home, 'worktree'),
      headOwner: 'pandemicsyn',
      headName: 'neondeck',
      headRef: 'feature',
      headSha: 'abc123',
      lifecycleStatus: 'prepared-diff',
    });
    const calls: Array<Record<string, unknown>> = [];

    const result = await syncExeDevCheckout({ worktreeId: 'wt_local' }, paths, {
      async runExecution(input: unknown) {
        calls.push(input as Record<string, unknown>);
        if (calls.length === 4) {
          return {
            ok: false,
            action: 'execution_run',
            changed: true,
            message: 'ref missing',
            approval: { id: `approval-${calls.length}`, status: 'failed' },
            result: { exitCode: 1, stdout: '', stderr: 'missing' },
          };
        }
        return executedOk('', calls.length === 2);
      },
    });

    expect(result).toMatchObject({
      ok: false,
      blockedStep: 'verify-ref',
      requires: ['reachable-ref'],
      message: expect.stringContaining(
        'head SHA "abc123" is not reachable on the exe.dev checkout',
      ),
    });
    expect(calls.map((call) => call.command)).toEqual([
      "mkdir -p '/home/user/neondeck/checkouts'",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' rev-parse --is-inside-work-tree",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' fetch --all --prune",
      "git -C '/home/user/neondeck/checkouts/pandemicsyn-neondeck-pr-7' cat-file -e 'abc123^{commit}'",
    ]);
  });
});

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-exedev-sync-'));
  tempRoots.push(path);
  return path;
}

async function writeRepo(paths: ReturnType<typeof runtimePaths>) {
  const repoPath = join(paths.home, 'repo');
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    paths.repos,
    JSON.stringify(
      {
        repos: [
          {
            id: 'app',
            github: { owner: 'pandemicsyn', name: 'neondeck' },
            path: repoPath,
            defaultBranch: 'main',
          },
        ],
      },
      null,
      2,
    ),
  );
}

function executedOk(stdout = '', exists = false) {
  return {
    ok: true,
    action: 'execution_run',
    changed: true,
    message: 'ok',
    approval: { id: 'approval-ok', status: 'executed' },
    result: {
      exitCode: 0,
      stdout: exists ? 'true\n' : stdout,
      stderr: '',
    },
  };
}

function insertWorktree(
  paths: ReturnType<typeof runtimePaths>,
  input: {
    id: string;
    localPath: string;
    headOwner: string;
    headName: string;
    headRef: string;
    headSha: string | null;
    lifecycleStatus: string;
  },
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO worktrees (
          id, repo_id, repo_full_name, github_owner, github_name, pr_number,
          base_ref, head_owner, head_name, head_ref, head_sha, local_path,
          storage_kind, owning_workflow_run_id, lifecycle_status,
          last_synced_sha, last_pushed_sha, cleanup_policy_json,
          direct_push_allowed, adopted, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        input.id,
        'app',
        'pandemicsyn/neondeck',
        'pandemicsyn',
        'neondeck',
        7,
        'main',
        input.headOwner,
        input.headName,
        input.headRef,
        input.headSha,
        input.localPath,
        'home',
        null,
        input.lifecycleStatus,
        input.headSha,
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
