import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import {
  runUnattendedGit,
  unattendedGitEnv,
  unattendedGitTimeoutMs,
} from '../../lib/git';
import {
  runtimePaths,
  type RuntimePaths,
  type RepoConfig,
} from '../../runtime-home';
import { readLocalPullRequestFiles } from '../pr-local-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';

export type PrReviewerWorkspaceTarget = {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha?: string | null;
  baseRef?: string | null;
};

export type PrReviewerWorkspace = {
  available: true;
  repoId: string;
  repoFullName: string;
  headSha: string;
  baseSha: string | null;
  mergeBase: string | null;
  tools: ToolDefinition[];
};

export type UnavailablePrReviewerWorkspace = {
  available: false;
  reason: string;
  tools: [];
};

export type PrReviewerWorkspaceResolution =
  PrReviewerWorkspace | UnavailablePrReviewerWorkspace;

const relativePathSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(4_096),
  v.check(isSafeRelativePath, 'Expected a repository-relative path.'),
);
const lineSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

export async function resolvePrReviewerWorkspace(
  target: PrReviewerWorkspaceTarget,
  paths: RuntimePaths = runtimePaths(),
): Promise<PrReviewerWorkspaceResolution> {
  const registry = await readRepoRegistrySnapshot(paths);
  const repo = registry.repos.find(
    (item) =>
      repoFullName(item).toLowerCase() === target.repoFullName.toLowerCase(),
  );
  if (!repo) {
    return unavailable(
      `Repository ${target.repoFullName} is not registered locally.`,
    );
  }

  const headSha = fullSha(target.headSha);
  if (!headSha) return unavailable('The reviewed PR head SHA is unavailable.');
  const baseSha = fullSha(target.baseSha ?? '') ?? null;

  try {
    const base = baseSha ?? localBaseRef(target.baseRef ?? repo.defaultBranch);
    await ensureRevisionAvailable(repo, target, headSha, base, paths);
    const mergeBase = base
      ? await git(repo.path, ['merge-base', base, headSha]).then((value) =>
          value.trim(),
        )
      : null;
    if (base && !mergeBase) {
      return unavailable('Git could not resolve the reviewed merge base.');
    }
    return {
      available: true,
      repoId: repo.id,
      repoFullName: repoFullName(repo),
      headSha,
      baseSha,
      mergeBase,
      tools: reviewerWorkspaceTools({
        repo,
        headSha,
        mergeBase,
      }),
    };
  } catch (error) {
    return unavailable(errorMessage(error));
  }
}

async function ensureRevisionAvailable(
  repo: RepoConfig,
  target: PrReviewerWorkspaceTarget,
  headSha: string,
  base: string | null,
  paths: RuntimePaths,
) {
  const requiredRevisions = [headSha, base].filter(
    (revision): revision is string => Boolean(revision),
  );
  const revisionsAvailable = await Promise.all(
    requiredRevisions.map((revision) =>
      git(repo.path, ['cat-file', '-e', `${revision}^{commit}`])
        .then(() => true)
        .catch(() => false),
    ),
  );
  if (revisionsAvailable.every(Boolean)) return;

  await readLocalPullRequestFiles(
    {
      owner: repo.github.owner,
      repo: repo.github.name,
      number: target.prNumber,
      headSha,
      baseSha: target.baseSha ?? null,
      baseRef: target.baseRef ?? repo.defaultBranch,
      includePatches: false,
    },
    paths,
  );
}

