import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
  type KiloConfig,
  type RepoConfig,
  type RuntimePaths,
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
import { readGitDiffSummary, repoFullName } from './repos';
import {
  lockWorktree,
  readManagedWorktree,
  releaseWorktreeLock,
} from './worktrees';

const execFileAsync = promisify(execFile);

export type KiloTaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export type KiloHandoffMode = 'draft-fix' | 'patch-proposal' | 'direct-edit';

export type KiloTaskRecord = {
  id: string;
  title: string;
  prompt: string;
  repoId: string;
  repoFullName: string;
  worktreeId: string | null;
  lockId: string | null;
  cwd: string;
  mode: KiloHandoffMode;
  status: KiloTaskStatus;
  explicitUserRequest: boolean;
  autoEnabled: boolean;
  cliPath: string;
  args: string[];
  pid: number | null;
  processStartedAt: string | null;
  rootSessionId: string | null;
  childSessionIds: string[];
  rawLogPath: string | null;
  summary: string | null;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type KiloTaskEventRecord = {
  id: string;
  taskId: string;
  eventIndex: number;
  eventType: string;
  stream: string;
  sessionId: string | null;
  childSessionId: string | null;
  summary: string;
  data: JsonValue | null;
  createdAt: string;
};

type WorkspaceResolution = {
  repo: RepoConfig;
  repoFullName: string;
  cwd: string;
  worktreeId: string | null;
  lockId: string | null;
  lockOwner: string | null;
  managedWorktree: boolean;
};

type RunningProcess = {
  child: ReturnType<typeof spawn>;
  rawLog?: WriteStream;
};

const runningProcesses = new Map<string, RunningProcess>();

const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const handoffModeSchema = v.picklist([
  'draft-fix',
  'patch-proposal',
  'direct-edit',
]);
const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
const startInputSchema = v.object({
  title: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  repoId: v.optional(nonEmptyStringSchema),
  worktreeId: v.optional(nonEmptyStringSchema),
  mode: v.optional(handoffModeSchema),
  model: v.optional(nonEmptyStringSchema),
  agent: v.optional(nonEmptyStringSchema),
  allowAuto: v.optional(v.boolean()),
  confirmAuto: v.optional(v.boolean()),
  confirmDirectEdit: v.optional(v.boolean()),
  explicitUserRequest: v.literal(true),
});
const taskIdInputSchema = v.object({
  taskId: nonEmptyStringSchema,
});
const eventsInputSchema = v.object({
  taskId: nonEmptyStringSchema,
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const tasksListInputSchema = v.object({
  status: v.optional(
    v.picklist(['running', 'succeeded', 'failed', 'cancelled']),
  ),
  repoId: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
});
const sessionsSearchInputSchema = v.object({
  query: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
  taskId: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
});
const sessionReadInputSchema = v.object({
  sessionId: v.optional(nonEmptyStringSchema),
  taskId: v.optional(nonEmptyStringSchema),
  titleQuery: v.optional(nonEmptyStringSchema),
});
const summarizeInputSchema = v.object({
  taskId: v.optional(nonEmptyStringSchema),
  sessionId: v.optional(nonEmptyStringSchema),
  titleQuery: v.optional(nonEmptyStringSchema),
});
const rowNullableStringSchema = v.nullable(v.string());
const rowNullableNumberSchema = v.nullable(v.number());
const taskRowSchema = v.object({
  id: v.string(),
  title: v.string(),
  prompt: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  worktree_id: rowNullableStringSchema,
  lock_id: rowNullableStringSchema,
  cwd: v.string(),
  mode: v.string(),
  status: v.string(),
  explicit_user_request: v.number(),
  auto_enabled: v.number(),
  cli_path: v.string(),
  args_json: v.string(),
  pid: rowNullableNumberSchema,
  process_started_at: rowNullableStringSchema,
  root_session_id: rowNullableStringSchema,
  child_session_ids_json: v.string(),
  raw_log_path: rowNullableStringSchema,
  summary: rowNullableStringSchema,
  exit_code: rowNullableNumberSchema,
  error: rowNullableStringSchema,
  created_at: v.string(),
  updated_at: v.string(),
  completed_at: rowNullableStringSchema,
});
const eventRowSchema = v.object({
  id: v.string(),
  task_id: v.string(),
  event_index: v.number(),
  event_type: v.string(),
  stream: v.string(),
  session_id: rowNullableStringSchema,
  child_session_id: rowNullableStringSchema,
  summary: v.string(),
  data_json: rowNullableStringSchema,
  created_at: v.string(),
});
const kiloSessionSchema = v.looseObject({
  id: nonEmptyStringSchema,
  title: v.optional(v.string()),
  updated: v.optional(v.number()),
  created: v.optional(v.number()),
  projectId: v.optional(v.string()),
  directory: v.optional(v.string()),
  project: v.optional(v.nullable(v.unknown())),
});
const normalizedKiloSessionSchema = v.object({
  id: nonEmptyStringSchema,
  title: v.string(),
  updated: v.optional(v.nullable(v.number())),
  created: v.optional(v.nullable(v.number())),
  projectId: v.optional(v.nullable(v.string())),
  directory: v.optional(v.nullable(v.string())),
  project: v.optional(
    v.nullable(
      v.object({
        id: v.optional(v.string()),
        name: v.optional(v.string()),
        worktree: v.optional(v.string()),
      }),
    ),
  ),
  neondeckTaskId: v.optional(v.string()),
  role: v.picklist(['root', 'child', 'cli']),
});

export const kiloTaskStartAction = defineAction({
  name: 'neondeck_kilo_task_start',
  description:
    'Explicitly start a background KiloCode handoff in a declared repo or Neondeck-managed worktree and persist task/event state.',
  input: startInputSchema,
  output: outputSchema,
  async run({ input }) {
    return startKiloTask(input);
  },
});

export const kiloTaskStatusAction = defineAction({
  name: 'neondeck_kilo_task_status',
  description: 'Read one persisted Kilo handoff task status.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloTaskStatus(input);
  },
});

export const kiloTaskEventsAction = defineAction({
  name: 'neondeck_kilo_task_events',
  description: 'Read persisted Kilo handoff task events.',
  input: eventsInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloTaskEvents(input);
  },
});

export const kiloTaskAbortAction = defineAction({
  name: 'neondeck_kilo_task_abort',
  description: 'Cancel a running Kilo handoff task and mark it cancelled.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return abortKiloTask(input);
  },
});

