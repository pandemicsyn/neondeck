import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'neondeck-kilo-flue-run-'));
const repo = await mkdtemp(join(tmpdir(), 'neondeck-kilo-flue-repo-'));

try {
  await setupRepo(repo);
  const kilo = join(home, 'fake-kilo.mjs');
  await writeFile(kilo, fakeKiloScript());
  await chmod(kilo, 0o755);
  await mkdir(join(home, 'data'), { recursive: true });
  await writeFile(
    join(home, 'config.json'),
    `${JSON.stringify(
      {
        version: 1,
        kilo: {
          cliPath: kilo,
          concurrency: 1,
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
    join(home, 'repos.json'),
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
  const env = { ...process.env, NEONDECK_HOME: home };
  await bootstrapRuntime(env);
  const worktree = await createManagedWorktree(repo, home);

  const input = {
    worktreeId: worktree.id,
    title: 'Kilo CLI smoke handoff',
    prompt: 'Run a fake delegated Kilo task.',
    mode: 'patch-proposal',
    explicitUserRequest: true,
  };
  const result = await runWorkflow('handoff_to_kilo', input, env);
  assert(
    result?.action === 'kilo_task_start',
    'flue run did not return the Kilo handoff workflow result',
  );
  assert(result?.ok === true, 'Kilo handoff flue run did not start');
  const taskId = result.taskId;
  assert(
    typeof taskId === 'string',
    'Kilo handoff result did not include taskId',
  );
  await waitForSmokeFile(worktree.localPath);
  completeTask(home, taskId);

  const summary = await runWorkflow('summarize_kilo_session', { taskId }, env);
  assert(
    summary?.action === 'summarize_kilo_session',
    'flue run did not return the Kilo summary workflow result',
  );

  const review = await runWorkflow('review_kilo_result', { taskId }, env);
  assert(
    review?.action === 'kilo_result_review',
    'flue run did not return the Kilo review workflow result',
  );
  assert(review?.ok === true, 'Kilo review workflow did not succeed');
  assert(
    review?.resultState?.classification === 'ready-to-verify',
    'Kilo review did not classify the managed worktree result as ready-to-verify',
  );
  const preparedDiffId = review?.resultState?.preparedDiffId;
  assert(
    typeof preparedDiffId === 'string',
    'Kilo review result did not include a prepared diff id',
  );

  const verification = await runWorkflow(
    'verify_kilo_result',
    {
      taskId,
      checks: ['node --version'],
      context: 'unattended',
      lock: false,
    },
    env,
  );
  assert(
    verification?.action === 'kilo_result_verify',
    'flue run did not return the Kilo verification workflow result',
  );
  assert(
    verification?.ok === true,
    'Kilo verification workflow did not succeed',
  );
  approvePreparedDiff(home, preparedDiffId);

  const promotion = await runWorkflow('promote_kilo_result', { taskId }, env);
  assert(
    promotion?.action === 'kilo_result_promote',
    'flue run did not return the Kilo promotion workflow result',
  );
  assert(promotion?.ok === true, 'Kilo promotion workflow did not succeed');
  assert(
    promotion?.data?.admitted === true,
    'Kilo promotion did not admit the verified result',
  );

  insertDetachedRunningTask(home, repo);
  const reconciliation = await runWorkflow(
    'reconcile_kilo_task',
    { taskId: 'kilo-cli-stale' },
    env,
  );
  assert(
    reconciliation?.action === 'kilo_task_reconcile',
    'flue run did not return the Kilo reconcile workflow result',
  );

  console.log('kilo smoke passed');
} finally {
  await Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(repo, { recursive: true, force: true }),
  ]);
}

async function runWorkflow(name, input, env) {
  const run = await execFileAsync(
    'npx',
    [
      'flue',
      'run',
      `workflow:${name}`,
      '--target',
      'node',
      '--server',
      '/api/flue',
      '--input',
      JSON.stringify(input),
    ],
    { cwd: root, env, maxBuffer: 1024 * 1024 },
  );
  return parseLastJson(run.stdout);
}

async function bootstrapRuntime(env) {
  await runWorkflow('summarize_kilo_session', { taskId: 'bootstrap' }, env);
}

async function createManagedWorktree(repo, home) {
  const id = `wt-${randomUUID()}`;
  const worktreeRoot = join(home, 'worktrees');
  const localPath = join(worktreeRoot, id);
  await mkdir(worktreeRoot, { recursive: true });
  await execFileAsync(
    'git',
    ['worktree', 'add', '--detach', localPath, 'main'],
    {
      cwd: repo,
    },
  );
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: localPath,
  });
  const headSha = stdout.trim();
  const now = new Date().toISOString();
  const database = new DatabaseSync(join(home, 'data', 'neondeck.db'));
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
        id,
        'sample',
        'pandemicsyn/sample',
        'pandemicsyn',
        'sample',
        null,
        'main',
        null,
        null,
        'main',
        headSha,
        localPath,
        'home',
        null,
        'ready',
        headSha,
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
  return { id, localPath };
}

async function setupRepo(path) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'README.md'), '# sample\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: path });
  await execFileAsync('git', ['config', 'user.email', 'neon@example.test'], {
    cwd: path,
  });
  await execFileAsync('git', ['config', 'user.name', 'Neon Test'], {
    cwd: path,
  });
  await execFileAsync('git', ['add', 'README.md'], { cwd: path });
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: path });
}

async function waitForSmokeFile(worktreePath) {
  const target = join(worktreePath, '.neondeck-smoke');
  for (let index = 0; index < 50; index++) {
    try {
      await stat(target);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Timed out waiting for fake Kilo to write worktree changes');
}

function completeTask(home, taskId) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(join(home, 'data', 'neondeck.db'));
  try {
    database
      .prepare(
        `
        UPDATE kilo_tasks
        SET status = 'succeeded',
            root_session_id = COALESCE(root_session_id, 'ses_cli_smoke'),
            updated_at = ?,
            completed_at = COALESCE(completed_at, ?),
            exit_code = COALESCE(exit_code, 0)
        WHERE id = ?;
      `,
      )
      .run(now, now, taskId);
  } finally {
    database.close();
  }
}

function approvePreparedDiff(home, preparedDiffId) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(join(home, 'data', 'neondeck.db'));
  try {
    database.exec('BEGIN;');
    database
      .prepare(
        `
        UPDATE prepared_diffs
        SET status = 'push-approved',
            push_approval_status = 'approved',
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, preparedDiffId);
    database
      .prepare(
        `
        UPDATE prepared_diff_approvals
        SET status = 'approved',
            reason = 'Kilo CLI smoke approval.',
            approver_surface = 'smoke:kilo',
            resolved_at = ?,
            updated_at = ?
        WHERE prepared_diff_id = ?
          AND approval_type = 'push';
      `,
      )
      .run(now, now, preparedDiffId);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

function insertDetachedRunningTask(home, repo) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(join(home, 'data', 'neondeck.db'));
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
        'kilo-cli-stale',
        'Stale CLI smoke task',
        'Recover a detached Kilo task.',
        'sample',
        'pandemicsyn/sample',
        null,
        null,
        repo,
        'patch-proposal',
        'running',
        1,
        0,
        'kilo',
        JSON.stringify(['run', 'Recover a detached Kilo task.']),
        999_999,
        now,
        'ses_cli_stale',
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

function fakeKiloScript() {
  return `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const dir = args[args.indexOf('--dir') + 1];
mkdirSync(dirnameFallback(join(dir, '.neondeck-smoke')), { recursive: true });
appendFileSync(join(dir, '.neondeck-smoke'), 'ok\\n');
console.log(JSON.stringify({
  type: 'text',
  timestamp: Date.now(),
  sessionID: 'ses_cli_smoke',
  part: {
    type: 'text',
    text: 'Fake Kilo CLI smoke completed.',
    time: { end: Date.now() }
  }
}));

function dirnameFallback(path) {
  return dirname(path);
}
`;
}

function parseLastJson(stdout) {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
