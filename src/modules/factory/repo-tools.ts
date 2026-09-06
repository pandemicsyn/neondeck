import { execFile, execFileSync } from 'node:child_process';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { dbRun, FactoryError } from './service';
import {
  authorizePlanningIntent,
  hashPlanning,
  safeReference,
} from './planning-store';
function git(path: string, args: string[], maxBuffer = 64000) {
  return execFileSync('git', ['--no-pager', '-C', path, ...args], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer,
    env: {
      PATH: process.env.PATH,
      HOME: '/nonexistent',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function captureRepoCommit(path: string | null) {
  if (!path) return null;
  try {
    const sha = git(path, ['rev-parse', '--verify', 'HEAD']).trim();
    return /^[a-f0-9]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
async function gitAsync(
  path: string,
  args: string[],
  signal: AbortSignal,
  maxBuffer = 64000,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', '-C', path, ...args],
      {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer,
        signal,
        env: {
          PATH: process.env.PATH,
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
async function readCommittedFile(
  repo: string,
  commit: string,
  path: string,
  signal: AbortSignal,
) {
  if (
    !safeReference(path) ||
    /(?:^|\/)(?:node_modules|credentials|secrets)(?:\/|$)/i.test(path) ||
    /\.(?:pem|key|p12|env)$/i.test(path)
  )
    throw new FactoryError(403, 'This path is not available to the planner.');
  const mode = await gitAsync(repo, ['ls-tree', commit, '--', path], signal);
  if (!/^100(?:644|755) blob /.test(mode))
    throw new FactoryError(
      403,
      'Only regular files in the captured commit can be read.',
    );
  const content = await gitAsync(
    repo,
    ['show', `${commit}:${path}`],
    signal,
    32000,
  );
  if (content.includes('\0'))
    throw new FactoryError(400, 'Binary files are not available.');
  return content;
}
function authorizeRepo(
  sessionId: string,
  intentId: string,
  paths: RuntimePaths,
) {
  return dbRun(paths, (db) => {
    const intent = authorizePlanningIntent(
      db,
      sessionId,
      intentId,
      'planner',
      paths,
    );
    const { repoPath, repoCommit } = intent.context;
    if (!repoPath || !repoCommit)
      throw new FactoryError(
        409,
        'Local repository context is unavailable. Ask the human for context.',
      );
    return { repoPath, repoCommit };
  });
}
function recordReads(
  sessionId: string,
  intentId: string,
  toolCallId: string,
  context: { repoPath: string; repoCommit: string },
  reads: string[],
  paths: RuntimePaths,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  dbRun(paths, (db) => {
    const intent = authorizePlanningIntent(
      db,
      sessionId,
      intentId,
      'planner',
      paths,
    );
    if (
      intent.context.repoPath !== context.repoPath ||
      intent.context.repoCommit !== context.repoCommit
    )
      throw new FactoryError(409, 'Planning repository context changed.');
    for (const path of reads)
      db.prepare(
        'INSERT OR IGNORE INTO factory_planning_effects (id,intent_id,record) VALUES (?,?,?)',
      ).run(
        hashPlanning({ sessionId, toolCallId, read: path }),
        intentId,
        JSON.stringify({ path, commit: context.repoCommit }),
      );
  });
}
function readSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(10000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
export async function readPlanningRepo(
  sessionId: string,
  intentId: string,
  path: string,
  toolCallId: string,
  paths = runtimePaths(),
  signal?: AbortSignal,
) {
  const budget = readSignal(signal);
  const context = authorizeRepo(sessionId, intentId, paths);
  let content: string;
  try {
    content = await readCommittedFile(
      context.repoPath,
      context.repoCommit,
      path,
      budget,
    );
  } catch (error) {
    budget.throwIfAborted();
    if (error instanceof FactoryError) throw error;
    throw new FactoryError(
      400,
      'File is missing, too large, or could not be read from the captured commit.',
    );
  }
  recordReads(sessionId, intentId, toolCallId, context, [path], paths, budget);
  return { path, commit: context.repoCommit, content };
}
export async function searchPlanningRepo(
  sessionId: string,
  intentId: string,
  data: { query: string; pathPrefix: string },
  toolCallId: string,
  paths = runtimePaths(),
  signal?: AbortSignal,
) {
  const budget = readSignal(signal);
  const context = authorizeRepo(sessionId, intentId, paths);
  let names: string[];
  try {
    names = (
      await gitAsync(
        context.repoPath,
        ['ls-tree', '-r', '--name-only', context.repoCommit],
        budget,
        256000,
      )
    )
      .split('\n')
      .filter(safeReference);
  } catch {
    budget.throwIfAborted();
    throw new FactoryError(
      400,
      'Repository file listing unavailable or exceeds its budget.',
    );
  }
  const selected = names.filter((name) => name.startsWith(data.pathPrefix));
  const pathMatches = selected.filter((name) =>
    name.toLowerCase().includes(data.query.toLowerCase()),
  );
  const matches: Array<{ path: string; line: number; text: string }> = [];
  const reads: string[] = [];
  let bytes = 0;
  for (const path of selected.slice(0, 40)) {
    if (bytes >= 256000 || matches.length >= 50) break;
    let content: string;
    try {
      content = await readCommittedFile(
        context.repoPath,
        context.repoCommit,
        path,
        budget,
      );
    } catch {
      budget.throwIfAborted();
      continue;
    }
    bytes += Buffer.byteLength(content);
    reads.push(path);
    content.split('\n').forEach((line, index) => {
      if (matches.length < 50 && line.includes(data.query))
        matches.push({ path, line: index + 1, text: line.slice(0, 500) });
    });
  }
  recordReads(sessionId, intentId, toolCallId, context, reads, paths, budget);
  return {
    commit: context.repoCommit,
    pathMatches: pathMatches.slice(0, 200),
    matches,
    inspected: reads.length,
    truncated:
      reads.length < selected.length ||
      matches.length >= 50 ||
      pathMatches.length > 200,
  };
}
export function createPlanningRepoTools(
  sessionId: string,
  intentId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return [
    defineTool({
      name: 'readRepoFile',
      description:
        'Read one regular tracked file at the captured commit (32 KB maximum). No working-tree or private files.',
      input: v.strictObject({ path: v.pipe(v.string(), v.maxLength(500)) }),
      run: async ({ data, toolCallId, signal }) => ({
        output: await readPlanningRepo(
          sessionId,
          intentId,
          data.path,
          toolCallId,
          paths,
          signal,
        ),
      }),
    }),
    defineTool({
      name: 'searchRepo',
      description:
        'Search literal text in up to 40 bounded regular files at the captured commit; returns path/line evidence and filename matches. Narrow with pathPrefix.',
      input: v.strictObject({
        query: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
        pathPrefix: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
      }),
      run: async ({ data, toolCallId, signal }) => ({
        output: await searchPlanningRepo(
          sessionId,
          intentId,
          data,
          toolCallId,
          paths,
          signal,
        ),
      }),
    }),
  ];
}