function reviewerWorkspaceTools(input: {
  repo: RepoConfig;
  headSha: string;
  mergeBase: string | null;
}): ToolDefinition[] {
  const { repo, headSha, mergeBase } = input;
  return [
    defineTool({
      name: 'neondeck_review_workspace_list',
      description:
        'List files from the exact reviewed PR head. Use this to traverse the repository before drawing conclusions.',
      input: v.object({
        path: v.optional(relativePathSchema),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_000)),
        ),
      }),
      async run({ input: toolInput }) {
        const limit = toolInput.limit ?? 500;
        const output = await git(repo.path, [
          'ls-tree',
          '-r',
          '--name-only',
          headSha,
          '--',
          ...(toolInput.path ? [toolInput.path] : []),
        ]);
        const allPaths = output.split('\n').filter(Boolean);
        return {
          revision: headSha,
          paths: allPaths.slice(0, limit),
          truncated: allPaths.length > limit,
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_read',
      description:
        'Read a bounded line range from one file at the exact reviewed PR head. Line numbers in the response are repository file line numbers.',
      input: v.object({
        path: relativePathSchema,
        startLine: v.optional(lineSchema),
        endLine: v.optional(lineSchema),
      }),
      async run({ input: toolInput }) {
        const startLine = toolInput.startLine ?? 1;
        const requestedEnd = toolInput.endLine ?? startLine + 399;
        const endLine = Math.min(
          Math.max(startLine, requestedEnd),
          startLine + 999,
        );
        const content = await git(
          repo.path,
          ['show', `${headSha}:${toolInput.path}`],
          16 * 1024 * 1024,
        );
        if (content.includes('\u0000')) {
          return {
            revision: headSha,
            path: toolInput.path,
            binary: true,
            content: '',
          };
        }
        const lines = content.split('\n');
        const selected = lines.slice(startLine - 1, endLine);
        return {
          revision: headSha,
          path: toolInput.path,
          binary: false,
          startLine,
          endLine: startLine + Math.max(0, selected.length - 1),
          totalLines: lines.length,
          content: selected
            .map(
              (line, index) =>
                `${String(startLine + index).padStart(6, ' ')}\t${line}`,
            )
            .join('\n'),
          truncated: endLine < lines.length,
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_search',
      description:
        'Search tracked text files at the exact reviewed PR head using a literal query. Results include repository file line numbers.',
      input: v.object({
        query: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
        path: v.optional(relativePathSchema),
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
        ),
      }),
      async run({ input: toolInput }) {
        const limit = toolInput.limit ?? 100;
        const output = await git(repo.path, [
          'grep',
          '-n',
          '--full-name',
          '-I',
          '-F',
          '-e',
          toolInput.query,
          headSha,
          '--',
          ...(toolInput.path ? [toolInput.path] : []),
        ]).catch((error) => {
          if (isNoMatchesError(error)) return '';
          throw error;
        });
        const allMatches = output
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(`${headSha}:`, ''));
        return {
          revision: headSha,
          query: toolInput.query,
          matches: allMatches.slice(0, limit),
          truncated: allMatches.length > limit,
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_diff',
      description:
        'Read the exact merge-base-to-PR-head diff for one file. For a large diff, pass rightLine after searching or reading the head file to verify that exact RIGHT-side line without returning the entire patch.',
      input: v.object({
        path: relativePathSchema,
        contextLines: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
        ),
        rightLine: v.optional(lineSchema),
      }),
      async run({ input: toolInput }) {
        if (!mergeBase) {
          return {
            available: false,
            reason: 'The reviewed merge base is unavailable.',
          };
        }
        const pathspec = await reviewDiffPathspec(
          repo.path,
          mergeBase,
          headSha,
          toolInput.path,
        );
        if (toolInput.rightLine) {
          const targeted = await streamDiffLinesAroundRightLine(
            repo.path,
            [
              'diff',
              '--no-color',
              '--find-renames',
              `--unified=${toolInput.contextLines ?? 20}`,
              mergeBase,
              headSha,
              '--',
              ...pathspec,
            ],
            toolInput.rightLine,
            toolInput.contextLines ?? 20,
          );
          return {
            available: true,
            base: mergeBase,
            head: headSha,
            path: toolInput.path,
            rightLine: toolInput.rightLine,
            targetChanged: targeted.targetChanged,
            lines: targeted.lines,
            truncated: targeted.truncated,
          };
        }
        const patch = await git(
          repo.path,
          [
            'diff',
            '--no-color',
            '--find-renames',
            `--unified=${toolInput.contextLines ?? 20}`,
            mergeBase,
            headSha,
            '--',
            ...pathspec,
          ],
          16 * 1024 * 1024,
        );
        const bounded = boundText(patch, 256 * 1024);
        return {
          available: true,
          base: mergeBase,
          head: headSha,
          path: toolInput.path,
          patch: bounded.text,
          truncated: bounded.truncated,
        };
      },
    }),
  ];
}

async function reviewDiffPathspec(
  cwd: string,
  mergeBase: string,
  headSha: string,
  path: string,
) {
  const output = await git(
    cwd,
    ['diff', '--name-status', '-z', '--find-renames', mergeBase, headSha, '--'],
    16 * 1024 * 1024,
  );
  const fields = output.split('\u0000');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++] ?? '';
      const nextPath = fields[index++] ?? '';
      if (nextPath === path) return [previousPath, nextPath].filter(Boolean);
      continue;
    }
    const changedPath = fields[index++] ?? '';
    if (changedPath === path) return [path];
  }
  return [path];
}

type TargetedDiffLine = {
  kind: 'addition' | 'deletion' | 'context';
  leftLine: number | null;
  rightLine: number | null;
  rightPosition: number;
  text: string;
  textTruncated: boolean;
};

