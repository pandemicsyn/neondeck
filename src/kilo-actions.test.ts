import { spawn } from 'node:child_process';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { listNotifications } from './modules/app-state';
import { runningProcesses } from './modules/kilo/process';
import {
  abortKiloTask,
  readKiloSessionMessages,
  readKiloTaskEvents,
  readKiloTaskSessions,
  readKiloTaskStatus,
  searchKiloSessions,
  startKiloTask,
} from './modules/kilo';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { createWorktree } from './modules/worktrees';
import {
  createSeededGitRepository,
  type SeededGitRepository,
} from './testing/git-repository-fixture';

const tempRoots: string[] = [];
let repositorySeed: SeededGitRepository | undefined;

vi.setConfig({ testTimeout: 180_000 });

beforeAll(async () => {
  repositorySeed = await createSeededGitRepository({
    initialCommitMessage: 'init',
    initialFiles: { 'README.md': '# sample\n' },
  });
});

afterAll(async () => {
  await repositorySeed?.dispose();
});

afterEach(async () => {
  await waitForTrackedKiloProcesses();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Kilo handoff runner', () => {
  it('starts a fake Kilo task and captures root and child session ids', async () => {
    const { paths, repo, kilo } = await fixture({
      script: completedKiloScript(),
    });

    const started = await startKiloTask(
      {
        repoId: 'sample',
        title: 'Implement sample change',
        prompt: 'Change the sample app.',
        explicitUserRequest: true,
      },
      paths,
    );
    const realRepo = await realpath(repo);
    expect(started).toMatchObject({
      ok: true,
      changed: true,
      pid: expect.any(Number),
      rawLogPath: expect.any(String),
      command: [
        kilo,
        'run',
        expect.stringContaining('User task:'),
        '--dir',
        realRepo,
        '--title',
        'Implement sample change',
        '--format',
        'json',
      ],
    });

    const taskId = taskIdFrom(started);
    await waitForTrackedKiloTask(taskId);
    await waitForTask(taskId, 'succeeded', paths);
    const status = await readKiloTaskStatus({ taskId }, paths);
    const sessions = await readKiloTaskSessions({ taskId }, paths);
    const events = await readKiloTaskEvents({ taskId }, paths);
    const notifications = await listNotifications(paths);

    expect(status).toMatchObject({
      ok: true,
      task: {
        rootSessionId: 'ses_root',
        childSessionIds: ['ses_child'],
        status: 'succeeded',
        notificationFacts: expect.arrayContaining([
          expect.objectContaining({ state: 'completed' }),
        ]),
        resultPlaceholders: [
          expect.objectContaining({
            type: 'review',
            workflow: 'review_kilo_result',
          }),
        ],
      },
    });
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'kilo',
          sourceId: `task:${taskId}:completed`,
          level: 'ready',
        }),
      ]),
    );
    expect(sessions).toMatchObject({
      ok: true,
      rootSessionId: 'ses_root',
      childSessionIds: ['ses_child'],
    });
    expect(events).toMatchObject({
      ok: true,
      events: expect.arrayContaining([
        expect.objectContaining({
          eventType: 'text',
          sessionId: 'ses_root',
          summary: 'Kilo finished the requested change.',
        }),
        expect.objectContaining({
          eventType: 'tool_use',
          sessionId: 'ses_root',
          childSessionId: 'ses_child',
        }),
      ]),
    });
  });

  it('holds concurrency for a reconciled task whose Kilo process still matches persisted context', async () => {
    const { paths, kilo } = await fixture({
      script: hangingKiloScript(),
      concurrency: 1,
    });
    const child = spawn(
      kilo,
      ['run', 'Old prompt', '--dir', paths.home, '--title', 'Stale task'],
      {
        cwd: paths.home,
        stdio: 'ignore',
      },
    );
    try {
      insertStaleRunningTask(paths, 'stale-task', {
        pid: child.pid,
        cliPath: kilo,
      });

      const started = await startKiloTask(
        {
          repoId: 'sample',
          title: 'Fresh task',
          prompt: 'Run after restart.',
          explicitUserRequest: true,
        },
        paths,
      );
      const stale = await readKiloTaskStatus({ taskId: 'stale-task' }, paths);

      expect(started).toMatchObject({
        ok: false,
        message: 'Kilo handoff concurrency limit reached (1).',
      });
      expect(stale).toMatchObject({
        ok: true,
        task: {
          status: 'needs-reconcile',
          completedAt: null,
          error: expect.stringContaining('cannot be safely reattached'),
        },
      });
    } finally {
      child.kill('SIGTERM');
    }
  });

  it('reconciles a dead persisted Kilo process and admits fresh work', async () => {
    const { paths } = await fixture({
      script: completedKiloScript(),
      concurrency: 1,
    });
    insertStaleRunningTask(paths, 'stale-task', { pid: 999_999 });

    const started = await startKiloTask(
      {
        repoId: 'sample',
        title: 'Fresh task',
        prompt: 'Run after restart.',
        explicitUserRequest: true,
      },
      paths,
    );
    const taskId = taskIdFrom(started);
    await waitForTrackedKiloTask(taskId);
    const stale = await readKiloTaskStatus({ taskId: 'stale-task' }, paths);

    expect(started).toMatchObject({ ok: true, taskId: expect.any(String) });
    expect(stale).toMatchObject({
      ok: true,
      task: {
        status: 'unknown',
        error: expect.stringContaining('outcome is unknown'),
      },
    });
  });

  it('returns bounded transcript pages and audits Kilo session reads', async () => {
    const { paths } = await fixture({
      script: completedKiloScript(),
    });
    const started = await startKiloTask(
      {
        repoId: 'sample',
        title: 'Transcript task',
        prompt: 'Capture transcript.',
        explicitUserRequest: true,
      },
      paths,
    );
    const taskId = taskIdFrom(started);
    await waitForTrackedKiloTask(taskId);
    await waitForTask(taskId, 'succeeded', paths);

    const messages = await readKiloSessionMessages(
      {
        sessionId: 'ses_root',
        limit: 1,
        includeFullTranscript: true,
        includeToolOutput: true,
        requesterSurface: 'test',
        readReason: 'transcript-test',
      },
      paths,
    );

    expect(messages).toMatchObject({
      ok: true,
      transcript: {
        unavailable: false,
        limit: 1,
        hasMore: true,
        fullTranscriptIncluded: true,
        messages: [expect.objectContaining({ sessionId: 'ses_root' })],
      },
    });

    const database = new DatabaseSync(paths.neondeckDatabase, {
      readOnly: true,
    });
    try {
      const row = database
        .prepare(
          `
          SELECT read_type, requester_surface, reason, limit_count,
                 include_full_transcript, include_tool_output
          FROM kilo_session_audit
          WHERE session_id = ?
          ORDER BY created_at DESC
          LIMIT 1;
        `,
        )
        .get('ses_root');
      expect(row).toEqual({
        read_type: 'messages',
        requester_surface: 'test',
        reason: 'transcript-test',
        limit_count: 1,
        include_full_transcript: 1,
        include_tool_output: 1,
      });
    } finally {
      database.close();
    }
  });

  it('requires managed worktrees for draft-fix mode and explicit confirmation for auto', async () => {
    const { paths } = await fixture({ script: completedKiloScript() });

    await expect(
      startKiloTask(
        {
          repoId: 'sample',
          title: 'Draft fix',
          prompt: 'Fix it.',
          mode: 'draft-fix',
          explicitUserRequest: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Draft-fix Kilo handoffs require a managed worktree.',
    });

    const created = await createWorktree(
      { repoId: 'sample', headRef: 'main' },
      paths,
    );
    const worktreeId = worktreeIdFrom(created);

    await expect(
      startKiloTask(
        {
          worktreeId,
          title: 'Auto draft fix',
          prompt: 'Fix it.',
          mode: 'draft-fix',
          allowAuto: true,
          explicitUserRequest: true,
        },
        paths,
      ),
    ).resolves.toMatchObject({
      ok: false,
      message: 'Kilo --auto requires confirmAuto=true.',
    });
  });

  it('cancels a running Kilo task and persists the cancelled state', async () => {
    const { paths } = await fixture({ script: hangingKiloScript() });
    const started = await startKiloTask(
      {
        repoId: 'sample',
        title: 'Long task',
        prompt: 'Keep running.',
        explicitUserRequest: true,
      },
      paths,
    );
    const taskId = taskIdFrom(started);
    await waitForRootSession(taskId, paths);

    const aborted = await abortKiloTask({ taskId }, paths);
    await waitForTrackedKiloTask(taskId);
    const status = await waitForTask(taskId, 'cancelled', paths);

    expect(aborted).toMatchObject({ ok: true, changed: true });
    expect(status).toMatchObject({
      ok: true,
      task: {
        status: 'cancelled',
        rootSessionId: 'ses_hanging',
      },
    });
  });

  it('marks a failed fake Kilo task failed with stderr context', async () => {
    const { paths } = await fixture({ script: failingKiloScript() });
    const started = await startKiloTask(
      {
        repoId: 'sample',
        title: 'Failing task',
        prompt: 'Fail for coverage.',
        explicitUserRequest: true,
      },
      paths,
    );
    const taskId = taskIdFrom(started);
    await waitForTrackedKiloTask(taskId);
    const status = await waitForTask(taskId, 'failed', paths);

    expect(status).toMatchObject({
      ok: true,
      task: {
        status: 'failed',
        exitCode: 2,
        error: expect.stringContaining('fake kilo failed'),
      },
    });
  });

  it('normalizes Kilo CLI session search results', async () => {
    const { paths } = await fixture({ script: completedKiloScript() });

    const result = await searchKiloSessions(
      { query: 'Sample', limit: 5 },
      paths,
    );

    expect(result).toMatchObject({
      ok: true,
      sessions: [
        {
          id: 'ses_search',
          title: 'Sample search result',
          directory: '/tmp/sample',
          role: 'cli',
        },
      ],
      adapters: { cli: 'ok' },
    });
  });
});