export const kiloTaskSessionsAction = defineAction({
  name: 'neondeck_kilo_task_sessions',
  description: 'List root and child Kilo session ids linked to one task.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloTaskSessions(input);
  },
});

export const kiloTaskDiffAction = defineAction({
  name: 'neondeck_kilo_task_diff',
  description: 'Read a git diff summary for the workspace used by a Kilo task.',
  input: taskIdInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloTaskDiff(input);
  },
});

export const kiloSessionsSearchAction = defineAction({
  name: 'neondeck_kilo_sessions_search',
  description:
    'Search Kilo session metadata through linked Neondeck tasks and the Kilo CLI session list fallback.',
  input: sessionsSearchInputSchema,
  output: outputSchema,
  async run({ input }) {
    return searchKiloSessions(input);
  },
});

export const kiloSessionReadAction = defineAction({
  name: 'neondeck_kilo_session_read',
  description:
    'Read normalized Kilo session metadata linked to a task or found through Kilo CLI session list. Transcript paging is deferred.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSession(input);
  },
});

export const kiloSessionMessagesAction = defineAction({
  name: 'neondeck_kilo_session_messages',
  description:
    'Audit a request for Kilo session messages. The CLI MVP returns metadata only until a stable transcript adapter is wired.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSessionMessages(input);
  },
});

export const kiloSessionChildrenAction = defineAction({
  name: 'neondeck_kilo_session_children',
  description:
    'Read child Kilo session ids captured from persisted task events.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSessionChildren(input);
  },
});

export const kiloSessionTodosAction = defineAction({
  name: 'neondeck_kilo_session_todos',
  description:
    'Report that Kilo todo access is unavailable in the CLI MVP while returning linked session metadata.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readUnavailableSessionAdapter(input, 'todos');
  },
});

export const kiloSessionDiffAction = defineAction({
  name: 'neondeck_kilo_session_diff',
  description:
    'Read the Neondeck task workspace diff summary for a linked Kilo session when available.',
  input: sessionReadInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readKiloSessionDiff(input);
  },
});

export const kiloTasksLookupTool = defineTool({
  name: 'neondeck_kilo_tasks_lookup',
  description:
    'List persisted Kilo handoff tasks without starting or cancelling work.',
  input: tasksListInputSchema,
  output: outputSchema,
  async run({ input }) {
    return listKiloTasks(input);
  },
});

export const neondeckKiloActions = [
  kiloTaskStartAction,
  kiloTaskStatusAction,
  kiloTaskEventsAction,
  kiloTaskAbortAction,
  kiloTaskSessionsAction,
  kiloTaskDiffAction,
  kiloSessionsSearchAction,
  kiloSessionReadAction,
  kiloSessionMessagesAction,
  kiloSessionChildrenAction,
  kiloSessionTodosAction,
  kiloSessionDiffAction,
];

