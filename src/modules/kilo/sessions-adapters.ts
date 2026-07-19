import { openDb } from '../../lib/sqlite.ts';
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
  kiloSessionSchema,
  normalizedKiloSessionSchema,
  sessionsSearchInputSchema,
} from './schemas';
import { listLinkedKiloSessionTasks, type KiloTaskRecord } from './store';
import { isRecord, numberOrDateField, stringField } from './utils';
import {
  type KiloConfig,
  type RuntimePaths,
  parseAppConfig,
  readRuntimeJson,
} from '../../runtime-home';

const execFileAsync = promisify(execFile);

function resolveKiloConfig(config: KiloConfig | undefined) {
  return {
    cliPath: config?.cliPath ?? 'kilo',
  };
}

export async function searchKiloSessionsWithCli(
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

export async function searchKiloSessionsWithManagedSdk(
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
  const database = openDb(path, { readOnly: true });
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

export function sessionMatchesSearch(
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

export function searchLinkedSessionsSync(
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

export function taskToSessions(task: KiloTaskRecord) {
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

export function dedupeSessions(
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