async function fixture(input: { script: string; concurrency?: number }) {
  const home = await tempDir();
  const paths = runtimePaths(home);
  await ensureRuntimeHome(paths);
  const repo = join(home, 'repo');
  if (!repositorySeed) {
    throw new Error('Kilo Git repository seed is unavailable.');
  }
  await repositorySeed.copyTo(repo);
  const kilo = join(home, 'fake-kilo.mjs');
  await writeFile(kilo, input.script);
  await chmod(kilo, 0o755);
  await writeFile(
    paths.config,
    JSON.stringify(
      {
        version: 1,
        kilo: {
          cliPath: kilo,
          concurrency: input.concurrency ?? 2,
          rawLogRetentionDays: 7,
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
  return { paths, repo, kilo };
}

function completedKiloScript() {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'session') {
  console.log(JSON.stringify([
    {
      id: 'ses_search',
      title: 'Sample search result',
      updated: 1710000000000,
      created: 1709999999000,
      projectId: 'project_sample',
      directory: '/tmp/sample',
      project: { id: 'project_sample', name: 'sample', worktree: '/tmp/sample' }
    }
  ]));
  process.exit(0);
}
const dir = args[args.indexOf('--dir') + 1];
if (dir) {
  fs.writeFileSync(path.join(dir, 'README.md'), '# sample\\\\n\\\\nkilo changed\\\\n');
}
console.log(JSON.stringify({
  type: 'text',
  timestamp: Date.now(),
  sessionID: 'ses_root',
  part: { type: 'text', text: 'Kilo finished the requested change.', time: { end: Date.now() } }
}));
console.log(JSON.stringify({
  type: 'tool_use',
  timestamp: Date.now(),
  sessionID: 'ses_root',
  part: {
    type: 'tool',
    tool: 'task',
    state: { status: 'completed' },
    metadata: { sessionId: 'ses_child' }
  }
}));
`;
}

function hangingKiloScript() {
  return `#!/usr/bin/env node
if (process.argv.slice(2)[0] === 'session') {
  console.log(JSON.stringify([]));
  process.exit(0);
}
console.log(JSON.stringify({
  type: 'text',
  timestamp: Date.now(),
  sessionID: 'ses_hanging',
  part: { type: 'text', text: 'Still working.', time: { end: Date.now() } }
}));
setInterval(() => {}, 1000);
`;
}

function failingKiloScript() {
  return `#!/usr/bin/env node
if (process.argv.slice(2)[0] === 'session') {
  console.log(JSON.stringify([]));
  process.exit(0);
}
console.log(JSON.stringify({
  type: 'text',
  timestamp: Date.now(),
  sessionID: 'ses_failed',
  part: { type: 'text', text: 'About to fail.', time: { end: Date.now() } }
}));
console.error('fake kilo failed');
process.exit(2);
`;
}

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'neondeck-kilo-test-'));
  tempRoots.push(path);
  return path;
}

function taskIdFrom(result: Awaited<ReturnType<typeof startKiloTask>>) {
  if (!('taskId' in result) || typeof result.taskId !== 'string') {
    throw new Error('Expected taskId in start result.');
  }
  return result.taskId;
}

function worktreeIdFrom(result: Awaited<ReturnType<typeof createWorktree>>) {
  if (
    !('worktree' in result) ||
    !result.worktree ||
    typeof result.worktree !== 'object' ||
    !('id' in result.worktree) ||
    typeof result.worktree.id !== 'string'
  ) {
    throw new Error('Expected worktree id in createWorktree result.');
  }
  return result.worktree.id;
}

async function waitForTask(
  taskId: string,
  status: string,
  paths: RuntimePaths,
) {
  for (let index = 0; index < 50; index++) {
    const result = await readKiloTaskStatus({ taskId }, paths);
    const task = 'task' in result ? result.task : undefined;
    if (
      task &&
      typeof task === 'object' &&
      'status' in task &&
      task.status === status
    ) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for task ${taskId} to become ${status}.`);
}

async function waitForRootSession(taskId: string, paths: RuntimePaths) {
  for (let index = 0; index < 50; index++) {
    const result = await readKiloTaskStatus({ taskId }, paths);
    const task = 'task' in result ? result.task : undefined;
    if (
      task &&
      typeof task === 'object' &&
      'rootSessionId' in task &&
      typeof task.rootSessionId === 'string'
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for task ${taskId} root session.`);
}

async function waitForTrackedKiloTask(taskId: string) {
  await runningProcesses.get(taskId)?.completed;
}

async function waitForTrackedKiloProcesses() {
  const processes = [...runningProcesses.values()];
  if (processes.length === 0) return;
  const completed = Promise.allSettled(
    processes.map((process) => process.completed),
  );
  const timedOut = Symbol('timedOut');
  const result = await Promise.race([
    completed,
    new Promise<typeof timedOut>((resolve) => {
      setTimeout(() => resolve(timedOut), 2_500);
    }),
  ]);
  if (result !== timedOut) return;
  for (const process of processes) {
    process.child.kill('SIGTERM');
  }
}

function insertStaleRunningTask(
  paths: RuntimePaths,
  taskId: string,
  input: { pid?: number; cliPath?: string } = {},
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
        taskId,
        'Stale task',
        'Old prompt',
        'sample',
        'pandemicsyn/sample',
        null,
        null,
        paths.home,
        'patch-proposal',
        'running',
        1,
        0,
        input.cliPath ?? 'kilo',
        JSON.stringify(['run', 'Old prompt']),
        input.pid ?? 4242,
        now,
        null,
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
