import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { approvePreparedDiffPush } from './prepared-diffs';
import {
  readKiloTaskEvents,
  readKiloTaskStatus,
  type KiloTaskStatus,
} from './kilo-actions';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { createWorktree } from './worktrees';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const originalEnv = { ...process.env };

vi.setConfig({ testTimeout: 180_000 });
vi.mock('./skills/github-gh/SKILL.md', async () => {
  const { defineSkill } = await import('@flue/runtime');
  return {
    default: defineSkill({
      name: 'github-gh',
      description: 'GitHub fixture skill for Kilo workflow smoke tests.',
    }),
  };
});
vi.mock('./skills/neondeck/SKILL.md', async () => {
  const { defineSkill } = await import('@flue/runtime');
  return {
    default: defineSkill({
      name: 'neondeck',
      description: 'Neondeck fixture skill for Kilo workflow smoke tests.',
    }),
  };
});

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Kilo Flue workflow smoke', () => {
  it('runs Kilo handoff, reconciliation, summary, review, verify, and promote workflows', async () => {
    const workflows = await loadWorkflows();
    const { paths, worktreeId, worktreePath } = await fixture();

    const handoff = await runWorkflow(workflows.handoffToKilo, {
      worktreeId,
      title: 'Kilo smoke handoff',
      prompt: 'Update the sample README.',
      mode: 'draft-fix',
      explicitUserRequest: true,
    });
    expect(handoff).toMatchObject({
      ok: true,
      changed: true,
      action: 'kilo_task_start',
      task: {
        worktreeId,
        cwd: worktreePath,
        autoEnabled: false,
      },
    });

    const taskId = stringPath(handoff, ['taskId']);
    await waitForTask(taskId, 'succeeded', paths);
    await waitForEvent(taskId, 'process.exit', paths);
    await expect(readKiloTaskStatus({ taskId }, paths)).resolves.toMatchObject({
      ok: true,
      task: {
        rootSessionId: 'ses_smoke_root',
        childSessionIds: ['ses_smoke_child'],
        status: 'succeeded',
      },
    });

    const summary = await runWorkflow(workflows.summarizeKiloSession, {
      taskId,
    });
    expect(summary).toMatchObject({
      ok: true,
      changed: true,
      action: 'summarize_kilo_session',
      taskId,
      summary: expect.stringContaining('Kilo smoke handoff'),
    });

    const review = await runWorkflow(workflows.reviewKiloResult, { taskId });
    expect(review).toMatchObject({
      ok: true,
      changed: true,
      action: 'kilo_result_review',
      resultState: {
        classification: 'ready-to-verify',
        verificationStatus: 'not-run',
      },
      diff: {
        ok: true,
        fileCount: 1,
      },
    });
    const preparedDiffId = stringPath(review, [
      'resultState',
      'preparedDiffId',
    ]);

    const verification = await runWorkflow(workflows.verifyKiloResult, {
      taskId,
      checks: ['node --version'],
      context: 'unattended',
      lock: false,
    });
    expect(verification).toMatchObject({
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
          approverSurface: 'smoke',
          reason: 'Kilo workflow smoke approval.',
        },
        paths,
      ),
    ).resolves.toMatchObject({ ok: true });

    const promotion = await runWorkflow(workflows.promoteKiloResult, {
      taskId,
    });
    expect(promotion).toMatchObject({
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

    const staleWorktree = await createWorktree(
      { repoId: 'sample', headRef: 'main' },
      paths,
    );
    const stale = worktreeFrom(staleWorktree);
    await writeFile(join(stale.localPath, 'README.md'), '# sample\n\nstale\n');
    insertDetachedRunningTask(paths, {
      taskId: 'kilo-stale-smoke',
      worktreeId: stale.id,
      cwd: stale.localPath,
    });
    insertDetachedRunningTask(paths, {
      taskId: 'kilo-unrelated-smoke',
      worktreeId: stale.id,
      cwd: stale.localPath,
    });

    const reconciled = await runWorkflow(workflows.reconcileKiloTask, {
      taskId: 'kilo-stale-smoke',
    });
    expect(reconciled).toMatchObject({
      ok: true,
      changed: true,
      action: 'kilo_task_reconcile',
      task: {
        id: 'kilo-stale-smoke',
        status: 'needs-review',
      },
    });
    await expect(
      readKiloTaskStatus({ taskId: 'kilo-unrelated-smoke' }, paths),
    ).resolves.toMatchObject({
      ok: true,
      task: {
        id: 'kilo-unrelated-smoke',
        status: 'running',
      },
    });
  });
});

