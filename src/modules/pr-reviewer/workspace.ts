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
import { ensureLocalPullRequestRevisions } from '../pr-local-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';

export type PrReviewerWorkspaceTarget = {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha?: string | null;
  baseRef?: string | null;
};

export const prReviewerWorkspaceToolCallLimit = 250;

export type PrReviewerWorkspace = {
  available: true;
  repoId: string;
  repoFullName: string;
  repoPath: string;
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

export type PrReviewerWorkspaceToolContext = {
  repoPath: string;
  headSha: string;
  mergeBase: string | null;
};

export type PrReviewerWorkspaceToolContextResolution =
  | ({ available: true } & PrReviewerWorkspaceToolContext)
  | { available: false; reason: string };

const relativePathSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(4_096),
  v.check(isSafeRelativePath, 'Expected a repository-relative path.'),
);
const lineSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const revisionSchema = v.optional(v.picklist(['head', 'base']));
const resultLimitSchema = (maximum: number) =>
  v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum)),
  );
const cursorSchema = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_000_000)),
);

export async function resolvePrReviewerWorkspace(
  target: PrReviewerWorkspaceTarget,
  paths: RuntimePaths = runtimePaths(),
  signal?: AbortSignal,
): Promise<PrReviewerWorkspaceResolution> {
  signal?.throwIfAborted();
  const registry = await readRepoRegistrySnapshot(paths);
  signal?.throwIfAborted();
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
    await ensureRevisionAvailable(repo, target, headSha, base, paths, signal);
    const mergeBase = base
      ? await git(
          repo.path,
          ['merge-base', base, headSha],
          undefined,
          signal,
        ).then((value) => value.trim())
      : null;
    if (base && !mergeBase) {
      return unavailable('Git could not resolve the reviewed merge base.');
    }
    return {
      available: true,
      repoId: repo.id,
      repoFullName: repoFullName(repo),
      repoPath: repo.path,
      headSha,
      baseSha,
      mergeBase,
      tools: createPrReviewerWorkspaceTools({
        repoPath: repo.path,
        headSha,
        mergeBase,
      }),
    };
  } catch (error) {
    signal?.throwIfAborted();
    return unavailable(errorMessage(error));
  }
}

async function ensureRevisionAvailable(
  repo: RepoConfig,
  target: PrReviewerWorkspaceTarget,
  headSha: string,
  base: string | null,
  paths: RuntimePaths,
  signal?: AbortSignal,
) {
  const requiredRevisions = [headSha, base].filter(
    (revision): revision is string => Boolean(revision),
  );
  const revisionsAvailable = await Promise.all(
    requiredRevisions.map((revision) =>
      git(
        repo.path,
        ['cat-file', '-e', `${revision}^{commit}`],
        undefined,
        signal,
      )
        .then(() => true)
        .catch(() => {
          signal?.throwIfAborted();
          return false;
        }),
    ),
  );
  if (revisionsAvailable.every(Boolean)) return;

  await ensureLocalPullRequestRevisions(
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
    signal,
  );
}

export function createPrReviewerWorkspaceTools(
  input: PrReviewerWorkspaceToolContext,
  options: {
    consumeToolCall?: () => number | null;
  } = {},
): ToolDefinition[] {
  return createResolvedPrReviewerWorkspaceTools(
    async () => ({ available: true, ...input }),
    options,
  );
}

export function createDeferredPrReviewerWorkspaceTools(
  resolve: (
    signal?: AbortSignal,
  ) => Promise<PrReviewerWorkspaceToolContextResolution>,
  options: {
    consumeToolCall?: () => number | null;
  } = {},
): ToolDefinition[] {
  return createResolvedPrReviewerWorkspaceTools(resolve, options);
}

