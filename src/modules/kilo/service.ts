import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import {
  listKiloNotificationFacts,
  notifyKiloState,
  readKiloNotificationFacts,
  resolveKiloNotifications,
} from './notifications';
import {
  attachProcessHandlers,
  kiloLockOwner,
  reconcilePersistedRunningTasks,
  releaseKiloTaskLock,
  releaseTaskLock,
  runningProcesses,
  terminalTaskIds,
} from './process';
import {
  taskDiffSummary,
  taskWithDiff,
  taskWithRuntimeFacts,
} from './runtime-facts';
import {
  eventsInputSchema,
  reconcileInputSchema,
  startInputSchema,
  summarizeInputSchema,
  taskIdInputSchema,
  tasksListInputSchema,
  type ResolvedKiloConfig,
  type WorkspaceResolution,
} from './schemas';
import { resolveSession, taskSessionTree } from './sessions';
import {
  addKiloTaskEvent,
  countRunningKiloTasks,
  insertKiloTask,
  listKiloTaskEvents,
  listKiloTaskRows,
  markKiloTaskFinished,
  readKiloTaskWorktree,
  requireKiloTask,
  resolveKiloTaskForSessionInput,
  tryKiloTask,
  updateKiloTaskProcess,
  updateKiloTaskSummary,
  type KiloHandoffMode,
} from './store';
import { errorMessage, failResult, notFoundResult, parseInput } from './utils';
import {
  type KiloConfig,
  type RepoConfig,
  type RuntimePaths,
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import { repoFullName } from '../repos';
import { lockWorktree, readManagedWorktree } from '../worktrees';
import { readKiloResultStateSummary } from './results';
import { reconcilePreparedDiffRevisionResult } from './revision-reconcile';
import { reconcileCiFixRunForKiloTask } from './ci-fix-run-reconcile';

export async function startKiloTask(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(startInputSchema, rawInput, 'kilo_task_start');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);

  let workspace: WorkspaceResolution | undefined;
  try {
    const config = await readRuntimeJson(paths.config, parseAppConfig);
    const kilo = resolveKiloConfig(config.kilo);
    if (!kilo.enabled) {
      return failResult('kilo_task_start', 'Kilo handoff is disabled.');
    }

    await reconcilePersistedRunningTasks(paths);
    const id = randomUUID();
    workspace = await resolveWorkspace(parsed.input, id, paths);
    assertRepoAllowed(kilo, workspace.repo, workspace.repoFullName);
    assertModeAllowed(parsed.input, workspace);
    const running = countRunningKiloTasks(paths);
    if (running >= kilo.concurrency) {
      return failResult(
        'kilo_task_start',
        `Kilo handoff concurrency limit reached (${kilo.concurrency}).`,
      );
    }

    const mode = parsed.input.mode ?? kilo.defaultMode;
    const autoEnabled = shouldEnableAuto(parsed.input, mode, workspace, kilo);
    const taskPrompt = handoffPrompt({
      prompt: parsed.input.prompt,
      mode,
      repoFullName: workspace.repoFullName,
      cwd: workspace.cwd,
      managedWorktree: workspace.managedWorktree,
    });
    const now = new Date().toISOString();
    const args = [
      'run',
      taskPrompt,
      '--dir',
      workspace.cwd,
      '--title',
      parsed.input.title,
      '--format',
      'json',
    ];
    const model = parsed.input.model ?? kilo.defaultModel;
    const agent = parsed.input.agent ?? kilo.defaultAgent;
    if (model) args.push('--model', model);
    if (agent) args.push('--agent', agent);
    if (autoEnabled) args.push('--auto');
    const rawLogPath =
      kilo.rawLogRetentionDays === 0
        ? null
        : join(dirname(paths.neondeckDatabase), 'kilo-logs', `${id}.jsonl`);

    if (rawLogPath) await mkdir(dirname(rawLogPath), { recursive: true });
    terminalTaskIds.delete(id);
    insertKiloTask(
      {
        id,
        title: parsed.input.title,
        prompt: parsed.input.prompt,
        repoId: workspace.repo.id,
        repoFullName: workspace.repoFullName,
        worktreeId: workspace.worktreeId,
        lockId: workspace.lockId,
        cwd: workspace.cwd,
        mode,
        status: 'running',
        explicitUserRequest: true,
        autoEnabled,
        cliPath: kilo.cliPath,
        args,
        pid: null,
        processStartedAt: null,
        rootSessionId: null,
        childSessionIds: [],
        rawLogPath,
        summary: null,
        exitCode: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
      paths,
    );
    addKiloTaskEvent(
      id,
      {
        eventType: 'task.started',
        stream: 'system',
        summary: `Started Kilo handoff "${parsed.input.title}" in ${workspace.cwd}.`,
        data: {
          args,
          autoEnabled,
          mode,
          repoId: workspace.repo.id,
          worktreeId: workspace.worktreeId,
          lockId: workspace.lockId,
        },
      },
      paths,
    );
    await notifyKiloState(
      {
        taskId: id,
        state: 'started',
        message: `Started Kilo handoff "${parsed.input.title}" in ${workspace.cwd}.`,
        repoId: workspace.repo.id,
        repoFullName: workspace.repoFullName,
        worktreeId: workspace.worktreeId,
        data: { mode, autoEnabled },
      },
      paths,
    );

    const child = spawn(kilo.cliPath, args, {
      cwd: workspace.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rawLog = rawLogPath
      ? createWriteStream(rawLogPath, { flags: 'a' })
      : undefined;
    const completed = attachProcessHandlers(id, child, rawLog, paths);
    runningProcesses.set(id, { child, rawLog, completed });
    updateKiloTaskProcess(id, child.pid ?? null, now, paths);
    await notifyKiloState(
      {
        taskId: id,
        state: 'progress',
        message: `Kilo handoff "${parsed.input.title}" is running${child.pid ? ` as pid ${child.pid}` : ''}.`,
        repoId: workspace.repo.id,
        repoFullName: workspace.repoFullName,
        worktreeId: workspace.worktreeId,
        data: { pid: child.pid ?? null },
      },
      paths,
    );

    return {
      ok: true,
      action: 'kilo_task_start',
      changed: true,
      message: `Started Kilo handoff "${parsed.input.title}".`,
      taskId: id,
      pid: child.pid ?? null,
      rawLogPath,
      command: [kilo.cliPath, ...args],
      task: requireKiloTask(id, paths),
    };
  } catch (error) {
    if (workspace?.lockId) {
      await releaseKiloTaskLock(
        workspace.lockId,
        workspace.lockOwner,
        'failed',
        paths,
      );
    }
    return failResult('kilo_task_start', errorMessage(error));
  }
}

export async function listKiloTasks(
  rawInput: unknown = {},
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(tasksListInputSchema, rawInput, 'kilo_tasks_list');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const limit = parsed.input.limit ?? 50;
  const rows = listKiloTaskRows(
    {
      limit,
      status: parsed.input.status,
      repoId: parsed.input.repoId,
    },
    paths,
  );
  const notificationFacts = await listKiloNotificationFacts(
    rows.map((task) => task.id),
    paths,
  );
  const tasks = parsed.input.includeDiff
    ? await Promise.all(
        rows.map((task) =>
          taskWithDiff(task, paths, notificationFacts.get(task.id) ?? []),
        ),
      )
    : rows.map((task) =>
        taskWithRuntimeFacts(
          {
            ...task,
            ...readKiloResultStateSummary(task.id, paths),
          },
          notificationFacts.get(task.id) ?? [],
        ),
      );
  return {
    ok: true,
    action: 'kilo_tasks_list',
    changed: false,
    message: `Read ${tasks.length} Kilo task(s).`,
    tasks,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readKiloTaskStatus(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_task_status');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryKiloTask(parsed.input.taskId, paths);
  if (!task) {
    return notFoundResult(
      'kilo_task_status',
      `Kilo task ${parsed.input.taskId} was not found.`,
    );
  }
  return {
    ok: true,
    action: 'kilo_task_status',
    changed: false,
    message: `Read Kilo task ${parsed.input.taskId}.`,
    task: taskWithRuntimeFacts(
      {
        ...task,
        ...readKiloResultStateSummary(task.id, paths),
      },
      await readKiloNotificationFacts(task.id, paths),
    ),
  };
}

export async function readKiloTaskEvents(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(eventsInputSchema, rawInput, 'kilo_task_events');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryKiloTask(parsed.input.taskId, paths);
  if (!task) {
    return notFoundResult(
      'kilo_task_events',
      `Kilo task ${parsed.input.taskId} was not found.`,
    );
  }
  const events = listKiloTaskEvents(
    parsed.input.taskId,
    parsed.input.limit ?? 100,
    paths,
  );
  return {
    ok: true,
    action: 'kilo_task_events',
    changed: false,
    message: `Read ${events.length} Kilo event(s).`,
    events,
  };
}

export async function abortKiloTask(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_task_abort');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryKiloTask(parsed.input.taskId, paths);
  if (!task) {
    return notFoundResult(
      'kilo_task_abort',
      `Kilo task ${parsed.input.taskId} was not found.`,
    );
  }
  if (task.status !== 'running') {
    return failResult(
      'kilo_task_abort',
      `Kilo task ${task.id} is ${task.status}, not running.`,
    );
  }

  const running = runningProcesses.get(task.id);
  if (running) {
    running.child.kill('SIGTERM');
  } else {
    return failResult(
      'kilo_task_abort',
      'Kilo task is not attached to this Neondeck process; restart reconciliation is required before it can be safely aborted.',
    );
  }
  markKiloTaskFinished(
    task.id,
    'cancelled',
    null,
    'Cancelled by Neondeck.',
    paths,
  );
  await releaseTaskLock(task, 'cancelled', paths);
  await reconcilePreparedDiffRevisionResult(
    { task: requireKiloTask(task.id, paths), status: 'cancelled' },
    paths,
  );
  await reconcileCiFixRunCompletion(
    { task: requireKiloTask(task.id, paths), status: 'cancelled' },
    paths,
  );
  addKiloTaskEvent(
    task.id,
    {
      eventType: 'task.cancelled',
      stream: 'system',
      summary: 'Cancelled by Neondeck.',
      data: null,
    },
    paths,
  );
  await resolveKiloNotifications(task.id, ['started', 'progress'], paths);
  return {
    ok: true,
    action: 'kilo_task_abort',
    changed: true,
    message: `Cancelled Kilo task ${task.id}.`,
    task: requireKiloTask(task.id, paths),
  };
}

async function reconcileCiFixRunCompletion(
  input: {
    task: ReturnType<typeof requireKiloTask>;
    status: 'cancelled';
  },
  paths: RuntimePaths,
) {
  try {
    await reconcileCiFixRunForKiloTask(input, paths);
  } catch (error) {
    console.error('[neondeck] failed to reconcile CI fix Kilo cancellation', {
      taskId: input.task.id,
      error: errorMessage(error),
    });
  }
}

export async function readKiloTaskSessions(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_task_sessions');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryKiloTask(parsed.input.taskId, paths);
  if (!task) {
    return notFoundResult(
      'kilo_task_sessions',
      `Kilo task ${parsed.input.taskId} was not found.`,
    );
  }
  return {
    ok: true,
    action: 'kilo_task_sessions',
    changed: false,
    message: `Read linked Kilo sessions for task ${task.id}.`,
    taskId: task.id,
    rootSessionId: task.rootSessionId,
    childSessionIds: task.childSessionIds,
    tree: taskSessionTree(task, paths),
  };
}

export async function readKiloTaskDiff(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_task_diff');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryKiloTask(parsed.input.taskId, paths);
  if (!task) {
    return notFoundResult(
      'kilo_task_diff',
      `Kilo task ${parsed.input.taskId} was not found.`,
    );
  }
  return {
    ok: true,
    action: 'kilo_task_diff',
    changed: false,
    message: `Read diff summary for Kilo task ${task.id}.`,
    diff: await taskDiffSummary(task),
  };
}

export async function reconcileKiloTask(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    reconcileInputSchema,
    rawInput,
    'kilo_task_reconcile',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);

  const before = parsed.input.taskId
    ? tryKiloTask(parsed.input.taskId, paths)
    : null;
  if (parsed.input.taskId && !before) {
    return failResult(
      'kilo_task_reconcile',
      `Kilo task ${parsed.input.taskId} was not found.`,
    );
  }

  await reconcilePersistedRunningTasks(paths, parsed.input.taskId);
  const after = parsed.input.taskId
    ? tryKiloTask(parsed.input.taskId, paths)
    : null;
  const changed = parsed.input.taskId
    ? JSON.stringify(before) !== JSON.stringify(after)
    : true;

  return {
    ok: true,
    action: 'kilo_task_reconcile',
    changed,
    message: parsed.input.taskId
      ? `Reconciled Kilo task ${parsed.input.taskId}.`
      : 'Reconciled persisted Kilo tasks.',
    ...(after ? { task: after } : {}),
  };
}

export async function summarizeKiloSession(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    summarizeInputSchema,
    rawInput,
    'summarize_kilo_session',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = resolveKiloTaskForSessionInput(parsed.input, paths);
  const session = await resolveSession(parsed.input, paths);
  if (!task && !session) {
    return failResult(
      'summarize_kilo_session',
      'No matching Kilo task or session was found.',
    );
  }
  const events = task ? listKiloTaskEvents(task.id, 25, paths) : [];
  const summary = [
    `Kilo session: ${session?.id ?? task?.rootSessionId ?? 'unknown'}`,
    task ? `Task: ${task.title} (${task.status})` : undefined,
    task ? `Workspace: ${task.cwd}` : undefined,
    task?.exitCode !== null && task ? `Exit code: ${task.exitCode}` : undefined,
    task?.error ? `Error: ${task.error}` : undefined,
    task?.childSessionIds.length
      ? `Child sessions: ${task.childSessionIds.join(', ')}`
      : undefined,
    events.length
      ? `Recent events: ${events
          .slice(0, 8)
          .map((event) => `${event.eventType}: ${event.summary}`)
          .join(' | ')}`
      : undefined,
  ]
    .filter(Boolean)
    .join('\n');

  if (task) updateKiloTaskSummary(task.id, summary, paths);

  return {
    ok: true,
    action: 'summarize_kilo_session',
    changed: Boolean(task),
    message: 'Summarized Kilo session metadata and recent task events.',
    taskId: task?.id ?? null,
    session: session ?? null,
    summary,
  };
}

async function resolveWorkspace(
  input: v.InferOutput<typeof startInputSchema>,
  taskId: string,
  paths: RuntimePaths,
): Promise<WorkspaceResolution> {
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  if (input.worktreeId) {
    const row = readKiloTaskWorktree(input.worktreeId, paths);
    const record = await readManagedWorktree(
      input.worktreeId,
      row.repo_id,
      paths,
    );
    const repo = registry.repos.find((item) => item.id === row.repo_id);
    if (!repo) {
      throw new Error(
        `Worktree ${input.worktreeId} references an unknown repo.`,
      );
    }
    const lockOwner = kiloLockOwner(taskId);
    const lockResult = await lockWorktree(
      { worktreeId: record.id, owner: lockOwner, ttlSeconds: 86_400 },
      paths,
    );
    if (!lockResult.ok) {
      throw new Error(lockResult.message);
    }
    if (!('lock' in lockResult)) {
      throw new Error('Failed to acquire Kilo worktree lock.');
    }
    return {
      repo,
      repoFullName: repoFullName(repo),
      cwd: await realpath(record.localPath),
      worktreeId: record.id,
      lockId: lockResult.lock.id,
      lockOwner,
      managedWorktree: true,
    };
  }

  if (!input.repoId) {
    throw new Error('A repoId or worktreeId is required.');
  }
  const repo = registry.repos.find((item) => item.id === input.repoId);
  if (!repo) throw new Error(`Repo ${input.repoId} is not configured.`);
  return {
    repo,
    repoFullName: repoFullName(repo),
    cwd: await realpath(repo.path),
    worktreeId: null,
    lockId: null,
    lockOwner: null,
    managedWorktree: false,
  };
}

function assertRepoAllowed(
  config: ResolvedKiloConfig,
  repo: RepoConfig,
  fullName: string,
) {
  const policy = config.repos[repo.id] ?? config.repos[fullName];
  if (policy === 'deny') {
    throw new Error(`Kilo handoff is denied for repo ${fullName}.`);
  }
}

function assertModeAllowed(
  input: v.InferOutput<typeof startInputSchema>,
  workspace: WorkspaceResolution,
) {
  const mode = input.mode ?? 'patch-proposal';
  if (
    mode === 'direct-edit' &&
    !workspace.managedWorktree &&
    input.confirmDirectEdit !== true
  ) {
    throw new Error(
      'Direct-edit Kilo handoffs outside a managed worktree require confirmDirectEdit=true.',
    );
  }
  if (mode === 'draft-fix' && !workspace.managedWorktree) {
    throw new Error('Draft-fix Kilo handoffs require a managed worktree.');
  }
}

export function resolveKiloConfig(
  config: KiloConfig | undefined,
): ResolvedKiloConfig {
  return {
    enabled: config?.enabled ?? true,
    cliPath: config?.cliPath ?? 'kilo',
    defaultModel: config?.defaultModel,
    defaultAgent: config?.defaultAgent,
    defaultMode: config?.defaultMode ?? 'patch-proposal',
    autoPolicy: config?.autoPolicy ?? 'managed-worktree-draft-fix',
    explicitHandoffOnly: config?.explicitHandoffOnly ?? true,
    concurrency: config?.concurrency ?? 1,
    rawLogRetentionDays: config?.rawLogRetentionDays ?? 14,
    repos: config?.repos ?? {},
  };
}

function shouldEnableAuto(
  input: v.InferOutput<typeof startInputSchema>,
  mode: KiloHandoffMode,
  workspace: WorkspaceResolution,
  config: ResolvedKiloConfig,
) {
  if (!input.allowAuto) return false;
  if (input.confirmAuto !== true) {
    throw new Error('Kilo --auto requires confirmAuto=true.');
  }
  if (config.autoPolicy === 'never') {
    throw new Error('Kilo --auto is disabled by config.');
  }
  if (
    config.autoPolicy === 'managed-worktree-draft-fix' &&
    (!workspace.managedWorktree || mode !== 'draft-fix')
  ) {
    throw new Error(
      'Kilo --auto is only allowed for draft-fix handoffs inside managed worktrees.',
    );
  }
  return true;
}

export function handoffPrompt(input: {
  prompt: string;
  mode: KiloHandoffMode;
  repoFullName: string;
  cwd: string;
  managedWorktree: boolean;
}) {
  const constraints = [
    `Neondeck delegated this task explicitly for ${input.repoFullName}.`,
    `Workspace: ${input.cwd}.`,
    input.managedWorktree
      ? 'This is a Neondeck-managed worktree for delegated work.'
      : 'This is a declared repository checkout. Avoid direct edits unless the task specifically requires them.',
    input.mode === 'patch-proposal'
      ? 'Mode: patch-proposal. Prefer explaining the intended patch and keep file mutations minimal.'
      : `Mode: ${input.mode}.`,
    'Do not push branches, open PRs, or change Neondeck config. Leave verification, review, and promotion decisions to Neondeck.',
    'Return useful progress and final status through the normal Kilo session.',
  ];
  return `${constraints.join('\n')}\n\nUser task:\n${input.prompt}`;
}
