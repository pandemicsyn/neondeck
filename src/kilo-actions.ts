import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { access, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { readKiloResultStateSummary } from './kilo-results';
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

export type KiloTaskStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs-reconcile'
  | 'needs-review'
  | 'ready-to-verify'
  | 'ready-to-push'
  | 'discarded'
  | 'unknown';

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

export type KiloChildSessionNode = {
  id: string;
  title: string;
  status: 'unknown' | 'active' | 'completed';
  latestSummary: string | null;
  eventCount: number;
  collapsed: boolean;
};

export type KiloSessionReadOptions = {
  limit: number;
  offset: number;
  includeFullTranscript: boolean;
  includeToolOutput: boolean;
  includeDiff: boolean;
  maxBytes: number;
  requesterSurface: string;
  readReason: string | null;
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
    v.picklist([
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'needs-reconcile',
      'needs-review',
      'ready-to-verify',
      'ready-to-push',
      'discarded',
      'unknown',
    ]),
  ),
  repoId: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
  includeDiff: v.optional(v.boolean()),
});
const sessionsSearchInputSchema = v.object({
  query: v.optional(nonEmptyStringSchema),
  sessionId: v.optional(nonEmptyStringSchema),
  repoId: v.optional(nonEmptyStringSchema),
  worktreeId: v.optional(nonEmptyStringSchema),
  directory: v.optional(nonEmptyStringSchema),
  taskId: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
});
const sessionReadInputSchema = v.object({
  sessionId: v.optional(nonEmptyStringSchema),
  taskId: v.optional(nonEmptyStringSchema),
  titleQuery: v.optional(nonEmptyStringSchema),
  limit: v.optional(positiveIntegerSchema),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  includeFullTranscript: v.optional(v.boolean()),
  includeToolOutput: v.optional(v.boolean()),
  includeDiff: v.optional(v.boolean()),
  maxBytes: v.optional(positiveIntegerSchema),
  requesterSurface: v.optional(nonEmptyStringSchema),
  readReason: v.optional(nonEmptyStringSchema),
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
  role: v.picklist(['root', 'child', 'cli', 'managed', 'disk']),
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
    const tasks = parsed.input.includeDiff
      ? await Promise.all(rows.map((task) => taskWithDiff(task, paths)))
      : rows.map((task) => ({
          ...task,
          ...readKiloResultStateSummary(task.id, paths),
        }));
    return {
      ok: true,
      action: 'kilo_tasks_list',
      changed: false,
      message: `Read ${tasks.length} Kilo task(s).`,
      tasks,
      fetchedAt: new Date().toISOString(),
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
    task: {
      ...task,
      ...readKiloResultStateSummary(task.id, paths),
    },
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
    diff: await taskDiffSummary(task),
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
  const managed = await searchKiloSessionsWithManagedSdk(
    parsed.input,
    paths,
  ).catch((error) => ({
    ok: false as const,
    error: errorMessage(error),
    sessions: [],
  }));
  const cli = managed.ok
    ? { ok: false as const, error: 'managed-sdk-used', sessions: [] }
    : await searchKiloSessionsWithCli(parsed.input, paths).catch((error) => ({
        ok: false as const,
        error: errorMessage(error),
        sessions: [],
      }));
  const sessions = dedupeSessions([
    ...linked,
    ...managed.sessions,
    ...cli.sessions,
  ]).filter((session) => sessionMatchesSearch(session, parsed.input));
  return {
    ok: true,
    action: 'kilo_sessions_search',
    changed: false,
    message: `Found ${sessions.length} Kilo session metadata record(s).`,
    sessions,
    adapters: {
      managedSdk: managed.ok ? 'ok' : 'unavailable',
      managedSdkError: managed.ok ? undefined : managed.error,
      linkedTasks: linked.length,
      cli: cli.ok ? 'ok' : 'unavailable',
      cliError: cli.ok ? undefined : cli.error,
      disk: 'recovery-only',
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
  const task = resolveTaskForSessionInput(parsed.input, paths);
  const options = sessionReadOptions(parsed.input);
  addSessionAudit(task, session.id, 'metadata', options, paths);
  const transcript = task
    ? await sessionTranscriptFromTask(task, session.id, options, paths)
    : unavailableTranscript(options);
  return {
    ok: true,
    action: 'kilo_session_read',
    changed: false,
    message: `Read Kilo session ${session.id}.`,
    session,
    transcript,
    transcriptUnavailable: transcript.unavailable,
    children: task ? taskSessionTree(task, paths).children : [],
    todos: [],
    todoAccess: 'unavailable',
    diff:
      task && options.includeDiff
        ? await taskDiffSummary(task)
        : { included: false, reason: 'includeDiff=false' },
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
  const task = resolveTaskForSessionInput(parsed.input, paths);
  const options = sessionReadOptions(parsed.input);
  if (session) addSessionAudit(task, session.id, 'messages', options, paths);
  const transcript =
    session && task
      ? await sessionTranscriptFromTask(task, session.id, options, paths)
      : unavailableTranscript(options);
  return {
    ok: Boolean(session),
    action: 'kilo_session_messages',
    changed: false,
    message: session
      ? `Read ${transcript.messages.length} bounded Kilo message(s).`
      : 'Kilo session was not found.',
    session,
    transcript,
    transcriptUnavailable: transcript.unavailable,
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
  const options = sessionReadOptions(parsed.input);
  addSessionAudit(
    task,
    parsed.input.sessionId ?? task?.rootSessionId ?? null,
    'children',
    options,
    paths,
  );
  const tree = task ? taskSessionTree(task, paths) : null;
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
    tree,
    children: tree?.children ?? [],
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
  const task = resolveTaskForSessionInput(parsed.input, paths);
  const options = sessionReadOptions(parsed.input);
  if (session) addSessionAudit(task, session.id, adapter, options, paths);
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
  const options = sessionReadOptions({ ...parsed.input, includeDiff: true });
  addSessionAudit(
    task,
    parsed.input.sessionId ?? task.rootSessionId,
    'diff',
    options,
    paths,
  );
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
  if (!task || task.rootSessionId) return false;
  const result = await searchKiloSessions(
    { query: task.title, limit: 5 },
    paths,
  );
  const sessions = 'sessions' in result ? result.sessions : [];
  let id = Array.isArray(sessions) ? sessions[0]?.id : undefined;
  if (!id) {
    const disk = await searchKiloSessionsWithDisk({
      query: task.title,
      limit: 5,
    }).catch(() => ({ ok: false as const, sessions: [] }));
    id = disk.sessions[0]?.id;
  }
  if (!id || typeof id !== 'string') return false;
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
  return true;
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

function updateTaskStatus(
  taskId: string,
  status: KiloTaskStatus,
  error: string | null,
  completed: boolean,
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
            error = ?,
            updated_at = ?,
            completed_at = CASE
              WHEN ? = 1 THEN COALESCE(completed_at, ?)
              ELSE completed_at
            END
        WHERE id = ?;
      `,
      )
      .run(status, error, now, completed ? 1 : 0, now, taskId);
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
        WHERE status IN ('running', 'needs-reconcile')
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
    const processInspection = await inspectPersistedKiloProcess(task);
    const processAlive = processInspection.matched;
    const recovered = await recoverMissingSessionId(task.id, paths);
    const diff = await taskDiffSummary(task);
    const status: KiloTaskStatus = processAlive
      ? 'needs-reconcile'
      : diff.ok && diff.fileCount > 0
        ? 'needs-review'
        : 'unknown';
    const message = processAlive
      ? 'Neondeck restarted while this Kilo task process may still be running. The process cannot be safely reattached; review the raw log/session before acting.'
      : status === 'needs-review'
        ? 'Neondeck restarted and the Kilo process is no longer attached. Session/diff state was recovered and needs review.'
        : 'Neondeck restarted and the Kilo process is no longer attached. No changed files were observed; task outcome is unknown.';
    updateTaskStatus(task.id, status, message, !processAlive, paths);
    addTaskEvent(
      task.id,
      {
        eventType: `task.reconciled_${status}`,
        stream: 'system',
        summary: message,
        data: {
          pid: task.pid,
          processStartedAt: task.processStartedAt,
          cwd: task.cwd,
          title: task.title,
          rootSessionId: tryTask(task.id, paths)?.rootSessionId,
          childSessionIds: tryTask(task.id, paths)?.childSessionIds ?? [],
          rawLogPath: task.rawLogPath,
          processAlive: processInspection.alive,
          processMatched: processInspection.matched,
          processMatchReason: processInspection.reason,
          processCommand: processInspection.command,
          observedProcessStartedAt: processInspection.startedAt,
          recoveredSession: recovered,
          diff,
        },
      },
      paths,
    );
    if (!processAlive) await releaseTaskLock(task, status, paths);
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
  if (
    status === 'succeeded' ||
    status === 'needs-review' ||
    status === 'needs-reconcile' ||
    status === 'ready-to-verify' ||
    status === 'ready-to-push'
  ) {
    return 'prepared-diff';
  }
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
        "SELECT COUNT(*) AS count FROM kilo_tasks WHERE status IN ('running', 'needs-reconcile');",
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
    v.picklist([
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'needs-reconcile',
      'needs-review',
      'unknown',
    ]),
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
  const query = input.query ?? input.sessionId ?? input.directory;
  if (query) args.push('--search', query);
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

async function searchKiloSessionsWithManagedSdk(
  input: v.InferOutput<typeof sessionsSearchInputSchema>,
  _paths: RuntimePaths,
) {
  const sdk = await optionalImport('@kilocode/sdk/v2');
  const client = createOptionalKiloSdkClient(sdk);
  const sessionsApi = isRecord(client) ? client.sessions : undefined;
  if (!isRecord(sessionsApi)) {
    throw new Error(
      'Kilo managed SDK is not installed or exposes no sessions API.',
    );
  }
  const search =
    typeof sessionsApi.search === 'function'
      ? sessionsApi.search
      : typeof sessionsApi.list === 'function'
        ? sessionsApi.list
        : undefined;
  if (!search) {
    throw new Error('Kilo managed SDK sessions API cannot search sessions.');
  }
  const raw = (await search.call(sessionsApi, {
    query: input.query,
    repoId: input.repoId,
    taskId: input.taskId,
    limit: input.limit ?? 50,
  })) as unknown;
  const items = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.sessions)
      ? raw.sessions
      : isRecord(raw) && Array.isArray(raw.items)
        ? raw.items
        : [];
  const parsed = v.parse(v.array(kiloSessionSchema), items);
  return {
    ok: true as const,
    sessions: parsed.map((session) =>
      normalizeSession({
        ...normalizeKiloSession(session),
        role: 'managed',
      }),
    ),
  };
}

async function searchKiloSessionsWithDisk(
  input: v.InferOutput<typeof sessionsSearchInputSchema>,
) {
  const paths = await discoverKiloSqlitePaths();
  const sessions: Array<v.InferOutput<typeof normalizedKiloSessionSchema>> = [];
  for (const path of paths) {
    sessions.push(...readKiloSessionsFromSqlite(path, input));
    if (sessions.length >= (input.limit ?? 50)) break;
  }
  if (sessions.length === 0) {
    throw new Error(
      'No readable local Kilo SQLite session store was discovered.',
    );
  }
  return {
    ok: true as const,
    sessions: sessions.slice(0, input.limit ?? 50),
  };
}

async function optionalImport(specifier: string): Promise<unknown> {
  const importer = new Function('specifier', 'return import(specifier)') as (
    specifier: string,
  ) => Promise<unknown>;
  return importer(specifier);
}

function createOptionalKiloSdkClient(sdk: unknown) {
  if (!isRecord(sdk)) return undefined;
  if (isRecord(sdk.default)) return createOptionalKiloSdkClient(sdk.default);
  if (typeof sdk.createClient === 'function') return sdk.createClient();
  if (typeof sdk.KiloClient === 'function') {
    const Client = sdk.KiloClient as new () => unknown;
    return new Client();
  }
  return sdk;
}

async function discoverKiloSqlitePaths() {
  const candidates = [
    process.env.KILO_SESSION_DB,
    process.env.KILOCODE_SESSION_DB,
    join(homedir(), '.config', 'kilo'),
    join(homedir(), '.config', 'kilocode'),
    join(homedir(), '.kilo'),
  ].filter((path): path is string => Boolean(path));
  const files: string[] = [];
  for (const candidate of candidates) {
    files.push(...(await sqliteFiles(candidate)));
  }
  return [...new Set(files)];
}

async function sqliteFiles(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (info.isFile()) return looksLikeSqlitePath(path) ? [path] : [];
    if (!info.isDirectory()) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const entryPath = join(path, entry.name);
        if (entry.isFile()) {
          return Promise.resolve(
            looksLikeSqlitePath(entryPath) ? [entryPath] : [],
          );
        }
        if (entry.isDirectory()) return sqliteFiles(entryPath);
        return Promise.resolve([]);
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

function looksLikeSqlitePath(path: string) {
  return /\.(db|sqlite|sqlite3)$/i.test(path) || basename(path) === 'state';
}

function readKiloSessionsFromSqlite(
  path: string,
  input: v.InferOutput<typeof sessionsSearchInputSchema>,
) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const table = findSessionTable(database);
    if (!table) return [];
    const rows = database
      .prepare(`SELECT * FROM "${table}" LIMIT ?;`)
      .all(Math.max(input.limit ?? 50, 200));
    return rows
      .map((row) => normalizeDiskSession(row))
      .filter(
        (
          session,
        ): session is v.InferOutput<typeof normalizedKiloSessionSchema> =>
          Boolean(session),
      )
      .filter((session) => sessionMatchesSearch(session, input));
  } finally {
    database.close();
  }
}

function findSessionTable(database: DatabaseSync) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    )
    .all()
    .flatMap((row) =>
      isRecord(row) && typeof row.name === 'string' ? [row.name] : [],
    );
  return tables.find((table) => /session|conversation/i.test(table));
}

function normalizeDiskSession(row: unknown) {
  if (!isRecord(row)) return null;
  const id = stringField(row, ['id', 'session_id', 'sessionID']);
  if (!id) return null;
  const title = stringField(row, ['title', 'name', 'summary']) ?? id;
  return normalizeSession({
    id,
    title,
    updated: numberOrDateField(row, [
      'updated',
      'updated_at',
      'last_active_at',
    ]),
    created: numberOrDateField(row, ['created', 'created_at']),
    projectId: stringField(row, ['project_id', 'projectId']),
    directory: stringField(row, ['directory', 'cwd', 'path', 'worktree']),
    role: 'disk',
  });
}

function sessionMatchesSearch(
  session: v.InferOutput<typeof normalizedKiloSessionSchema>,
  input: v.InferOutput<typeof sessionsSearchInputSchema>,
) {
  if (input.query) {
    const query = input.query.toLowerCase();
    const haystack = [session.id, session.title, session.directory ?? '']
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (input.sessionId && session.id !== input.sessionId) return false;
  if (input.directory && !session.directory?.includes(input.directory)) {
    return false;
  }
  if (input.taskId && session.neondeckTaskId !== input.taskId) return false;
  return true;
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
  if (input.worktreeId) {
    filters.push('worktree_id = ?');
    values.push(input.worktreeId);
  }
  if (input.directory) {
    filters.push('cwd LIKE ?');
    values.push(`%${input.directory}%`);
  }
  if (input.sessionId) {
    filters.push('(root_session_id = ? OR child_session_ids_json LIKE ?)');
    values.push(input.sessionId, `%${input.sessionId}%`);
  }
  if (input.query) {
    filters.push(
      '(title LIKE ? OR root_session_id LIKE ? OR child_session_ids_json LIKE ? OR cwd LIKE ?)',
    );
    values.push(
      `%${input.query}%`,
      `%${input.query}%`,
      `%${input.query}%`,
      `%${input.query}%`,
    );
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

function sessionReadOptions(
  input: v.InferOutput<typeof sessionReadInputSchema>,
): KiloSessionReadOptions {
  const limit = Math.min(input.limit ?? 20, 200);
  return {
    limit,
    offset: input.offset ?? 0,
    includeFullTranscript: input.includeFullTranscript ?? false,
    includeToolOutput: input.includeToolOutput ?? false,
    includeDiff: input.includeDiff ?? false,
    maxBytes: Math.min(input.maxBytes ?? 64_000, 1_000_000),
    requesterSurface: input.requesterSurface ?? 'agent',
    readReason: input.readReason ?? null,
  };
}

async function sessionTranscriptFromTask(
  task: KiloTaskRecord,
  sessionId: string,
  options: KiloSessionReadOptions,
  paths: RuntimePaths,
) {
  const events = listTaskEvents(task.id, 1_000, paths)
    .filter(
      (event) =>
        event.sessionId === sessionId || event.childSessionId === sessionId,
    )
    .filter(
      (event) => options.includeToolOutput || event.eventType !== 'tool_use',
    );
  const page = events.slice(options.offset, options.offset + options.limit);
  const rawLog =
    options.includeFullTranscript && task.rawLogPath
      ? await readBoundedFile(task.rawLogPath, options.maxBytes)
      : null;
  return {
    unavailable: false,
    source: rawLog ? 'raw-log+events' : 'events',
    limit: options.limit,
    offset: options.offset,
    totalKnown: events.length,
    hasMore: options.offset + options.limit < events.length,
    fullTranscriptIncluded: Boolean(rawLog),
    maxBytes: options.maxBytes,
    messages: page.map((event) => ({
      id: event.id,
      index: event.eventIndex,
      type: event.eventType,
      stream: event.stream,
      sessionId: event.sessionId,
      childSessionId: event.childSessionId,
      summary: event.summary,
      data: options.includeToolOutput ? event.data : null,
      createdAt: event.createdAt,
    })),
    rawLog,
  };
}

function unavailableTranscript(options: KiloSessionReadOptions) {
  return {
    unavailable: true,
    source: 'none',
    limit: options.limit,
    offset: options.offset,
    totalKnown: 0,
    hasMore: false,
    fullTranscriptIncluded: false,
    maxBytes: options.maxBytes,
    messages: [],
    rawLog: null,
  };
}

async function readBoundedFile(path: string, maxBytes: number) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await access(path);
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    const slice = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    return {
      path,
      text: slice.toString('utf8'),
      bytesRead: slice.byteLength,
      truncated,
    };
  } catch (error) {
    return {
      path,
      text: '',
      bytesRead: 0,
      truncated: false,
      error: errorMessage(error),
    };
  } finally {
    await handle?.close();
  }
}

function taskSessionTree(task: KiloTaskRecord, paths: RuntimePaths) {
  const events = listTaskEvents(task.id, 1_000, paths);
  return {
    id: task.rootSessionId,
    title: task.title,
    status: task.status,
    collapsed: false,
    children: task.childSessionIds.map((id) =>
      childSessionNode(id, task, events),
    ),
  };
}

function childSessionNode(
  id: string,
  task: KiloTaskRecord,
  events: KiloTaskEventRecord[],
): KiloChildSessionNode {
  const childEvents = events.filter((event) => event.childSessionId === id);
  const latest = childEvents.at(-1);
  return {
    id,
    title: `${task.title} child`,
    status: task.status === 'running' ? 'active' : 'unknown',
    latestSummary: latest?.summary ?? null,
    eventCount: childEvents.length,
    collapsed: true,
  };
}

function addSessionAudit(
  task: KiloTaskRecord | undefined,
  sessionId: string | null | undefined,
  readType: string,
  options: KiloSessionReadOptions,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO kilo_session_audit (
          id, task_id, session_id, child_session_id, read_type,
          requester_surface, reason, limit_count, offset_count,
          include_full_transcript, include_tool_output, include_diff, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        task?.id ?? null,
        sessionId ?? null,
        task?.childSessionIds.includes(sessionId ?? '')
          ? (sessionId ?? null)
          : null,
        readType,
        options.requesterSurface,
        options.readReason,
        options.limit,
        options.offset,
        options.includeFullTranscript ? 1 : 0,
        options.includeToolOutput ? 1 : 0,
        options.includeDiff ? 1 : 0,
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

async function taskWithDiff(task: KiloTaskRecord, paths: RuntimePaths) {
  const diff = await taskDiffSummary(task);
  const resultState = readKiloResultStateSummary(task.id, paths);
  return {
    ...task,
    changedFiles: diff.files.map((file) => file.path),
    diff,
    ...resultState,
  };
}

async function taskDiffSummary(task: KiloTaskRecord) {
  return readGitDiffSummary({
    path: task.cwd,
    github: splitRepoFullName(task.repoFullName),
    defaultBranch: 'HEAD',
  });
}

async function inspectPersistedKiloProcess(task: KiloTaskRecord) {
  if (!task.pid || !isProcessAlive(task.pid)) {
    return {
      alive: false,
      matched: false,
      reason: 'pid-not-running',
      command: null,
      startedAt: null,
    };
  }
  const observed = await readProcessSnapshot(task.pid);
  if (!observed.command) {
    return {
      alive: true,
      matched: false,
      reason: 'process-command-unavailable',
      command: null,
      startedAt: observed.startedAt,
    };
  }
  const command = observed.command.toLowerCase();
  const expectedCli = basename(task.cliPath).toLowerCase();
  const hasKiloCommand =
    command.includes(expectedCli) || command.includes('kilo');
  const hasWorkspace = command.includes(task.cwd.toLowerCase());
  const hasTitle = command.includes(task.title.toLowerCase());
  const hasTaskId = command.includes(task.id.toLowerCase());
  const hasKnownSession =
    Boolean(task.rootSessionId && command.includes(task.rootSessionId)) ||
    task.childSessionIds.some((id) => command.includes(id));
  const hasStartMatch = processStartMatches(
    task.processStartedAt,
    observed.startedAt,
  );
  const matched =
    hasKiloCommand &&
    hasStartMatch &&
    (hasWorkspace || hasTitle || hasTaskId || hasKnownSession);
  return {
    alive: true,
    matched,
    reason: matched
      ? 'command-line-matched-persisted-context'
      : 'command-line-did-not-match-persisted-context',
    command: observed.command,
    startedAt: observed.startedAt,
  };
}

function processStartMatches(expected: string | null, observed: string | null) {
  if (!expected || !observed) return true;
  const delta = Math.abs(Date.parse(expected) - Date.parse(observed));
  return Number.isFinite(delta) && delta < 5 * 60_000;
}

async function readProcessSnapshot(pid: number) {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
    );
    const line = stdout.trim();
    if (!line) return { command: null, startedAt: null };
    const parts = line.split(/\s+/);
    const startText = parts.slice(0, 5).join(' ');
    const startedAtMs = Date.parse(startText);
    return {
      command: parts.slice(5).join(' ') || line,
      startedAt: Number.isFinite(startedAtMs)
        ? new Date(startedAtMs).toISOString()
        : null,
    };
  } catch {
    return { command: null, startedAt: null };
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stringField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function numberOrDateField(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
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