export const neondeckKiloTools = [kiloTasksLookupTool];

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
    const running = countRunningTasks(paths);
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
    insertTask(
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
    addTaskEvent(
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

    const child = spawn(kilo.cliPath, args, {
      cwd: workspace.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rawLog = rawLogPath
      ? createWriteStream(rawLogPath, { flags: 'a' })
      : undefined;
    runningProcesses.set(id, { child, rawLog });
    updateTaskProcess(id, child.pid ?? null, now, paths);
    attachProcessHandlers(id, child, rawLog, paths);

    return {
      ok: true,
      action: 'kilo_task_start',
      changed: true,
      message: `Started Kilo handoff "${parsed.input.title}".`,
      taskId: id,
      pid: child.pid ?? null,
      rawLogPath,
      command: [kilo.cliPath, ...args],
      task: requireTask(id, paths),
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
  const filters: string[] = [];
  const values: SQLInputValue[] = [];
  if (parsed.input.status) {
    filters.push('status = ?');
    values.push(parsed.input.status);
  }
  if (parsed.input.repoId) {
    filters.push('repo_id = ?');
    values.push(parsed.input.repoId);
  }
  values.push(limit);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `
        SELECT *
        FROM kilo_tasks
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?;
      `,
      )
      .all(...values)
      .map(readTaskRow);
    return {
      ok: true,
      action: 'kilo_tasks_list',
      changed: false,
      message: `Read ${rows.length} Kilo task(s).`,
      tasks: rows,
    };
  } finally {
    database.close();
  }
}

export async function readKiloTaskStatus(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_task_status');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryTask(parsed.input.taskId, paths);
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
    task,
  };
}

export async function readKiloTaskEvents(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(eventsInputSchema, rawInput, 'kilo_task_events');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryTask(parsed.input.taskId, paths);
  if (!task) {
    return notFoundResult(
      'kilo_task_events',
      `Kilo task ${parsed.input.taskId} was not found.`,
    );
  }
  const events = listTaskEvents(
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
  const task = tryTask(parsed.input.taskId, paths);
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
  markTaskFinished(task.id, 'cancelled', null, 'Cancelled by Neondeck.', paths);
  await releaseTaskLock(task, 'cancelled', paths);
  addTaskEvent(
    task.id,
    {
      eventType: 'task.cancelled',
      stream: 'system',
      summary: 'Cancelled by Neondeck.',
      data: null,
    },
    paths,
  );
  return {
    ok: true,
    action: 'kilo_task_abort',
    changed: true,
    message: `Cancelled Kilo task ${task.id}.`,
    task: requireTask(task.id, paths),
  };
}

export async function readKiloTaskSessions(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_task_sessions');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryTask(parsed.input.taskId, paths);
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
  };
}

export async function readKiloTaskDiff(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(taskIdInputSchema, rawInput, 'kilo_task_diff');
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = tryTask(parsed.input.taskId, paths);
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
    diff: await readGitDiffSummary({
      path: task.cwd,
      github: splitRepoFullName(task.repoFullName),
      defaultBranch: 'HEAD',
    }),
  };
}

export async function searchKiloSessions(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    sessionsSearchInputSchema,
    rawInput,
    'kilo_sessions_search',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const linked = searchLinkedSessionsSync(parsed.input, paths);
  const cli = await searchKiloSessionsWithCli(parsed.input, paths).catch(
    (error) => ({
      ok: false as const,
      error: errorMessage(error),
      sessions: [],
    }),
  );
  const sessions = dedupeSessions([...linked, ...cli.sessions]);
  return {
    ok: true,
    action: 'kilo_sessions_search',
    changed: false,
    message: `Found ${sessions.length} Kilo session metadata record(s).`,
    sessions,
    adapters: {
      linkedTasks: linked.length,
      cli: cli.ok ? 'ok' : 'unavailable',
      cliError: cli.ok ? undefined : cli.error,
    },
  };
}

export async function readKiloSession(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    sessionReadInputSchema,
    rawInput,
    'kilo_session_read',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const session = await resolveSession(parsed.input, paths);
  if (!session) {
    return failResult('kilo_session_read', 'Kilo session was not found.');
  }
  return {
    ok: true,
    action: 'kilo_session_read',
    changed: false,
    message: `Read Kilo session ${session.id}.`,
    session,
    transcriptUnavailable: true,
  };
}

export async function readKiloSessionMessages(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    sessionReadInputSchema,
    rawInput,
    'kilo_session_messages',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const session = await resolveSession(parsed.input, paths);
  return {
    ok: Boolean(session),
    action: 'kilo_session_messages',
    changed: false,
    message: session
      ? 'Kilo session transcript adapter is not available in the CLI MVP.'
      : 'Kilo session was not found.',
    session,
    transcriptUnavailable: true,
  };
}