function createResolvedPrReviewerWorkspaceTools(
  resolve: (
    signal?: AbortSignal,
  ) => Promise<PrReviewerWorkspaceToolContextResolution>,
  options: {
    consumeToolCall?: () => number | null;
  },
): ToolDefinition[] {
  let remainingToolCalls = prReviewerWorkspaceToolCallLimit;
  const consumeToolCall =
    options.consumeToolCall ??
    (() => {
      if (remainingToolCalls <= 0) return null;
      remainingToolCalls -= 1;
      return remainingToolCalls;
    });
  const budgeted = <T extends Record<string, unknown>>(
    result: T,
    remaining: number,
  ) => ({
    ...result,
    workspaceToolCallsRemaining: remaining,
    workspaceToolCallLimit: prReviewerWorkspaceToolCallLimit,
  });
  const exhausted = () => ({
    available: false,
    reason: `The exact-revision workspace exploration budget of ${prReviewerWorkspaceToolCallLimit} calls is exhausted. Stop calling workspace tools and complete the current response now using the best evidence already collected. If structured result tools are available, call finish.`,
    workspaceToolCallsRemaining: 0,
    workspaceToolCallLimit: prReviewerWorkspaceToolCallLimit,
  });
  const unavailableWorkspace = (reason: string) => ({
    available: false,
    reason,
  });
  const budgetDescription = ` This call shares a hard ${prReviewerWorkspaceToolCallLimit}-call exploration budget with the other exact-revision workspace tools.`;
  return [
    defineTool({
      name: 'neondeck_review_workspace_changes',
      description:
        'Discover the exact merge-base-to-PR-head changed-file index with Git status and line counts. Use this to understand review scope before selecting diffs; results are pageable and never include patch bodies.' +
        budgetDescription,
      input: v.object({
        cursor: cursorSchema,
        limit: resultLimitSchema(500),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const { repoPath, headSha, mergeBase } = workspace;
        if (!mergeBase) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const changes = await readChangedFiles(
          repoPath,
          mergeBase,
          headSha,
          signal,
        );
        const cursor = Math.min(toolInput.cursor ?? 0, changes.files.length);
        const limit = toolInput.limit ?? 100;
        const files = changes.files.slice(cursor, cursor + limit);
        const nextCursor = cursor + files.length;
        return {
          output: await budgeted(
            {
              available: true,
              base: mergeBase,
              head: headSha,
              summary: changes.summary,
              cursor,
              files,
              nextCursor: nextCursor < changes.files.length ? nextCursor : null,
              truncated: nextCursor < changes.files.length,
            },
            remaining,
          ),
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_list',
      description:
        'List files from the exact reviewed PR head or merge base. Use this to traverse repository structure beyond the changed-file index.' +
        budgetDescription,
      input: v.object({
        path: v.optional(relativePathSchema),
        revision: revisionSchema,
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2_000)),
        ),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const { repoPath } = workspace;
        const revision = resolveWorkspaceRevision(
          workspace,
          toolInput.revision,
        );
        if (!revision) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const limit = toolInput.limit ?? 500;
        const output = await git(
          repoPath,
          [
            'ls-tree',
            '-r',
            '--name-only',
            revision.sha,
            '--',
            ...(toolInput.path ? [literalPathspec(toolInput.path)] : []),
          ],
          undefined,
          signal,
        );
        const allPaths = output.split('\n').filter(Boolean);
        return {
          output: await budgeted(
            {
              revision: revision.sha,
              revisionKind: revision.kind,
              paths: allPaths.slice(0, limit),
              truncated: allPaths.length > limit,
            },
            remaining,
          ),
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_read',
      description:
        'Read a bounded line range from one raw file at the exact reviewed PR head or merge base. Use this for implementation context beyond the patch. Line numbers in the response are repository file line numbers.' +
        budgetDescription,
      input: v.object({
        path: relativePathSchema,
        revision: revisionSchema,
        startLine: v.optional(lineSchema),
        endLine: v.optional(lineSchema),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const { repoPath } = workspace;
        const revision = resolveWorkspaceRevision(
          workspace,
          toolInput.revision,
        );
        if (!revision) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const startLine = toolInput.startLine ?? 1;
        const requestedEnd = toolInput.endLine ?? startLine + 399;
        const endLine = Math.min(
          Math.max(startLine, requestedEnd),
          startLine + 999,
        );
        const content = await git(
          repoPath,
          ['show', `${revision.sha}:${toolInput.path}`],
          16 * 1024 * 1024,
          signal,
        );
        if (content.includes('\u0000')) {
          return {
            output: await budgeted(
              {
                revision: revision.sha,
                revisionKind: revision.kind,
                path: toolInput.path,
                binary: true,
                content: '',
              },
              remaining,
            ),
          };
        }
        const lines = content.split('\n');
        const selected = lines.slice(startLine - 1, endLine);
        return {
          output: await budgeted(
            {
              revision: revision.sha,
              revisionKind: revision.kind,
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
            },
            remaining,
          ),
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_search',
      description:
        'Search tracked text files at the exact reviewed PR head or merge base using a literal query. Results include repository file line numbers.' +
        budgetDescription,
      input: v.object({
        query: v.pipe(v.string(), v.minLength(1), v.maxLength(240)),
        path: v.optional(relativePathSchema),
        revision: revisionSchema,
        limit: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
        ),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const { repoPath } = workspace;
        const revision = resolveWorkspaceRevision(
          workspace,
          toolInput.revision,
        );
        if (!revision) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const limit = toolInput.limit ?? 100;
        const output = await git(
          repoPath,
          [
            'grep',
            '-n',
            '--full-name',
            '-I',
            '-F',
            '-e',
            toolInput.query,
            revision.sha,
            '--',
            ...(toolInput.path ? [literalPathspec(toolInput.path)] : []),
          ],
          undefined,
          signal,
        ).catch((error) => {
          signal?.throwIfAborted();
          if (isNoMatchesError(error)) return '';
          throw error;
        });
        const allMatches = output
          .split('\n')
          .filter(Boolean)
          .map((line) => line.replace(`${revision.sha}:`, ''));
        return {
          output: await budgeted(
            {
              revision: revision.sha,
              revisionKind: revision.kind,
              query: toolInput.query,
              matches: allMatches.slice(0, limit),
              truncated: allMatches.length > limit,
            },
            remaining,
          ),
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_diff',
      description:
        'Read the exact merge-base-to-PR-head diff for one file. For a large diff, pass rightLine after searching or reading the head file to verify that exact RIGHT-side line without returning the entire patch.' +
        budgetDescription,
      input: v.object({
        path: relativePathSchema,
        contextLines: v.optional(
          v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
        ),
        rightLine: v.optional(lineSchema),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const { repoPath, headSha, mergeBase } = workspace;
        if (!mergeBase) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const pathspec = await reviewDiffPathspec(
          repoPath,
          mergeBase,
          headSha,
          toolInput.path,
          signal,
        );
        if (toolInput.rightLine) {
          const targeted = await streamDiffLinesAroundRightLine(
            repoPath,
            [
              'diff',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              '--find-renames',
              `--unified=${toolInput.contextLines ?? 20}`,
              mergeBase,
              headSha,
              '--',
              ...pathspec.map(literalPathspec),
            ],
            toolInput.rightLine,
            toolInput.contextLines ?? 20,
            signal,
          );
          return {
            output: await budgeted(
              {
                available: true,
                base: mergeBase,
                head: headSha,
                path: toolInput.path,
                rightLine: toolInput.rightLine,
                targetChanged: targeted.targetChanged,
                lines: targeted.lines,
                truncated: targeted.truncated,
              },
              remaining,
            ),
          };
        }
        const patch = await git(
          repoPath,
          [
            'diff',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            '--find-renames',
            `--unified=${toolInput.contextLines ?? 20}`,
            mergeBase,
            headSha,
            '--',
            ...pathspec.map(literalPathspec),
          ],
          16 * 1024 * 1024,
          signal,
        );
        const bounded = boundText(patch, 256 * 1024);
        return {
          output: await budgeted(
            {
              available: true,
              base: mergeBase,
              head: headSha,
              path: toolInput.path,
              patch: bounded.text,
              truncated: bounded.truncated,
            },
            remaining,
          ),
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_diff_hunks',
      description:
        'Index the changed hunks for one file without returning patch bodies. Use this before a large file diff to identify relevant RIGHT-side ranges, then request targeted diff evidence.' +
        budgetDescription,
      input: v.object({
        path: relativePathSchema,
        limit: resultLimitSchema(500),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const { repoPath, headSha, mergeBase } = workspace;
        if (!mergeBase) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const pathspec = await reviewDiffPathspec(
          repoPath,
          mergeBase,
          headSha,
          toolInput.path,
          signal,
        );
        const indexed = await streamDiffHunks(
          repoPath,
          [
            'diff',
            '--no-color',
            '--no-ext-diff',
            '--no-textconv',
            '--find-renames',
            '--unified=0',
            mergeBase,
            headSha,
            '--',
            ...pathspec.map(literalPathspec),
          ],
          toolInput.limit ?? 100,
          signal,
        );
        return {
          output: await budgeted(
            {
              available: true,
              base: mergeBase,
              head: headSha,
              path: toolInput.path,
              hunks: indexed.hunks,
              totalHunks: indexed.totalHunks,
              truncated: indexed.truncated,
            },
            remaining,
          ),
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_history',
      description:
        'Read bounded Git history pinned to the reviewed head. Without a path, returns commits in the pull request; with a path, returns that file history through the reviewed head for historical context.' +
        budgetDescription,
      input: v.object({
        path: v.optional(relativePathSchema),
        limit: resultLimitSchema(50),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const { repoPath, headSha, mergeBase } = workspace;
        if (!toolInput.path && !mergeBase) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const limit = toolInput.limit ?? 20;
        const revision = toolInput.path ? headSha : `${mergeBase!}..${headSha}`;
        const output = await git(
          repoPath,
          [
            'log',
            '--no-color',
            '--no-decorate',
            ...(toolInput.path ? ['--follow'] : []),
            `--max-count=${limit + 1}`,
            '--format=%H%x1f%aI%x1f%aN%x1f%s%x1e',
            revision,
            '--',
            ...(toolInput.path ? [literalPathspec(toolInput.path)] : []),
          ],
          2 * 1024 * 1024,
          signal,
        );
        const parsedCommits = parseHistory(output);
        const commits = parsedCommits.slice(0, limit);
        return {
          output: await budgeted(
            {
              available: true,
              head: headSha,
              base: mergeBase,
              scope: toolInput.path ? 'file' : 'pull-request',
              path: toolInput.path ?? null,
              commits,
              truncated: parsedCommits.length > limit,
            },
            remaining,
          ),
        };
      },
    }),
    defineTool({
      name: 'neondeck_review_workspace_blame',
      description:
        'Read bounded Git blame attribution for raw file lines at the exact reviewed head or merge base. Use only when historical ownership or intent materially informs a finding.' +
        budgetDescription,
      input: v.object({
        path: relativePathSchema,
        revision: revisionSchema,
        startLine: lineSchema,
        endLine: v.optional(lineSchema),
      }),
      async run({ data: toolInput, signal }) {
        const workspace = await resolve(signal);
        if (!workspace.available) {
          return { output: await unavailableWorkspace(workspace.reason) };
        }
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const revision = resolveWorkspaceRevision(
          workspace,
          toolInput.revision,
        );
        if (!revision) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: 'The reviewed merge base is unavailable.',
              },
              remaining,
            ),
          };
        }
        const endLine = Math.min(
          Math.max(
            toolInput.startLine,
            toolInput.endLine ?? toolInput.startLine,
          ),
          toolInput.startLine + 199,
        );
        const output = await git(
          workspace.repoPath,
          [
            'blame',
            '--line-porcelain',
            `-L${toolInput.startLine},${endLine}`,
            revision.sha,
            '--',
            toolInput.path,
          ],
          4 * 1024 * 1024,
          signal,
        );
        return {
          output: await budgeted(
            {
              available: true,
              revision: revision.sha,
              revisionKind: revision.kind,
              path: toolInput.path,
              startLine: toolInput.startLine,
              endLine,
              lines: parseBlame(output),
            },
            remaining,
          ),
        };
      },
    }),
  ];
}

type WorkspaceRevision = { kind: 'head' | 'base'; sha: string };

function resolveWorkspaceRevision(
  workspace: PrReviewerWorkspaceToolContext,
  requested: 'head' | 'base' | undefined,
): WorkspaceRevision | null {
  if (requested === 'base') {
    return workspace.mergeBase
      ? { kind: 'base', sha: workspace.mergeBase }
      : null;
  }
  return { kind: 'head', sha: workspace.headSha };
}

type ChangedFile = {
  path: string;
  previousPath: string | null;
  status: 'added' | 'removed' | 'renamed' | 'copied' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  binary: boolean;
  generatedLike: boolean;
  kind: 'production' | 'test' | 'documentation';
};

async function readChangedFiles(
  cwd: string,
  mergeBase: string,
  headSha: string,
  signal?: AbortSignal,
) {
  const [nameStatus, numstat] = await Promise.all([
    git(
      cwd,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-status',
        '--find-renames',
        '-z',
        mergeBase,
        headSha,
        '--',
      ],
      16 * 1024 * 1024,
      signal,
    ),
    git(
      cwd,
      [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '--find-renames',
        '-z',
        mergeBase,
        headSha,
        '--',
      ],
      16 * 1024 * 1024,
      signal,
    ),
  ]);
  const statuses = parseChangedFileStatuses(nameStatus);
  const stats = parseChangedFileStats(numstat);
  const paths = [...new Set([...statuses.keys(), ...stats.keys()])].sort();
  const files: ChangedFile[] = paths.map((path) => {
    const status = statuses.get(path);
    const counts = stats.get(path) ?? {
      additions: 0,
      deletions: 0,
      binary: false,
    };
    return {
      path,
      previousPath: status?.previousPath ?? null,
      status: normalizeChangedFileStatus(status?.status ?? 'M'),
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      binary: counts.binary,
      generatedLike: generatedLike(path),
      kind: reviewFileKind(path),
    };
  });
  return {
    files,
    summary: {
      files: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      binaryFiles: files.filter((file) => file.binary).length,
      productionFiles: files.filter((file) => file.kind === 'production')
        .length,
      testFiles: files.filter((file) => file.kind === 'test').length,
      documentationFiles: files.filter((file) => file.kind === 'documentation')
        .length,
    },
  };
}

function parseChangedFileStatuses(output: string) {
  const statuses = new Map<
    string,
    { status: string; previousPath: string | null }
  >();
  const fields = output.split('\u0000');
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      const previousPath = fields[index++] ?? null;
      const path = fields[index++];
      if (path) statuses.set(path, { status, previousPath });
      continue;
    }
    const path = fields[index++];
    if (path) statuses.set(path, { status, previousPath: null });
  }
  return statuses;
}

function parseChangedFileStats(output: string) {
  const stats = new Map<
    string,
    { additions: number; deletions: number; binary: boolean }
  >();
  const fields = output.split('\u0000');
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (!header) continue;
    const [additions, deletions, pathFromHeader = ''] = header.split('\t');
    let path = pathFromHeader;
    if (!pathFromHeader) {
      index += 1;
      path = fields[index++] ?? '';
    }
    if (!path) continue;
    const binary = additions === '-' || deletions === '-';
    stats.set(path, {
      additions: binary ? 0 : Number(additions ?? 0),
      deletions: binary ? 0 : Number(deletions ?? 0),
      binary,
    });
  }
  return stats;
}

function normalizeChangedFileStatus(status: string): ChangedFile['status'] {
  if (status.startsWith('A')) return 'added';
  if (status.startsWith('D')) return 'removed';
  if (status.startsWith('R')) return 'renamed';
  if (status.startsWith('C')) return 'copied';
  return 'modified';
}

function generatedLike(path: string) {
  const name = path.split('/').at(-1) ?? path;
  return (
    name.endsWith('.lock') ||
    [
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lock',
      'Cargo.lock',
    ].includes(name)
  );
}

function reviewFileKind(path: string): ChangedFile['kind'] {
  const lower = path.toLowerCase();
  if (
    /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/.test(lower) ||
    /\.(?:test|spec)\.[^/]+$/.test(lower)
  ) {
    return 'test';
  }
  if (
    lower.startsWith('docs/') ||
    lower.startsWith('.specs/') ||
    /\.(?:md|mdx|rst|adoc)$/.test(lower)
  ) {
    return 'documentation';
  }
  return 'production';
}

type DiffHunk = {
  header: string;
  context: string | null;
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
};

async function streamDiffHunks(
  cwd: string,
  args: string[],
  limit: number,
  signal?: AbortSignal,
) {
  const hunks: DiffHunk[] = [];
  let totalHunks = 0;
  const handleLine = (line: string) => {
    const match = line.match(
      /^@@ -(?<left>\d+)(?:,(?<leftCount>\d+))? \+(?<right>\d+)(?:,(?<rightCount>\d+))? @@(?<context>.*)$/,
    );
    if (!match?.groups) return;
    totalHunks += 1;
    if (hunks.length >= limit) return;
    const boundedHeader = boundText(line, 2 * 1024);
    const boundedContext = boundText(match.groups.context.trim(), 1_000);
    hunks.push({
      header: boundedHeader.text,
      context: boundedContext.text || null,
      leftStart: Number(match.groups.left),
      leftCount: Number(match.groups.leftCount ?? 1),
      rightStart: Number(match.groups.right),
      rightCount: Number(match.groups.rightCount ?? 1),
    });
  };
  await streamGitLines(cwd, args, 2 * 1024 + 1, handleLine, signal);
  return { hunks, totalHunks, truncated: totalHunks > hunks.length };
}

function parseHistory(output: string) {
  return output
    .split('\u001e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', authoredAt = '', author = '', ...subjectParts] =
        record.split('\u001f');
      return {
        sha,
        authoredAt,
        author: boundText(author, 500).text,
        subject: boundText(subjectParts.join('\u001f'), 2_000).text,
      };
    });
}

type BlameLine = {
  commit: string;
  originalLine: number;
  line: number;
  author: string;
  authoredAt: string | null;
  summary: string;
  text: string;
  textTruncated: boolean;
};

function parseBlame(output: string) {
  const lines: BlameLine[] = [];
  let current: Omit<BlameLine, 'text' | 'textTruncated'> | undefined;
  for (const rawLine of output.split('\n')) {
    const header = rawLine.match(
      /^(?<commit>[0-9a-f]{40}) (?<original>\d+) (?<line>\d+)(?: \d+)?$/i,
    );
    if (header?.groups) {
      current = {
        commit: header.groups.commit,
        originalLine: Number(header.groups.original),
        line: Number(header.groups.line),
        author: '',
        authoredAt: null,
        summary: '',
      };
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith('author ')) {
      current.author = boundText(rawLine.slice('author '.length), 500).text;
      continue;
    }
    if (rawLine.startsWith('author-time ')) {
      const seconds = Number(rawLine.slice('author-time '.length));
      current.authoredAt = Number.isFinite(seconds)
        ? new Date(seconds * 1_000).toISOString()
        : null;
      continue;
    }
    if (rawLine.startsWith('summary ')) {
      current.summary = boundText(rawLine.slice('summary '.length), 2_000).text;
      continue;
    }
    if (rawLine.startsWith('\t')) {
      const text = boundText(rawLine.slice(1), 8 * 1024);
      lines.push({
        ...current,
        text: text.text,
        textTruncated: text.truncated,
      });
      current = undefined;
    }
  }
  return lines;
}

async function reviewDiffPathspec(
  cwd: string,
  mergeBase: string,
  headSha: string,
  path: string,
  signal?: AbortSignal,
) {
  const output = await git(
    cwd,
    [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--name-status',
      '-z',
      '--find-renames',
      mergeBase,
      headSha,
      '--',
    ],
    16 * 1024 * 1024,
    signal,
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
  signal?: AbortSignal,
) {
  const lines: TargetedDiffLine[] = [];
  let responseTruncated = false;
  let targetChanged = false;
  let leftLine = 0;
  let rightLine = 0;
  let inHunk = false;

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

  await streamGitLines(cwd, args, 8 * 1024 + 1, handleLine, signal);
  return { lines, targetChanged, truncated: responseTruncated };
}

function streamGitLines(
  cwd: string,
  args: string[],
  maxLineCharacters: number,
  onLine: (line: string, truncated: boolean) => void,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: unattendedGitEnv(),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    let terminationError: Error | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    let decoderEnded = false;
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
    const endDecoder = () => {
      if (decoderEnded) return;
      decoderEnded = true;
      consume(decoder.end());
      if (retained || truncated) emit();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: Error) => {
      if (terminationError || settled) return;
      terminationError = error;
      terminateStreamedGit(child.pid, 'SIGTERM');
      killTimeout = setTimeout(() => {
        terminateStreamedGit(child.pid, 'SIGKILL');
        finish(error);
      }, 250);
    };
    const abort = () => {
      const reason = signal?.reason;
      terminate(
        reason instanceof Error
          ? reason
          : new DOMException('Git operation aborted.', 'AbortError'),
      );
    };
    const timeout = setTimeout(
      () =>
        terminate(
          new Error(
            `git ${args.join(' ')} timed out after ${unattendedGitTimeoutMs}ms.`,
          ),
        ),
      unattendedGitTimeoutMs,
    );

    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      if (terminationError || settled) return;
      try {
        consume(decoder.write(chunk));
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdout.once('end', () => {
      if (terminationError || settled) return;
      try {
        endDecoder();
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (terminationError || settled) return;
      stderr = boundText(`${stderr}${chunk.toString()}`, 64 * 1024).text;
    });
    child.once('error', (error) => {
      if (terminationError) {
        terminateStreamedGit(child.pid, 'SIGKILL');
        finish(terminationError);
        return;
      }
      finish(error);
    });
    child.once('close', (code, childSignal) => {
      if (terminationError) {
        terminateStreamedGit(child.pid, 'SIGKILL');
        finish(terminationError);
        return;
      }
      try {
        endDecoder();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          stderr.trim() ||
            `git ${args.join(' ')} failed with ${childSignal ?? `code ${code}`}.`,
        ),
      );
    });
  });
}

function terminateStreamedGit(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  } catch {
    // The process may already have exited.
  }
}

async function git(
  cwd: string,
  args: string[],
  maxBuffer = 2 * 1024 * 1024,
  signal?: AbortSignal,
) {
  return runUnattendedGit(cwd, args, { maxBuffer, signal });
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

function literalPathspec(value: string) {
  return `:(literal)${value}`;
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
