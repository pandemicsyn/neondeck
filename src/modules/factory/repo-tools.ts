import { execFileSync } from 'node:child_process';
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
function readCommittedFile(repo: string, commit: string, path: string) {
  if (
    !safeReference(path) ||
    /(?:^|\/)(?:node_modules|credentials|secrets)(?:\/|$)/i.test(path) ||
    /\.(?:pem|key|p12|env)$/i.test(path)
  )
    throw new FactoryError(403, 'This path is not available to the planner.');
  const mode = git(repo, ['ls-tree', commit, '--', path]);
  if (!/^100(?:644|755) blob /.test(mode))
    throw new FactoryError(
      403,
      'Only regular files in the captured commit can be read.',
    );
  const content = git(repo, ['show', `${commit}:${path}`], 32000);
  if (content.includes('\0'))
    throw new FactoryError(400, 'Binary files are not available.');
  return content;
}
export function readPlanningRepo(
  sessionId: string,
  intentId: string,
  path: string,
  toolCallId: string,
  paths = runtimePaths(),
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
    let content: string;
    try {
      content = readCommittedFile(repoPath, repoCommit, path);
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      throw new FactoryError(
        400,
        'File is missing, too large, or could not be read from the captured commit.',
      );
    }
    db.prepare(
      'INSERT OR IGNORE INTO factory_planning_effects (id,intent_id,record) VALUES (?,?,?)',
    ).run(
      hashPlanning({ sessionId, toolCallId, read: path }),
      intentId,
      JSON.stringify({ path, commit: repoCommit }),
    );
    return { path, commit: repoCommit, content };
  });
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
      run: ({ data, toolCallId }) => ({
        output: readPlanningRepo(
          sessionId,
          intentId,
          data.path,
          toolCallId,
          paths,
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
      run: ({ data, toolCallId }) => ({
        output: dbRun(paths, (db) => {
          const intent = authorizePlanningIntent(
            db,
            sessionId,
            intentId,
            'planner',
            paths,
          );
          if (!intent.context.repoPath || !intent.context.repoCommit)
            throw new FactoryError(
              409,
              'Local repository context unavailable.',
            );
          try {
            const names = git(
              intent.context.repoPath,
              ['ls-tree', '-r', '--name-only', intent.context.repoCommit],
              256000,
            )
              .split('\n')
              .filter(safeReference);
            const selected = names.filter((name) =>
              name.startsWith(data.pathPrefix),
            );
            const pathMatches = selected.filter((name) =>
              name.toLowerCase().includes(data.query.toLowerCase()),
            );
            const matches: Array<{ path: string; line: number; text: string }> =
              [];
            let bytes = 0,
              inspected = 0;
            for (const path of selected.slice(0, 40)) {
              if (bytes >= 256000 || matches.length >= 50) break;
              try {
                const content = readCommittedFile(
                  intent.context.repoPath,
                  intent.context.repoCommit,
                  path,
                );
                bytes += Buffer.byteLength(content);
                inspected++;
                content.split('\n').forEach((line, index) => {
                  if (matches.length < 50 && line.includes(data.query))
                    matches.push({
                      path,
                      line: index + 1,
                      text: line.slice(0, 500),
                    });
                });
                db.prepare(
                  'INSERT OR IGNORE INTO factory_planning_effects (id,intent_id,record) VALUES (?,?,?)',
                ).run(
                  hashPlanning({ sessionId, toolCallId, read: path }),
                  intentId,
                  JSON.stringify({ path, commit: intent.context.repoCommit }),
                );
              } catch {
                /* Unsupported, missing or oversized files are omitted. */
              }
            }
            return {
              commit: intent.context.repoCommit,
              pathMatches: pathMatches.slice(0, 200),
              matches,
              inspected,
              truncated:
                inspected < selected.length ||
                matches.length >= 50 ||
                pathMatches.length > 200,
            };
          } catch {
            throw new FactoryError(
              400,
              'Repository file listing unavailable or exceeds its budget.',
            );
          }
        }),
      }),
    }),
  ];
}
