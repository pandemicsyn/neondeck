import { openDb } from '../lib/sqlite.ts';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { ensureRuntimeHome, type RuntimePaths } from '../runtime-home';
import { readNeonSessionState } from '../modules/sessions';
import { recordRepoEditEvent } from './audit';
import { toRepoEditError, type ResolvedRepoPath } from './path-safety';
import {
  failedResult,
  invalidInputResult,
  maxReadBytes,
  type FileStamp,
} from './schemas';

export type TextFile = {
  content: string;
  stamp: FileStamp;
  lineEnding: '\n' | '\r\n';
  bom: boolean;
};

export type RestorableFileState = {
  content: string;
  stamp?: FileStamp;
  lineEnding?: '\n' | '\r\n';
  bom?: boolean;
};

export async function readTextFile(
  target: ResolvedRepoPath,
): Promise<TextFile> {
  const buffer = await readFile(target.fullPath);
  if (buffer.includes(0)) {
    throw Object.assign(
      new Error(`Refusing to read binary file ${target.relativePath}.`),
      {
        code: 'BINARY_FILE',
        path: target.relativePath,
      },
    );
  }
  if (buffer.byteLength > maxReadBytes) {
    throw Object.assign(
      new Error(`File ${target.relativePath} is too large to read.`),
      {
        code: 'FILE_TOO_LARGE',
        path: target.relativePath,
      },
    );
  }
  const raw = buffer.toString('utf8');
  const bom = raw.startsWith('\uFEFF');
  const content = bom ? raw.slice(1) : raw;
  const stats = await stat(target.fullPath);
  return {
    content: content.replace(/\r\n/g, '\n'),
    stamp: {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    },
    lineEnding: content.includes('\r\n') ? '\r\n' : '\n',
    bom,
  };
}

export function normalizeOutputContent(content: string, before?: TextFile) {
  const lineEnding = before?.lineEnding ?? '\n';
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, lineEnding);
  return before?.bom ? `\uFEFF${normalized}` : normalized;
}

export async function atomicWrite(path: string, content: string) {
  const staged = await stageWrite(path, content);
  await commitStagedWrite(staged);
}

export async function stageWrite(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(
    dirname(path),
    `.neondeck-${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
  );
  const existing = await stat(path).catch(() => undefined);
  await writeFile(temp, content, 'utf8');
  if (existing) {
    await chmod(temp, existing.mode);
  }
  return { temp, target: path };
}

export async function commitStagedWrite(staged: {
  temp: string;
  target: string;
}) {
  await rename(staged.temp, staged.target);
  await access(staged.target, constants.R_OK);
}

export async function cleanupStagedWrites(
  stagedWrites: Array<{ temp: string; target: string }>,
) {
  await Promise.all(
    stagedWrites.map((staged) =>
      rm(staged.temp, { force: true }).catch(() => undefined),
    ),
  );
}

export function restoreContent(state: RestorableFileState) {
  return normalizeOutputContent(state.content, {
    content: state.content,
    stamp: state.stamp ?? { mtimeMs: 0, size: 0, sha256: '' },
    lineEnding: state.lineEnding ?? '\n',
    bom: state.bom ?? false,
  });
}

function isStale(expected: FileStamp | undefined, actual: FileStamp) {
  return Boolean(expected && expected.sha256 !== actual.sha256);
}

export async function isStaleForInput(
  expected: FileStamp | undefined,
  actual: FileStamp,
  repoId: string,
  worktreeId: string | undefined,
  path: string,
  sessionId: string | undefined,
  paths: RuntimePaths,
) {
  if (expected) return isStale(expected, actual);
  if (!sessionId) return false;
  const latest = await latestReadStamp(
    repoId,
    worktreeId,
    path,
    sessionId,
    paths,
  );
  return Boolean(latest && latest.sha256 !== actual.sha256);
}

async function latestReadStamp(
  repoId: string,
  worktreeId: string | undefined,
  path: string,
  sessionId: string,
  paths: RuntimePaths,
): Promise<FileStamp | undefined> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT mtime_ms, size, sha256
        FROM repo_file_reads
        WHERE session_id = ?
          AND repo_id = ?
          AND COALESCE(worktree_id, '') = COALESCE(?, '')
          AND path = ?
        ORDER BY read_at DESC
        LIMIT 1;
      `,
      )
      .get(sessionId, repoId, worktreeId ?? null, path) as
      { mtime_ms: number; size: number; sha256: string } | undefined;
    if (!row) return undefined;
    return {
      mtimeMs: row.mtime_ms,
      size: row.size,
      sha256: row.sha256,
    };
  } finally {
    database.close();
  }
}

export function staleResult(action: string, repoId: string, path: string) {
  return failedResult(
    action,
    `File ${path} changed since it was read. Re-read and retry.`,
    {
      code: 'STALE_FILE',
      message: `File ${path} changed since it was read. Re-read and retry.`,
      path,
      details: { repoId },
    },
  );
}