async function streamDiffLinesAroundRightLine(
  cwd: string,
  args: string[],
  targetRightLine: number,
  contextLines: number,
) {
  const child = spawn('git', args, {
    cwd,
    env: unattendedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: TargetedDiffLine[] = [];
  let responseTruncated = false;
  let targetChanged = false;
  let stderr = '';
  let leftLine = 0;
  let rightLine = 0;
  let inHunk = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, unattendedGitTimeoutMs);
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = boundText(`${stderr}${chunk.toString()}`, 64 * 1024).text;
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const retain = (line: TargetedDiffLine) => {
    if (Math.abs(line.rightPosition - targetRightLine) > contextLines) return;
    if (line.textTruncated) responseTruncated = true;
    if (lines.length >= 500) {
      responseTruncated = true;
      return;
    }
    lines.push(line);
  };

  const handleLine = (text: string, sourceTruncated: boolean) => {
    const header = text.match(
      /^@@ -(?<left>\d+)(?:,\d+)? \+(?<right>\d+)(?:,\d+)? @@/,
    );
    if (header?.groups) {
      leftLine = Number(header.groups.left);
      rightLine = Number(header.groups.right);
      inHunk = true;
      return;
    }
    if (!inHunk || text.startsWith('\\ No newline')) return;
    if (text.startsWith('+')) {
      const bounded = boundText(text.slice(1), 8 * 1024);
      if (rightLine === targetRightLine) targetChanged = true;
      retain({
        kind: 'addition',
        leftLine: null,
        rightLine,
        rightPosition: rightLine,
        text: bounded.text,
        textTruncated: sourceTruncated || bounded.truncated,
      });
      rightLine += 1;
      return;
    }
    if (text.startsWith('-')) {
      const bounded = boundText(text.slice(1), 8 * 1024);
      retain({
        kind: 'deletion',
        leftLine,
        rightLine: null,
        rightPosition: rightLine,
        text: bounded.text,
        textTruncated: sourceTruncated || bounded.truncated,
      });
      leftLine += 1;
      return;
    }
    if (text.startsWith(' ')) {
      const bounded = boundText(text.slice(1), 8 * 1024);
      retain({
        kind: 'context',
        leftLine,
        rightLine,
        rightPosition: rightLine,
        text: bounded.text,
        textTruncated: sourceTruncated || bounded.truncated,
      });
      leftLine += 1;
      rightLine += 1;
    }
  };

  try {
    await consumeBoundedLines(child.stdout, 8 * 1024 + 1, handleLine);
    const result = await closed;
    if (timedOut) {
      throw new Error(
        `git ${args.join(' ')} timed out after ${unattendedGitTimeoutMs}ms.`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        stderr.trim() ||
          `git ${args.join(' ')} failed with ${result.signal ?? `code ${result.code}`}.`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
  return { lines, targetChanged, truncated: responseTruncated };
}

async function consumeBoundedLines(
  stream: NodeJS.ReadableStream,
  maxLineCharacters: number,
  onLine: (line: string, truncated: boolean) => void,
) {
  const decoder = new StringDecoder('utf8');
  let retained = '';
  let truncated = false;

  const append = (segment: string) => {
    const available = Math.max(0, maxLineCharacters - retained.length);
    if (available > 0) retained += segment.slice(0, available);
    if (segment.length > available) truncated = true;
  };
  const emit = () => {
    const line = retained.endsWith('\r') ? retained.slice(0, -1) : retained;
    onLine(line, truncated);
    retained = '';
    truncated = false;
  };
  const consume = (value: string) => {
    let offset = 0;
    while (offset < value.length) {
      const newline = value.indexOf('\n', offset);
      if (newline < 0) {
        append(value.slice(offset));
        return;
      }
      append(value.slice(offset, newline));
      emit();
      offset = newline + 1;
    }
  };

  for await (const chunk of stream) {
    consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }
  consume(decoder.end());
  if (retained || truncated) emit();
}

async function git(cwd: string, args: string[], maxBuffer = 2 * 1024 * 1024) {
  return runUnattendedGit(cwd, args, { maxBuffer });
}

function localBaseRef(baseRef: string | null | undefined) {
  const value = baseRef?.trim();
  if (!value || !isSafeGitRef(value)) return null;
  return `refs/neondeck/base/${value}`;
}

function fullSha(value: string) {
  const trimmed = value.trim();
  return /^[0-9a-f]{40}$/i.test(trimmed) ? trimmed : null;
}

function isSafeRelativePath(value: string) {
  if (
    value.startsWith('/') ||
    value.includes('\u0000') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '..');
}

function isSafeGitRef(value: string) {
  return (
    !value.startsWith('-') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !/[\s\\~^:?*[\]]/.test(value)
  );
}

function boundText(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return { text: value, truncated: false };
  return {
    text: Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

function isNoMatchesError(error: unknown) {
  return /(?:exited|failed) with code 1\b/i.test(errorMessage(error));
}

function unavailable(reason: string): UnavailablePrReviewerWorkspace {
  return { available: false, reason, tools: [] };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
