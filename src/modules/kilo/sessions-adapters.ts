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
import {
  type KiloUntrustedInput,
  numberOrDateField,
  stringField,
} from './utils';
import {
  type KiloConfig,
  type RuntimePaths,
  parseAppConfig,
  readRuntimeJson,
} from '../../runtime-home';

const execFileAsync = promisify(execFile);
const untrustedInputSchema = v.unknown();
const looseObjectSchema = v.looseObject({});
const identityObjectSchema = v.custom<v.InferOutput<typeof looseObjectSchema>>(
  (input) => {
    if (Array.isArray(input)) return false;
    return v.safeParse(looseObjectSchema, input).success;
  },
);
const callableSchema = v.function();
const sessionArraySchema = v.array(kiloSessionSchema);
const tableNameRowSchema = v.object({ name: v.string() });

type SessionsSearchInput = v.InferOutput<typeof sessionsSearchInputSchema>;
type NormalizedKiloSession = v.InferOutput<typeof normalizedKiloSessionSchema>;
type KiloSessionSearchResult = {
  ok: true;
  sessions: NormalizedKiloSession[];
};

function resolveKiloConfig(config: KiloConfig | undefined) {
  return {
    cliPath: config?.cliPath ?? 'kilo',
  };
}

export async function searchKiloSessionsWithCli(
  input: SessionsSearchInput,
  paths: RuntimePaths,
): Promise<KiloSessionSearchResult> {
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
  const parsed = v.parse(sessionArraySchema, JSON.parse(stdout));
  return {
    ok: true,
    sessions: parsed.map((session) => normalizeKiloSession(session)),
  };
}

export async function searchKiloSessionsWithManagedSdk(
  input: SessionsSearchInput,
  _paths: RuntimePaths,
): Promise<KiloSessionSearchResult> {
  const sdk = await optionalImport('@kilocode/sdk/v2');
  const client = createOptionalKiloSdkClient(sdk);
  const parsedClient = v.safeParse(looseObjectSchema, client);
  const sessionsApi = parsedClient.success
    ? parsedClient.output.sessions
    : undefined;
  const method = resolveKiloSessionsSearchMethod(sessionsApi);
  if (!method) {
    throw new Error(
      'Kilo managed SDK is not installed or exposes no sessions API.',
    );
  }
  const raw = v.parse(
    untrustedInputSchema,
    await method.call(sessionsApi, {
      query: input.query,
      repoId: input.repoId,
      taskId: input.taskId,
      limit: input.limit ?? 50,
    }),
  );
  const envelope = v.safeParse(looseObjectSchema, raw);
  const items = Array.isArray(raw)
    ? raw
    : envelope.success && Array.isArray(envelope.output.sessions)
      ? envelope.output.sessions
      : envelope.success && Array.isArray(envelope.output.items)
        ? envelope.output.items
        : [];
  const parsed = v.parse(sessionArraySchema, items);
  return {
    ok: true,
    sessions: parsed.map((session) =>
      normalizeSession({
        ...normalizeKiloSession(session),
        role: 'managed',
      }),
    ),
  };
}

export async function searchKiloSessionsWithDisk(
  input: SessionsSearchInput,
): Promise<KiloSessionSearchResult> {
  const paths = await discoverKiloSqlitePaths();
  const sessions: NormalizedKiloSession[] = [];
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
    ok: true,
    sessions: sessions.slice(0, input.limit ?? 50),
  };
}

async function optionalImport(specifier: string): Promise<KiloUntrustedInput> {
  const importer = v.parse(
    callableSchema,
    new Function('specifier', 'return import(specifier)'),
  );
  return v.parse(untrustedInputSchema, await importer(specifier));
}

export function createOptionalKiloSdkClient(sdk: KiloUntrustedInput) {
  const parsedSdk = v.safeParse(identityObjectSchema, sdk);
  if (!parsedSdk.success) return undefined;
  const client = resolveKiloSdkClient(parsedSdk.output, new Set<object>());
  if (client !== undefined) return client;
  return parsedSdk.output;
}

function resolveKiloSdkClient(
  sdk: v.InferOutput<typeof looseObjectSchema>,
  visited: Set<object>,
): KiloUntrustedInput | undefined {
  if (visited.has(sdk)) return undefined;
  visited.add(sdk);

  const nestedDefault = v.safeParse(identityObjectSchema, sdk.default);
  if (nestedDefault.success) {
    const defaultClient = resolveKiloSdkClient(nestedDefault.output, visited);
    if (defaultClient !== undefined) return defaultClient;
  }

  const createClient = v.safeParse(callableSchema, sdk.createClient);
  if (createClient.success) return createClient.output.call(sdk);
  const KiloClient = v.safeParse(callableSchema, sdk.KiloClient);
  if (KiloClient.success) return Reflect.construct(KiloClient.output, []);

  return resolveKiloSessionsSearchMethod(sdk.sessions) ? sdk : undefined;
}

export function resolveKiloSessionsSearchMethod(
  sessionsApi: KiloUntrustedInput,
) {
  const parsed = v.safeParse(looseObjectSchema, sessionsApi);
  if (!parsed.success) return null;
  const search = v.safeParse(callableSchema, parsed.output.search);
  if (search.success) return search.output;
  const list = v.safeParse(callableSchema, parsed.output.list);
  return list.success ? list.output : null;
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

function readKiloSessionsFromSqlite(path: string, input: SessionsSearchInput) {
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
    .flatMap((row) => {
      const parsedRow = v.safeParse(tableNameRowSchema, row);
      return parsedRow.success ? [parsedRow.output.name] : [];
    });
  return tables.find((table) => /session|conversation/i.test(table));
}

function normalizeDiskSession(row: KiloUntrustedInput) {
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
  session: NormalizedKiloSession,
  input: SessionsSearchInput,
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
  input: SessionsSearchInput,
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
  const sessions: NormalizedKiloSession[] = [];
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

function normalizeSession(value: KiloUntrustedInput) {
  return v.parse(normalizedKiloSessionSchema, value);
}

function normalizeSessionProject(value: KiloUntrustedInput) {
  const parsedValue = v.safeParse(looseObjectSchema, value);
  if (!parsedValue.success) return null;
  return {
    id: stringField(parsedValue.output, ['id']),
    name: stringField(parsedValue.output, ['name']),
    worktree: stringField(parsedValue.output, ['worktree']),
  };
}

export function dedupeSessions(sessions: NormalizedKiloSession[]) {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}