export async function recordReadStamp(
  repoId: string,
  worktreeId: string | undefined,
  path: string,
  stamp: FileStamp,
  sessionId: string | undefined,
  paths: RuntimePaths,
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO repo_file_reads (
          session_id,
          repo_id,
          worktree_id,
          path,
          mtime_ms,
          size,
          sha256,
          partial,
          read_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        sessionId ?? null,
        repoId,
        worktreeId ?? null,
        path,
        stamp.mtimeMs,
        stamp.size,
        stamp.sha256,
        0,
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

export function lockKey(
  repoId: string,
  worktreeId: string | undefined,
  path: string,
) {
  return `${repoId}\0${worktreeId ?? 'base'}\0${path}`;
}

export function parseInput<T>(
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
      `Invalid input: ${v.summarize(parsed.issues)}`,
    ),
  };
}

function errorResult(action: string, error: unknown) {
  const converted =
    error && typeof error === 'object' && 'code' in error
      ? {
          code: String((error as { code: unknown }).code),
          message: error instanceof Error ? error.message : String(error),
          path:
            'path' in error &&
            typeof (error as { path?: unknown }).path === 'string'
              ? (error as { path: string }).path
              : undefined,
        }
      : toRepoEditError(error);
  return failedResult(action, converted.message, {
    code: isRepoEditErrorCode(converted.code) ? converted.code : 'IO_ERROR',
    message: converted.message,
    path: converted.path,
  });
}

export async function failureResult(
  action: string,
  error: unknown,
  paths: RuntimePaths,
  rawInput: unknown,
) {
  await recordFailureEvent(
    action.replace(/^repo_file_/, ''),
    error,
    paths,
    rawInput,
  );
  return errorResult(action, error);
}

export async function resolveSessionId(
  inputSessionId: string | undefined,
  paths: RuntimePaths,
) {
  if (inputSessionId) return inputSessionId;
  return readNeonSessionState(paths)
    .then((state) => state.activeChatSession.id)
    .catch(() => undefined);
}

export async function recordFailureEvent(
  action: string,
  error: unknown,
  paths: RuntimePaths,
  rawInput: unknown,
) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const repoId =
    'repoId' in input && typeof input.repoId === 'string'
      ? input.repoId
      : undefined;
  if (!repoId) return;
  const worktreeId =
    'worktreeId' in input && typeof input.worktreeId === 'string'
      ? input.worktreeId
      : undefined;
  const converted = toRepoEditError(error);
  const requestedPaths = extractRequestedPaths(input);
  const sessionId =
    'sessionId' in input && typeof input.sessionId === 'string'
      ? input.sessionId
      : await resolveSessionId(undefined, paths);
  await recordRepoEditEvent(
    {
      repoId,
      worktreeId,
      sessionId,
      action,
      status:
        converted.code === 'PATH_DENIED' ||
        converted.code === 'PATH_OUTSIDE_WORKSPACE'
          ? 'blocked'
          : 'failed',
      paths: requestedPaths,
      error: converted,
    },
    paths,
  ).catch(() => undefined);
}

function extractRequestedPaths(input: object) {
  const paths: string[] = [];
  if ('path' in input && typeof input.path === 'string') paths.push(input.path);
  if ('paths' in input && Array.isArray(input.paths)) {
    paths.push(...input.paths.filter((path) => typeof path === 'string'));
  }
  return paths;
}

function isRepoEditErrorCode(
  value: string,
): value is ReturnType<typeof toRepoEditError>['code'] {
  return [
    'INVALID_INPUT',
    'REPO_NOT_FOUND',
    'PATH_OUTSIDE_WORKSPACE',
    'PATH_DENIED',
    'FILE_NOT_FOUND',
    'BINARY_FILE',
    'FILE_TOO_LARGE',
    'STALE_FILE',
    'NO_MATCH',
    'AMBIGUOUS_MATCH',
    'LOW_CONFIDENCE',
    'PATCH_PARSE_ERROR',
    'PATCH_VALIDATE_ERROR',
    'GIT_ERROR',
    'WORKTREE_NOT_FOUND',
    'WORKTREE_DELETED',
    'WORKTREE_NOT_READY',
    'WORKTREE_LOCKED',
    'PATH_OUTSIDE_WORKTREE_ROOT',
    'REPO_MISMATCH',
    'CORRUPT_WORKTREE_ROW',
    'WORKTREE_ERROR',
    'IO_ERROR',
  ].includes(value);
}

export async function execRg(cwd: string, args: string[]) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('rg', args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export function safeGlobs(globs?: string[]) {
  return (globs ?? []).filter(
    (glob) =>
      glob.trim() &&
      !glob.startsWith('/') &&
      !glob.split(/[\\/]/).includes('..'),
  );
}

export async function fallbackSearch(
  root: string,
  query: string,
  maxResults: number,
) {
  const results: string[] = [];
  await walk(root, async (path) => {
    if (results.length >= maxResults) return;
    const buffer = await readFile(path).catch(() => Buffer.alloc(0));
    if (buffer.byteLength > maxReadBytes || buffer.includes(0)) return;
    const text = buffer.toString('utf8');
    const relative = path.slice(root.length + 1).replaceAll('\\', '/');
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.includes(query)) continue;
      results.push(`${relative}:${index + 1}:${line}`);
      if (results.length >= maxResults) break;
    }
  });
  return results.join('\n');
}

async function walk(root: string, visit: (path: string) => Promise<void>) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === '.astro'
    ) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}
