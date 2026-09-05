import { defineTool, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import {
  runtimePaths,
  type RuntimePaths,
  type RepoConfig,
} from '../../runtime-home';
import { ensureLocalPullRequestRevisions } from '../pr-local-diffs';
import { readRepoRegistrySnapshot, repoFullName } from '../repos';
import {
  readPrReviewWorkspaceOutput,
  retainPrReviewWorkspaceOutput,
  type PrReviewWorkspaceOutputScope,
} from './workspace-outputs';
import {
  boundWorkspaceGitText,
  literalWorkspacePathspec as literalPathspec,
  parseWorkspaceBlame as parseBlame,
  parseWorkspaceHistory as parseHistory,
  readWorkspaceChangedFiles as readChangedFiles,
  resolveWorkspaceDiffPathspec as reviewDiffPathspec,
  runWorkspaceGit as git,
  streamWorkspaceDiffHunks as streamDiffHunks,
  streamWorkspaceDiffLinesAroundRightLine as streamDiffLinesAroundRightLine,
} from './workspace-git';

export type PrReviewerWorkspaceTarget = {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha?: string | null;
  baseRef?: string | null;
};

export const prReviewerWorkspaceToolCallLimit = 500;

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
const retainedOutputRefSchema = v.pipe(v.string(), v.trim(), v.uuid());
const workspacePreviewMaxLines = 2_000;
const workspacePreviewMaxBytes = 50 * 1024;

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
      tools: createPrReviewerWorkspaceTools(
        {
          repoPath: repo.path,
          headSha,
          mergeBase,
        },
        {
          retainedOutput: {
            key: `resolved:${repoFullName(repo)}:${target.prNumber}:${headSha}`,
            paths,
          },
        },
      ),
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
    retainedOutput?: PrReviewWorkspaceOutputScope;
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
    retainedOutput?: PrReviewWorkspaceOutputScope;
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
    retainedOutput?: PrReviewWorkspaceOutputScope;
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
  const retainOutput = (source: 'diff' | 'list' | 'search', text: string) => {
    const unavailable = (outputHint: string) => ({
      outputRetained: false as const,
      outputBytes: Buffer.byteLength(text, 'utf8'),
      outputLines: countLines(text),
      outputHint,
    });
    if (!options.retainedOutput) {
      return unavailable(
        'Durable retained output is unavailable for this workspace. Narrow the original request.',
      );
    }
    try {
      return retainPrReviewWorkspaceOutput({
        scope: options.retainedOutput,
        source,
        text,
      });
    } catch {
      return unavailable(
        'The full output could not be retained, but the bounded preview is still valid. Continue from the preview or narrow the original request.',
      );
    }
  };
  const budgetDescription = ` This call shares a hard ${prReviewerWorkspaceToolCallLimit}-call exploration budget with the other exact-revision workspace tools.`;
  return [
    defineTool({
      name: 'neondeck_review_workspace_output',
      description:
        'Search or read a targeted slice of a full output retained by a previous truncated review-workspace list, search, or diff call. Use the opaque outputRef returned by that call instead of repeating the broad operation. Line reads return only complete source lines, and nextStartLine identifies the precise continuation point. An individual source line larger than the preview limit is unavailable through line reads; search the retained output or narrow the original source request instead.' +
        budgetDescription,
      input: v.object({
        outputRef: retainedOutputRefSchema,
        query: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(240))),
        startLine: v.optional(lineSchema),
        endLine: v.optional(lineSchema),
        limit: resultLimitSchema(500),
      }),
      async run({ data: toolInput }) {
        const remaining = consumeToolCall();
        if (remaining === null) return { output: await exhausted() };
        const retained = options.retainedOutput
          ? readPrReviewWorkspaceOutput({
              scope: options.retainedOutput,
              outputRef: toolInput.outputRef,
            })
          : null;
        if (!retained) {
          return {
            output: await budgeted(
              {
                available: false,
                reason:
                  'This retained output is unavailable or has been evicted. Repeat the narrowest possible source request.',
              },
              remaining,
            ),
          };
        }
        const lines = retained.text.split('\n');
        if (toolInput.query) {
          const limit = toolInput.limit ?? 100;
          const matches: string[] = [];
          let totalMatches = 0;
          for (let index = 0; index < lines.length; index += 1) {
            if (!lines[index]!.includes(toolInput.query)) continue;
            totalMatches += 1;
            if (matches.length >= limit) continue;
            matches.push(
              `${String(index + 1).padStart(6, ' ')}\t${lines[index]}`,
            );
          }
          const preview = boundLineItems(matches, limit);
          return {
            output: await budgeted(
              {
                available: true,
                source: retained.source,
                query: toolInput.query,
                matches: preview.items,
                totalMatches,
                outputLines: retained.lines,
                outputBytes: retained.bytes,
                truncated:
                  preview.truncated || preview.items.length < totalMatches,
              },
              remaining,
            ),
          };
        }
        const startLine = Math.min(
          toolInput.startLine ?? 1,
          Math.max(1, lines.length),
        );
        const requestedEnd = toolInput.endLine ?? startLine + 399;
        const endLine = Math.min(
          Math.max(startLine, requestedEnd),
          startLine + 999,
          lines.length,
        );
        const selected = lines
          .slice(startLine - 1, endLine)
          .map(
            (line, index) =>
              `${String(startLine + index).padStart(6, ' ')}\t${line}`,
          );
        const preview = boundCompleteLineItems(selected, selected.length);
        if (preview.oversizedFirstItem) {
          return {
            output: await budgeted(
              {
                available: false,
                reason: `Source line ${startLine} exceeds the retained-output line-read preview limit. Search this outputRef for a specific token or repeat the original source request with a narrower scope.`,
                source: retained.source,
                oversizedLine: startLine,
                totalLines: retained.lines,
                outputBytes: retained.bytes,
              },
              remaining,
            ),
          };
        }
        const representedEndLine =
          startLine + Math.max(0, preview.items.length - 1);
        const nextStartLine =
          representedEndLine < lines.length ? representedEndLine + 1 : null;
        return {
          output: await budgeted(
            {
              available: true,
              source: retained.source,
              startLine,
              endLine: representedEndLine,
              endLineComplete: true,
              nextStartLine,
              totalLines: retained.lines,
              outputBytes: retained.bytes,
              content: preview.items.join('\n'),
              truncated: preview.truncated || endLine < lines.length,
            },
            remaining,
          ),
        };
      },
    }),
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
          16 * 1024 * 1024,
          signal,
        );
        const allPaths = output.split('\n').filter(Boolean);
        const preview = boundLineItems(allPaths, limit);
        const truncated =
          preview.truncated || preview.items.length < allPaths.length;
        return {
          output: await budgeted(
            {
              revision: revision.sha,
              revisionKind: revision.kind,
              paths: preview.items,
              truncated,
              ...(truncated ? retainOutput('list', allPaths.join('\n')) : {}),
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
          16 * 1024 * 1024,
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
        const preview = boundLineItems(allMatches, limit);
        const truncated =
          preview.truncated || preview.items.length < allMatches.length;
        return {
          output: await budgeted(
            {
              revision: revision.sha,
              revisionKind: revision.kind,
              query: toolInput.query,
              matches: preview.items,
              truncated,
              ...(truncated
                ? retainOutput('search', allMatches.join('\n'))
                : {}),
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
        const bounded = boundWorkspacePreview(patch);
        return {
          output: await budgeted(
            {
              available: true,
              base: mergeBase,
              head: headSha,
              path: toolInput.path,
              patch: bounded.text,
              truncated: bounded.truncated,
              ...(bounded.truncated ? retainOutput('diff', patch) : {}),
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

function countLines(value: string) {
  if (!value) return 0;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function boundWorkspacePreview(value: string) {
  const lines = value.split('\n');
  const lineBounded = lines.slice(0, workspacePreviewMaxLines).join('\n');
  const byteBounded = boundWorkspaceGitText(
    lineBounded,
    workspacePreviewMaxBytes,
  );
  return {
    text: byteBounded.text,
    truncated: byteBounded.truncated || lines.length > workspacePreviewMaxLines,
  };
}

function boundLineItems(items: string[], requestedLimit: number) {
  const selected: string[] = [];
  let bytes = 0;
  let truncated = false;
  let lastItemTruncated = false;
  const itemLimit = Math.min(requestedLimit, workspacePreviewMaxLines);
  for (const item of items) {
    if (selected.length >= itemLimit) {
      truncated = true;
      break;
    }
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const itemBytes = Buffer.byteLength(item, 'utf8');
    const remaining = workspacePreviewMaxBytes - bytes - separatorBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (itemBytes > remaining) {
      selected.push(boundWorkspaceGitText(item, remaining).text);
      truncated = true;
      lastItemTruncated = true;
      break;
    }
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items: selected, truncated, lastItemTruncated };
}

function boundCompleteLineItems(items: string[], requestedLimit: number) {
  const selected: string[] = [];
  let bytes = 0;
  let truncated = false;
  const itemLimit = Math.min(requestedLimit, workspacePreviewMaxLines);
  for (const item of items) {
    if (selected.length >= itemLimit) {
      truncated = true;
      break;
    }
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const itemBytes = Buffer.byteLength(item, 'utf8');
    if (bytes + separatorBytes + itemBytes > workspacePreviewMaxBytes) {
      truncated = true;
      break;
    }
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return {
    items: selected,
    truncated,
    oversizedFirstItem: truncated && selected.length === 0,
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