async function fixture() {
  const home = await tempDir('neondeck-kilo-smoke-home-');
  const paths = runtimePaths(home);
  process.env.NEONDECK_HOME = home;
  await ensureRuntimeHome(paths);

  const repo = await tempDir('neondeck-kilo-smoke-repo-');
  await setupGitRepo(repo);
  const kilo = join(home, 'fake-kilo.mjs');
  await writeFile(kilo, completedKiloScript());
  await chmod(kilo, 0o755);
  await writeFile(
    paths.config,
    `${JSON.stringify(
      {
        version: 1,
        kilo: {
          cliPath: kilo,
          concurrency: 2,
          rawLogRetentionDays: 7,
        },
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
    )}\n`,
  );
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
  const created = await createWorktree(
    { repoId: 'sample', headRef: 'main', directPushAllowed: true },
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
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'README.md'), '# sample\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
  await execFileAsync('git', ['config', 'user.email', 'neon@example.test'], {
    cwd: repo,
  });
  await execFileAsync('git', ['config', 'user.name', 'Neon Test'], {
    cwd: repo,
  });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: repo,
  });
  await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
}

function completedKiloScript() {
  return `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'session') {
  console.log(JSON.stringify([
    {
      id: 'ses_smoke_root',
      title: 'Kilo smoke handoff',
      updated: 1710000000000,
      created: 1709999999000,
      projectId: 'project_smoke',
      directory: '/tmp/neondeck-kilo-smoke',
      project: {
        id: 'project_smoke',
        name: 'neondeck-kilo-smoke',
        worktree: '/tmp/neondeck-kilo-smoke'
      }
    }
  ]));
  process.exit(0);
}

const dir = args[args.indexOf('--dir') + 1];
writeFileSync(join(dir, 'README.md'), '# sample\\n\\nchanged by fake kilo\\n');
console.log(JSON.stringify({
  type: 'text',
  timestamp: Date.now(),
  sessionID: 'ses_smoke_root',
  part: {
    type: 'text',
    text: 'Kilo smoke changed the README.',
    time: { end: Date.now() }
  }
}));
console.log(JSON.stringify({
  type: 'tool_use',
  timestamp: Date.now(),
  sessionID: 'ses_smoke_root',
  part: {
    type: 'tool',
    tool: 'task',
    state: { status: 'completed' },
    metadata: { sessionId: 'ses_smoke_child' }
  }
}));
`;
}

async function waitForTask(
  taskId: string,
  status: KiloTaskStatus,
  paths: RuntimePaths,
) {
  for (let index = 0; index < 50; index++) {
    const result = await readKiloTaskStatus({ taskId }, paths);
    const task = 'task' in result ? result.task : undefined;
    if (task?.status === status) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for task ${taskId} to become ${status}.`);
}

async function waitForEvent(
  taskId: string,
  eventType: string,
  paths: RuntimePaths,
) {
  for (let index = 0; index < 50; index++) {
    const result = await readKiloTaskEvents({ taskId }, paths);
    const events = 'events' in result ? result.events : [];
    if (
      Array.isArray(events) &&
      events.some((event) => event.eventType === eventType)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for task ${taskId} event ${eventType}.`);
}

function insertDetachedRunningTask(
  paths: RuntimePaths,
  input: { taskId: string; worktreeId: string; cwd: string },
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
        'Detached Kilo smoke task',
        'Recover after restart.',
        'sample',
        'pandemicsyn/sample',
        input.worktreeId,
        null,
        input.cwd,
        'draft-fix',
        'running',
        1,
        0,
        'kilo',
        JSON.stringify(['run', 'Recover after restart.']),
        999_999,
        now,
        'ses_stale_root',
        JSON.stringify([]),
        null,
        null,
        null,
        null,
        now,
        now,
        null,
      );
  } finally {
    database.close();
  }
}

async function runWorkflow(workflow: unknown, input: unknown) {
  const runnable = workflow as {
    action?: { run(context: { input: unknown }): unknown };
    run?: (context: { input: unknown }) => unknown;
  };
  if (runnable.action) return Promise.resolve(runnable.action.run({ input }));
  if (runnable.run) return Promise.resolve(runnable.run({ input }));
  throw new Error('Expected runnable workflow.');
}

async function loadWorkflows() {
  const [
    handoffToKilo,
    promoteKiloResult,
    reconcileKiloTask,
    reviewKiloResult,
    summarizeKiloSession,
    verifyKiloResult,
  ] = await Promise.all([
    import('./workflows/handoff_to_kilo'),
    import('./workflows/promote_kilo_result'),
    import('./workflows/reconcile_kilo_task'),
    import('./workflows/review_kilo_result'),
    import('./workflows/summarize_kilo_session'),
    import('./workflows/verify_kilo_result'),
  ]);
  return {
    handoffToKilo: handoffToKilo.default,
    promoteKiloResult: promoteKiloResult.default,
    reconcileKiloTask: reconcileKiloTask.default,
    reviewKiloResult: reviewKiloResult.default,
    summarizeKiloSession: summarizeKiloSession.default,
    verifyKiloResult: verifyKiloResult.default,
  };
}

async function tempDir(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
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

function stringPath(value: unknown, path: string[]) {
  let current = value;
  for (const key of path) {
    current =
      current && typeof current === 'object'
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }
  if (typeof current !== 'string') {
    throw new Error(`Expected string at ${path.join('.')}.`);
  }
  return current;
}