export async function readKiloSessionChildren(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    sessionReadInputSchema,
    rawInput,
    'kilo_session_children',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = resolveTaskForSessionInput(parsed.input, paths);
  return {
    ok: Boolean(task),
    action: 'kilo_session_children',
    changed: false,
    message: task
      ? `Read ${task.childSessionIds.length} child session id(s).`
      : 'No linked Kilo task was found for that session input.',
    taskId: task?.id,
    rootSessionId: task?.rootSessionId,
    childSessionIds: task?.childSessionIds ?? [],
  };
}

export async function readUnavailableSessionAdapter(
  rawInput: unknown,
  adapter: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    sessionReadInputSchema,
    rawInput,
    `kilo_session_${adapter}`,
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const session = await resolveSession(parsed.input, paths);
  return {
    ok: Boolean(session),
    action: `kilo_session_${adapter}`,
    changed: false,
    message: session
      ? `Kilo ${adapter} adapter is not available in the CLI MVP.`
      : 'Kilo session was not found.',
    session,
    unavailable: true,
  };
}

export async function readKiloSessionDiff(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(
    sessionReadInputSchema,
    rawInput,
    'kilo_session_diff',
  );
  if (!parsed.ok) return parsed.result;
  await ensureRuntimeHome(paths);
  const task = resolveTaskForSessionInput(parsed.input, paths);
  if (!task) {
    return failResult(
      'kilo_session_diff',
      'No linked Kilo task was found for that session input.',
    );
  }
  return readKiloTaskDiff({ taskId: task.id }, paths);
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
  const task = resolveTaskForSessionInput(parsed.input, paths);
  const session = await resolveSession(parsed.input, paths);
  if (!task && !session) {
    return failResult(
      'summarize_kilo_session',
      'No matching Kilo task or session was found.',
    );
  }
  const events = task ? listTaskEvents(task.id, 25, paths) : [];
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

  if (task) updateTaskSummary(task.id, summary, paths);

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

function attachProcessHandlers(
  taskId: string,
  child: ReturnType<typeof spawn>,
  rawLog: WriteStream | undefined,
  paths: RuntimePaths,
) {
  let stderr = '';
  if (!child.stdout || !child.stderr) {
    throw new Error('Kilo process was spawned without stdout/stderr pipes.');
  }
  const stdoutLines = createInterface({ input: child.stdout });
  const stderrLines = createInterface({ input: child.stderr });

  stdoutLines.on('line', (line) => {
    writeRawLog(rawLog, 'stdout', line);
    handleKiloLine(taskId, 'stdout', line, paths);
  });
  stderrLines.on('line', (line) => {
    stderr += `${line}\n`;
    writeRawLog(rawLog, 'stderr', line);
    addTaskEvent(
      taskId,
      {
        eventType: 'stderr',
        stream: 'stderr',
        summary: truncate(line, 1_000),
        data: { line },
      },
      paths,
    );
  });
  child.on('error', (error) => {
    void (async () => {
      const task = tryTask(taskId, paths);
      if (!task) return;
      markTaskFinished(taskId, 'failed', null, errorMessage(error), paths);
      await releaseTaskLock(task, 'failed', paths);
      addTaskEvent(
        taskId,
        {
          eventType: 'process.error',
          stream: 'system',
          summary: errorMessage(error),
          data: { error: errorMessage(error) },
        },
        paths,
      );
    })();
  });
  child.on('exit', (code, signal) => {
    void (async () => {
      const task = tryTask(taskId, paths);
      if (!task) return;
      const cancelled = task?.status === 'cancelled';
      const status = cancelled
        ? 'cancelled'
        : code === 0
          ? 'succeeded'
          : 'failed';
      const error =
        status === 'failed'
          ? truncate(
              stderr.trim() || `Kilo exited with code ${code ?? 'unknown'}.`,
              2_000,
            )
          : null;
      markTaskFinished(taskId, status, code, error, paths);
      await releaseTaskLock(task, status, paths);
      if (!tryTask(taskId, paths)?.rootSessionId) {
        await recoverMissingSessionId(taskId, paths);
      }
      addTaskEvent(
        taskId,
        {
          eventType: 'process.exit',
          stream: 'system',
          summary: signal
            ? `Kilo exited from signal ${signal}.`
            : `Kilo exited with code ${code ?? 'unknown'}.`,
          data: { code, signal },
        },
        paths,
      );
      runningProcesses.delete(taskId);
      rawLog?.end();
    })();
  });
}

function handleKiloLine(
  taskId: string,
  stream: string,
  line: string,
  paths: RuntimePaths,
) {
  const parsed = parseJsonLine(line);
  if (!parsed.ok) {
    addTaskEvent(
      taskId,
      {
        eventType: 'stdout',
        stream,
        summary: truncate(line, 1_000),
        data: { line },
      },
      paths,
    );
    return;
  }

  const sessionIds = extractSessionIds(parsed.value);
  const rootSessionId = topLevelSessionId(parsed.value);
  if (rootSessionId) updateTaskSessions(taskId, rootSessionId, [], paths);
  updateTaskSessions(
    taskId,
    rootSessionId ?? undefined,
    sessionIds.filter((id) => id !== rootSessionId),
    paths,
  );
  addTaskEvent(
    taskId,
    {
      eventType: eventType(parsed.value),
      stream,
      sessionId: rootSessionId ?? null,
      childSessionId: sessionIds.find((id) => id !== rootSessionId) ?? null,
      summary: summarizeEvent(parsed.value),
      data: asJsonValue(parsed.value),
    },
    paths,
  );
}

async function recoverMissingSessionId(taskId: string, paths: RuntimePaths) {
  const task = tryTask(taskId, paths);
  if (!task || task.rootSessionId) return;
  const result = await searchKiloSessions(
    { query: task.title, taskId, limit: 5 },
    paths,
  );
  const sessions = 'sessions' in result ? result.sessions : [];
  const id = Array.isArray(sessions) ? sessions[0]?.id : undefined;
  if (!id || typeof id !== 'string') return;
  updateTaskSessions(taskId, id, [], paths);
  addTaskEvent(
    taskId,
    {
      eventType: 'session.recovered',
      stream: 'system',
      sessionId: id,
      summary: `Recovered root Kilo session id ${id} from session search.`,
      data: { sessionId: id },
    },
    paths,
  );
}

async function resolveWorkspace(
  input: v.InferOutput<typeof startInputSchema>,
  taskId: string,
  paths: RuntimePaths,
): Promise<WorkspaceResolution> {
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  if (input.worktreeId) {
    const row = readWorktree(input.worktreeId, paths);
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

type ResolvedKiloConfig = {
  enabled: boolean;
  cliPath: string;
  defaultModel?: string;
  defaultAgent?: string;
  defaultMode: KiloHandoffMode;
  autoPolicy: 'never' | 'managed-worktree-draft-fix' | 'explicit-confirmation';
  explicitHandoffOnly: boolean;
  concurrency: number;
  rawLogRetentionDays: number;
  repos: Record<string, 'allow' | 'deny'>;
};

function resolveKiloConfig(config: KiloConfig | undefined): ResolvedKiloConfig {
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

function handoffPrompt(input: {
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

function insertTask(task: KiloTaskRecord, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO kilo_tasks (
          id, title, prompt, repo_id, repo_full_name, worktree_id, lock_id, cwd, mode,
          status, explicit_user_request, auto_enabled, cli_path, args_json, pid,
          process_started_at, root_session_id, child_session_ids_json,
          raw_log_path, summary, exit_code, error, created_at, updated_at,
          completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        task.id,
        task.title,
        task.prompt,
        task.repoId,
        task.repoFullName,
        task.worktreeId,
        task.lockId,
        task.cwd,
        task.mode,
        task.status,
        task.explicitUserRequest ? 1 : 0,
        task.autoEnabled ? 1 : 0,
        task.cliPath,
        JSON.stringify(task.args),
        task.pid,
        task.processStartedAt,
        task.rootSessionId,
        JSON.stringify(task.childSessionIds),
        task.rawLogPath,
        task.summary,
        task.exitCode,
        task.error,
        task.createdAt,
        task.updatedAt,
        task.completedAt,
      );
  } finally {
    database.close();
  }
}

function updateTaskProcess(
  taskId: string,
  pid: number | null,
  startedAt: string,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE kilo_tasks
        SET pid = ?, process_started_at = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(pid, startedAt, startedAt, taskId);
  } finally {
    database.close();
  }
}

function markTaskFinished(
  taskId: string,
  status: KiloTaskStatus,
  exitCode: number | null,
  error: string | null,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE kilo_tasks
        SET status = ?,
            exit_code = ?,
            error = ?,
            updated_at = ?,
            completed_at = COALESCE(completed_at, ?)
        WHERE id = ?;
      `,
      )
      .run(status, exitCode, error, now, now, taskId);
  } finally {
    database.close();
  }
}

async function reconcilePersistedRunningTasks(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  let tasks: KiloTaskRecord[] = [];
  try {
    tasks = database
      .prepare(
        `
        SELECT *
        FROM kilo_tasks
        WHERE status = 'running'
        ORDER BY updated_at DESC;
      `,
      )
      .all()
      .map(readTaskRow)
      .filter((task) => !runningProcesses.has(task.id));
  } finally {
    database.close();
  }

  for (const task of tasks) {
    const message =
      'Marked failed after Neondeck restart because Kilo restart reconciliation is not implemented yet.';
    markTaskFinished(task.id, 'failed', null, message, paths);
    addTaskEvent(
      task.id,
      {
        eventType: 'task.reconciled_failed',
        stream: 'system',
        summary: message,
        data: {
          pid: task.pid,
          processStartedAt: task.processStartedAt,
          cwd: task.cwd,
        },
      },
      paths,
    );
    await releaseTaskLock(task, 'failed', paths);
  }
}

async function releaseTaskLock(
  task: KiloTaskRecord | undefined,
  status: KiloTaskStatus,
  paths: RuntimePaths,
) {
  if (!task?.lockId) return;
  await releaseKiloTaskLock(task.lockId, kiloLockOwner(task.id), status, paths);
}

async function releaseKiloTaskLock(
  lockId: string,
  owner: string | null,
  status: KiloTaskStatus,
  paths: RuntimePaths,
) {
  await releaseWorktreeLock(
    {
      lockId,
      ...(owner ? { owner } : {}),
      finalStatus: worktreeStatusForKiloStatus(status),
    },
    paths,
  );
}

function worktreeStatusForKiloStatus(status: KiloTaskStatus) {
  if (status === 'succeeded') return 'prepared-diff';
  if (status === 'failed') return 'failed';
  return 'ready';
}

function kiloLockOwner(taskId: string) {
  return `kilo:${taskId}`;
}

function updateTaskSummary(
  taskId: string,
  summary: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE kilo_tasks
        SET summary = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(summary, now, taskId);
  } finally {
    database.close();
  }
}

function updateTaskSessions(
  taskId: string,
  rootSessionId: string | undefined,
  childSessionIds: string[],
  paths: RuntimePaths,
) {
  if (!rootSessionId && childSessionIds.length === 0) return;
  const task = tryTask(taskId, paths);
  if (!task) return;
  const nextChildren = [
    ...new Set([...task.childSessionIds, ...childSessionIds]),
  ];
  const nextRoot = task.rootSessionId ?? rootSessionId ?? null;
  const now = new Date().toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE kilo_tasks
        SET root_session_id = ?,
            child_session_ids_json = ?,
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(nextRoot, JSON.stringify(nextChildren), now, taskId);
  } finally {
    database.close();
  }
}

function addTaskEvent(
  taskId: string,
  input: {
    eventType: string;
    stream: string;
    sessionId?: string | null;
    childSessionId?: string | null;
    summary: string;
    data: unknown;
  },
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  const now = new Date().toISOString();
  try {
    const row = database
      .prepare(
        `
        SELECT COALESCE(MAX(event_index), -1) + 1 AS next_index
        FROM kilo_task_events
        WHERE task_id = ?;
      `,
      )
      .get(taskId) as { next_index?: number } | undefined;
    const eventIndex = row?.next_index ?? 0;
    database
      .prepare(
        `
        INSERT INTO kilo_task_events (
          id, task_id, event_index, event_type, stream, session_id,
          child_session_id, summary, data_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        taskId,
        eventIndex,
        input.eventType,
        input.stream,
        input.sessionId ?? null,
        input.childSessionId ?? null,
        truncate(input.summary, 2_000),
        input.data === null || input.data === undefined
          ? null
          : JSON.stringify(asJsonValue(input.data)),
        now,
      );
  } finally {
    database.close();
  }
}

function requireTask(taskId: string, paths: RuntimePaths) {
  const task = tryTask(taskId, paths);
  if (!task) throw new Error(`Kilo task ${taskId} was not found.`);
  return task;
}

function tryTask(taskId: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM kilo_tasks WHERE id = ?;')
      .get(taskId);
    return row ? readTaskRow(row) : undefined;
  } finally {
    database.close();
  }
}

function resolveTaskForSessionInput(
  input: v.InferOutput<typeof sessionReadInputSchema>,
  paths: RuntimePaths,
) {
  if (input.taskId) return tryTask(input.taskId, paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = input.sessionId
      ? database
          .prepare(
            `
            SELECT *
            FROM kilo_tasks
            WHERE root_session_id = ?
              OR child_session_ids_json LIKE ?
            ORDER BY updated_at DESC
            LIMIT 1;
          `,
          )
          .get(input.sessionId, `%${input.sessionId}%`)
      : input.titleQuery
        ? database
            .prepare(
              `
              SELECT *
              FROM kilo_tasks
              WHERE title LIKE ?
              ORDER BY updated_at DESC
              LIMIT 1;
            `,
            )
            .get(`%${input.titleQuery}%`)
        : undefined;
    return row ? readTaskRow(row) : undefined;
  } finally {
    database.close();
  }
}

function listTaskEvents(taskId: string, limit: number, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM kilo_task_events
        WHERE task_id = ?
        ORDER BY event_index DESC
        LIMIT ?;
      `,
      )
      .all(taskId, limit)
      .map(readEventRow)
      .reverse();
  } finally {
    database.close();
  }
}

function countRunningTasks(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM kilo_tasks WHERE status = 'running';",
      )
      .get() as { count?: number } | undefined;
    return row?.count ?? 0;
  } finally {
    database.close();
  }
}

function readWorktree(id: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT repo_id, local_path, lifecycle_status
        FROM worktrees
        WHERE id = ?;
      `,
      )
      .get(id) as
      | { repo_id: string; local_path: string; lifecycle_status: string }
      | undefined;
    if (!row) throw new Error(`Worktree ${id} was not found.`);
    return row;
  } finally {
    database.close();
  }
}

