import { openDb } from '../../lib/sqlite.ts';
import { randomUUID } from 'node:crypto';
import { access, open } from 'node:fs/promises';
import * as v from 'valibot';
import { taskDiffSummary } from './runtime-facts';
import {
  sessionReadInputSchema,
  sessionsSearchInputSchema,
  type KiloChildSessionNode,
  type KiloSessionReadOptions,
} from './schemas';
import {
  listKiloTaskEvents,
  resolveKiloTaskForSessionInput,
  type KiloTaskEventRecord,
  type KiloTaskRecord,
} from './store';
import { errorMessage, failResult, parseInput } from './utils';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  dedupeSessions,
  searchKiloSessionsWithCli,
  searchKiloSessionsWithManagedSdk,
  searchLinkedSessionsSync,
  sessionMatchesSearch,
  taskToSessions,
} from './sessions-adapters';

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
  const database = openDb(paths.neondeckDatabase);
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
