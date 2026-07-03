import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { taskDiffSummary } from './runtime-facts';
import { kiloSessionSchema, normalizedKiloSessionSchema, sessionReadInputSchema, sessionsSearchInputSchema, type KiloChildSessionNode, type KiloSessionReadOptions } from './schemas';
import { listKiloTaskEvents, listLinkedKiloSessionTasks, resolveKiloTaskForSessionInput, type KiloTaskEventRecord, type KiloTaskRecord } from './store';
import { errorMessage, failResult, isRecord, numberOrDateField, parseInput, stringField } from './utils';
import { type KiloConfig, type RuntimePaths, ensureRuntimeHome, parseAppConfig, readRuntimeJson, runtimePaths } from '../../runtime-home';

const execFileAsync = promisify(execFile);

function resolveKiloConfig(config: KiloConfig | undefined) {
  return {
    cliPath: config?.cliPath ?? 'kilo',
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
  const task = resolveKiloTaskForSessionInput(parsed.input, paths);
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
  const task = resolveKiloTaskForSessionInput(parsed.input, paths);
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
  const task = resolveKiloTaskForSessionInput(parsed.input, paths);
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
  const task = resolveKiloTaskForSessionInput(parsed.input, paths);
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
  const task = resolveKiloTaskForSessionInput(parsed.input, paths);
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
  return {
    ok: true,
    action: 'kilo_task_diff',
    changed: false,
    message: `Read diff summary for Kilo task ${task.id}.`,
    diff: await taskDiffSummary(task),
  };
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

export async function searchKiloSessionsWithDisk(
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
  return listLinkedKiloSessionTasks(
    {
      repoId: input.repoId,
      taskId: input.taskId,
      worktreeId: input.worktreeId,
      directory: input.directory,
      sessionId: input.sessionId,
      query: input.query,
      limit: input.limit ?? 50,
    },
    paths,
  ).flatMap(taskToSessions);
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

export async function resolveSession(
  input: v.InferOutput<typeof sessionReadInputSchema>,
  paths: RuntimePaths,
) {
  const task = resolveKiloTaskForSessionInput(input, paths);
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

export function sessionReadOptions(
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
  const events = listKiloTaskEvents(task.id, 1_000, paths)
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

export function taskSessionTree(task: KiloTaskRecord, paths: RuntimePaths) {
  const events = listKiloTaskEvents(task.id, 1_000, paths);
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