function readTaskRow(row: unknown): KiloTaskRecord {
  const parsed = v.parse(taskRowSchema, row);
  return {
    id: parsed.id,
    title: parsed.title,
    prompt: parsed.prompt,
    repoId: parsed.repo_id,
    repoFullName: parsed.repo_full_name,
    worktreeId: parsed.worktree_id,
    lockId: parsed.lock_id,
    cwd: parsed.cwd,
    mode: parseMode(parsed.mode),
    status: parseTaskStatus(parsed.status),
    explicitUserRequest: parsed.explicit_user_request === 1,
    autoEnabled: parsed.auto_enabled === 1,
    cliPath: parsed.cli_path,
    args: parseStringArray(parsed.args_json),
    pid: parsed.pid,
    processStartedAt: parsed.process_started_at,
    rootSessionId: parsed.root_session_id,
    childSessionIds: parseStringArray(parsed.child_session_ids_json),
    rawLogPath: parsed.raw_log_path,
    summary: parsed.summary,
    exitCode: parsed.exit_code,
    error: parsed.error,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    completedAt: parsed.completed_at,
  };
}

function readEventRow(row: unknown): KiloTaskEventRecord {
  const parsed = v.parse(eventRowSchema, row);
  return {
    id: parsed.id,
    taskId: parsed.task_id,
    eventIndex: parsed.event_index,
    eventType: parsed.event_type,
    stream: parsed.stream,
    sessionId: parsed.session_id,
    childSessionId: parsed.child_session_id,
    summary: parsed.summary,
    data: parsed.data_json ? asJsonValue(JSON.parse(parsed.data_json)) : null,
    createdAt: parsed.created_at,
  };
}

