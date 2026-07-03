import { type JsonValue } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import * as v from 'valibot';
import { type RuntimePaths } from '../../runtime-home';

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

export type KiloTaskListFilters = {
  status?: KiloTaskStatus;
  repoId?: string;
  limit: number;
};

export type KiloSessionTaskLookup = {
  taskId?: string;
  sessionId?: string;
  titleQuery?: string;
};

export type KiloLinkedSessionTaskFilters = {
  repoId?: string;
  taskId?: string;
  worktreeId?: string;
  directory?: string;
  sessionId?: string;
  query?: string;
  limit: number;
};

const rowNullableStringSchema = v.nullable(v.string());
const rowNullableNumberSchema = v.nullable(v.number());
const handoffModeSchema = v.picklist([
  'draft-fix',
  'patch-proposal',
  'direct-edit',
]);
const taskStatusSchema = v.picklist([
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
]);
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

export function insertKiloTask(task: KiloTaskRecord, paths: RuntimePaths) {
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

export function listKiloTaskRows(
  filters: KiloTaskListFilters,
  paths: RuntimePaths,
) {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (filters.status) {
    clauses.push('status = ?');
    values.push(filters.status);
  }
  if (filters.repoId) {
    clauses.push('repo_id = ?');
    values.push(filters.repoId);
  }
  values.push(filters.limit);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

  try {
    return database
      .prepare(
        `
        SELECT *
        FROM kilo_tasks
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ?;
      `,
      )
      .all(...values)
      .map(readTaskRow);
  } finally {
    database.close();
  }
}

export function listReconcileableKiloTasks(
  paths: RuntimePaths,
  taskId?: string,
) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

  try {
    const statement = taskId
      ? database.prepare(
          `
        SELECT *
        FROM kilo_tasks
        WHERE id = ?
          AND status IN ('running', 'needs-reconcile')
        ORDER BY updated_at DESC;
      `,
        )
      : database.prepare(
          `
        SELECT *
        FROM kilo_tasks
        WHERE status IN ('running', 'needs-reconcile')
        ORDER BY updated_at DESC;
      `,
        );

    return (taskId ? statement.all(taskId) : statement.all()).map(readTaskRow);
  } finally {
    database.close();
  }
}

export function listLinkedKiloSessionTasks(
  filters: KiloLinkedSessionTaskFilters,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (filters.repoId) {
    clauses.push('repo_id = ?');
    values.push(filters.repoId);
  }
  if (filters.taskId) {
    clauses.push('id = ?');
    values.push(filters.taskId);
  }
  if (filters.worktreeId) {
    clauses.push('worktree_id = ?');
    values.push(filters.worktreeId);
  }
  if (filters.directory) {
    clauses.push('cwd LIKE ?');
    values.push(`%${filters.directory}%`);
  }
  if (filters.sessionId) {
    clauses.push('(root_session_id = ? OR child_session_ids_json LIKE ?)');
    values.push(filters.sessionId, `%${filters.sessionId}%`);
  }
  if (filters.query) {
    clauses.push(
      '(title LIKE ? OR root_session_id LIKE ? OR child_session_ids_json LIKE ? OR cwd LIKE ?)',
    );
    values.push(
      `%${filters.query}%`,
      `%${filters.query}%`,
      `%${filters.query}%`,
      `%${filters.query}%`,
    );
  }
  values.push(filters.limit);

  try {
    return database
      .prepare(
        `
        SELECT *
        FROM kilo_tasks
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY updated_at DESC
        LIMIT ?;
      `,
      )
      .all(...values)
      .map(readTaskRow);
  } finally {
    database.close();
  }
}

export function updateKiloTaskProcess(
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

export function markKiloTaskFinished(
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

export function updateKiloTaskStatus(
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

export function updateKiloTaskSummary(
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

export function updateKiloTaskSessions(
  taskId: string,
  rootSessionId: string | undefined,
  childSessionIds: string[],
  paths: RuntimePaths,
) {
  if (!rootSessionId && childSessionIds.length === 0) return;
  const task = tryKiloTask(taskId, paths);
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

export function addKiloTaskEvent(
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

export function requireKiloTask(taskId: string, paths: RuntimePaths) {
  const task = tryKiloTask(taskId, paths);
  if (!task) throw new Error(`Kilo task ${taskId} was not found.`);
  return task;
}

export function tryKiloTask(taskId: string, paths: RuntimePaths) {
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

export function resolveKiloTaskForSessionInput(
  input: KiloSessionTaskLookup,
  paths: RuntimePaths,
) {
  if (input.taskId) return tryKiloTask(input.taskId, paths);
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

export function listKiloTaskEvents(
  taskId: string,
  limit: number,
  paths: RuntimePaths,
) {
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

export function countRunningKiloTasks(paths: RuntimePaths) {
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

export function readKiloTaskWorktree(id: string, paths: RuntimePaths) {
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
  const parsed = v.safeParse(taskStatusSchema, value);
  return parsed.success ? parsed.output : 'failed';
}

function parseStringArray(source: string): string[] {
  const parsed = v.safeParse(v.array(v.string()), JSON.parse(source));
  return parsed.success ? parsed.output : [];
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function asJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