function parseMode(value: string): KiloHandoffMode {
  const parsed = v.safeParse(handoffModeSchema, value);
  return parsed.success ? parsed.output : 'patch-proposal';
}

function parseTaskStatus(value: string): KiloTaskStatus {
  const parsed = v.safeParse(
    v.picklist(['running', 'succeeded', 'failed', 'cancelled']),
    value,
  );
  return parsed.success ? parsed.output : 'failed';
}

function parseStringArray(source: string): string[] {
  const parsed = v.safeParse(v.array(v.string()), JSON.parse(source));
  return parsed.success ? parsed.output : [];
}

async function searchKiloSessionsWithCli(
  input: v.InferOutput<typeof sessionsSearchInputSchema>,
  paths: RuntimePaths,
) {
  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const kilo = resolveKiloConfig(config.kilo);
  const args = ['session', 'list', '--format', 'json', '--all'];
  if (input.query) args.push('--search', input.query);
  args.push('--max-count', String(input.limit ?? 50));
  const { stdout } = await execFileAsync(kilo.cliPath, args, {
    cwd: paths.home,
    timeout: 15_000,
    maxBuffer: 1024 * 1024 * 5,
  });
  const raw = JSON.parse(stdout) as unknown;
  const parsed = v.parse(v.array(kiloSessionSchema), raw);
  return {
    ok: true as const,
    sessions: parsed.map((session) => normalizeKiloSession(session)),
  };
}

function searchLinkedSessionsSync(
  input: v.InferOutput<typeof sessionsSearchInputSchema>,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  const filters: string[] = [];
  const values: SQLInputValue[] = [];
  if (input.repoId) {
    filters.push('repo_id = ?');
    values.push(input.repoId);
  }
  if (input.taskId) {
    filters.push('id = ?');
    values.push(input.taskId);
  }
  if (input.query) {
    filters.push('(title LIKE ? OR root_session_id LIKE ?)');
    values.push(`%${input.query}%`, `%${input.query}%`);
  }
  values.push(input.limit ?? 50);
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM kilo_tasks
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY updated_at DESC
        LIMIT ?;
      `,
      )
      .all(...values)
      .map(readTaskRow)
      .flatMap(taskToSessions);
  } finally {
    database.close();
  }
}

function taskToSessions(task: KiloTaskRecord) {
  const sessions: Array<v.InferOutput<typeof normalizedKiloSessionSchema>> = [];
  if (task.rootSessionId) {
    sessions.push(
      normalizeSession({
        id: task.rootSessionId,
        title: task.title,
        directory: task.cwd,
        neondeckTaskId: task.id,
        role: 'root',
        updated: Date.parse(task.updatedAt),
        created: Date.parse(task.createdAt),
      }),
    );
  }
  for (const id of task.childSessionIds) {
    sessions.push(
      normalizeSession({
        id,
        title: `${task.title} child`,
        directory: task.cwd,
        neondeckTaskId: task.id,
        role: 'child',
        updated: Date.parse(task.updatedAt),
        created: Date.parse(task.createdAt),
      }),
    );
  }
  return sessions;
}

async function resolveSession(
  input: v.InferOutput<typeof sessionReadInputSchema>,
  paths: RuntimePaths,
) {
  const task = resolveTaskForSessionInput(input, paths);
  const linked = task ? taskToSessions(task) : [];
  const targetId = input.sessionId ?? task?.rootSessionId;
  const exact = targetId
    ? linked.find((session) => session.id === targetId)
    : linked[0];
  if (exact) return exact;
  const query = input.titleQuery ?? input.sessionId;
  const result = await searchKiloSessions({ query, limit: 100 }, paths);
  const sessions =
    'sessions' in result && Array.isArray(result.sessions)
      ? result.sessions
      : [];
  return targetId
    ? sessions.find((session) => session.id === targetId)
    : sessions[0];
}

function normalizeKiloSession(
  session: v.InferOutput<typeof kiloSessionSchema>,
) {
  return normalizeSession({
    id: session.id,
    title: session.title ?? session.id,
    updated: session.updated,
    created: session.created,
    projectId: session.projectId,
    directory: session.directory,
    project: normalizeSessionProject(session.project),
    role: 'cli',
  });
}

function normalizeSession(value: unknown) {
  return v.parse(normalizedKiloSessionSchema, value);
}

function normalizeSessionProject(value: unknown) {
  if (!isRecord(value)) return null;
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    name: typeof value.name === 'string' ? value.name : undefined,
    worktree: typeof value.worktree === 'string' ? value.worktree : undefined,
  };
}

function dedupeSessions(
  sessions: Array<v.InferOutput<typeof normalizedKiloSessionSchema>>,
) {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    const id = typeof session.id === 'string' ? session.id : undefined;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseJsonLine(
  line: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) as unknown };
  } catch {
    return { ok: false };
  }
}

function eventType(value: unknown) {
  if (isRecord(value) && typeof value.type === 'string') return value.type;
  return 'json';
}

function topLevelSessionId(value: unknown) {
  if (!isRecord(value)) return undefined;
  const candidate = value.sessionID ?? value.sessionId;
  return typeof candidate === 'string' ? candidate : undefined;
}

function extractSessionIds(value: unknown) {
  const ids = new Set<string>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) return;
    for (const [key, child] of Object.entries(item)) {
      if (
        (key === 'sessionID' || key === 'sessionId') &&
        typeof child === 'string'
      ) {
        ids.add(child);
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return [...ids];
}

function summarizeEvent(value: unknown) {
  if (!isRecord(value)) return 'Kilo emitted an event.';
  const type = eventType(value);
  const part = isRecord(value.part)
    ? value.part
    : isRecord(value.properties) && isRecord(value.properties.part)
      ? value.properties.part
      : undefined;
  if (part && typeof part.type === 'string') {
    if (part.type === 'text' && typeof part.text === 'string') {
      return truncate(part.text.trim() || `${type}: text`, 1_000);
    }
    if (part.type === 'tool') {
      const tool = typeof part.tool === 'string' ? part.tool : 'tool';
      const status =
        isRecord(part.state) && typeof part.state.status === 'string'
          ? part.state.status
          : 'updated';
      return `${type}: ${tool} ${status}`;
    }
    return `${type}: ${part.type}`;
  }
  if (typeof value.error === 'string') return truncate(value.error, 1_000);
  return type;
}

function writeRawLog(
  rawLog: WriteStream | undefined,
  stream: string,
  line: string,
) {
  rawLog?.write(
    `${JSON.stringify({ stream, line, receivedAt: new Date().toISOString() })}\n`,
  );
}

function splitRepoFullName(fullName: string) {
  const [owner = 'unknown', name = 'unknown'] = fullName.split('/');
  return { owner, name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseInput<T>(
  schema: v.GenericSchema<unknown, T>,
  rawInput: unknown,
  action: string,
):
  | { ok: true; input: T }
  | { ok: false; result: ReturnType<typeof invalidInputResult> } {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: invalidInputResult(
      action,
      parsed.issues[0]?.message ?? 'Invalid input.',
    ),
  };
}

function invalidInputResult(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code: 'INVALID_INPUT', message },
  };
}

function failResult(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code: 'KILO_HANDOFF_ERROR', message },
  };
}

function notFoundResult(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code: 'KILO_NOT_FOUND', message },
  };
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
