import { assertWorktreeMutationAllowed } from '../modules/worktrees';
import {
  reviewRevisionKey,
  type ReviewRevision,
} from '../../shared/review-source';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import { recordRepoEditEvent } from './audit';
import { replaceContent } from './fuzzy-replace';
import {
  countDiffLines,
  gitDiff,
  gitStatus,
  gitWorktreeRevision,
  summarizeDiff,
  unifiedDiff,
} from './git';
import { readStableDiffMetadata } from './stable-diff';
import { withPathLocks } from './locks';
import { resolveRepoPath, type ResolvedRepoPath } from './path-safety';
import type { FileStamp } from './schemas';
import {
  defaultReadLimit,
  failedResult,
  repoDiffInputSchema,
  repoReadInputSchema,
  repoReplaceInputSchema,
  repoSearchInputSchema,
  repoStatusInputSchema,
  repoWriteInputSchema,
} from './schemas';
import {
  atomicWrite,
  cleanupStagedWrites,
  commitStagedWrite,
  execRg,
  failureResult,
  fallbackSearch,
  isStaleForInput,
  lockKey,
  normalizeOutputContent,
  parseInput,
  readTextFile,
  recordReadStamp,
  restoreContent,
  resolveSessionId,
  safeGlobs,
  stageWrite,
  staleResult,
} from './support';

export async function readRepoFile(rawInput: unknown, paths = runtimePaths()) {
  const parsed = parseInput(repoReadInputSchema, rawInput, 'repo_file_read');
  if (!parsed.ok) return parsed.result;

  try {
    const sessionId = await resolveSessionId(parsed.input.sessionId, paths);
    const target = await resolveRepoPath(
      {
        repoId: parsed.input.repoId,
        worktreeId: parsed.input.worktreeId,
        path: parsed.input.path,
        intent: 'read',
      },
      paths,
    );
    const file = await readTextFile(target);
    const lines = file.content.split('\n');
    const offset = parsed.input.offset ?? 0;
    const limit = parsed.input.limit ?? defaultReadLimit;
    const window = lines.slice(offset, offset + limit);
    const content = parsed.input.includeLineNumbers
      ? window.map((line, index) => `${offset + index + 1}: ${line}`).join('\n')
      : window.join('\n');
    const truncated = offset + limit < lines.length;

    await recordReadStamp(
      parsed.input.repoId,
      parsed.input.worktreeId,
      target.relativePath,
      file.stamp,
      sessionId,
      paths,
    );
    await recordRepoEditEvent(
      {
        repoId: parsed.input.repoId,
        worktreeId: parsed.input.worktreeId,
        sessionId,
        action: 'read',
        status: 'applied',
        paths: [target.relativePath],
      },
      paths,
    );

    return {
      ok: true,
      action: 'repo_file_read',
      changed: false,
      message: `Read ${target.relativePath}.`,
      repoId: parsed.input.repoId,
      worktreeId: parsed.input.worktreeId,
      path: target.relativePath,
      content,
      startLine: offset + 1,
      endLine: offset + window.length,
      totalLines: lines.length,
      truncated,
      binary: false,
      sizeBytes: file.stamp.size,
      stamp: file.stamp,
    };
  } catch (error) {
    return failureResult('repo_file_read', error, paths, rawInput);
  }
}

export async function searchRepoFiles(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  const parsed = parseInput(
    repoSearchInputSchema,
    rawInput,
    'repo_file_search',
  );
  if (!parsed.ok) return parsed.result;

  try {
    const sessionId = await resolveSessionId(undefined, paths);
    const root = await resolveRepoPath(
      {
        repoId: parsed.input.repoId,
        worktreeId: parsed.input.worktreeId,
        path: '.',
        intent: 'read',
      },
      paths,
    ).then((value) => value.repoRoot);
    const maxResults = parsed.input.maxResults ?? 50;
    const args = [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      String(maxResults),
      parsed.input.query,
      ...safeGlobs(parsed.input.globs).flatMap((glob) => ['--glob', glob]),
    ];
    const output = await execRg(root, args).catch((error) => {
      if (error && typeof error === 'object' && 'stdout' in error) {
        return String((error as { stdout?: unknown }).stdout ?? '');
      }
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        return fallbackSearch(root, parsed.input.query, maxResults);
      }
      throw error;
    });
    const results = output
      .split('\n')
      .filter(Boolean)
      .slice(0, maxResults)
      .map((line) => {
        const [path = '', lineNumber = '0', ...rest] = line.split(':');
        return {
          path,
          line: Number(lineNumber),
          preview: rest.join(':').slice(0, 500),
        };
      });

    await recordRepoEditEvent(
      {
        repoId: parsed.input.repoId,
        worktreeId: parsed.input.worktreeId,
        sessionId,
        action: 'search',
        status: 'applied',
        paths: [],
        reason: parsed.input.query,
      },
      paths,
    );

    return {
      ok: true,
      action: 'repo_file_search',
      changed: false,
      message: `Found ${results.length} matches.`,
      repoId: parsed.input.repoId,
      worktreeId: parsed.input.worktreeId,
      results,
      truncated: results.length >= maxResults,
    };
  } catch (error) {
    return failureResult('repo_file_search', error, paths, rawInput);
  }
}

export async function writeRepoFile(rawInput: unknown, paths = runtimePaths()) {
  const parsed = parseInput(repoWriteInputSchema, rawInput, 'repo_file_write');
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    assertWorktreeMutationAllowed(
      {
        repoId: input.repoId,
        worktreeId: input.worktreeId,
        lockId: input.worktreeLockId,
      },
      paths,
    );
    const target = await resolveRepoPath(
      {
        repoId: input.repoId,
        worktreeId: input.worktreeId,
        path: input.path,
        intent: 'write',
        createParentDirectories: input.createParentDirectories,
      },
      paths,
    );

    return await withPathLocks(
      [lockKey(input.repoId, input.worktreeId, target.relativePath)],
      async () => {
        const sessionId = await resolveSessionId(input.sessionId, paths);
        const before = target.exists ? await readTextFile(target) : undefined;
        const stale = before
          ? await isStaleForInput(
              input.expectedStamp,
              before.stamp,
              input.repoId,
              input.worktreeId,
              target.relativePath,
              sessionId,
              paths,
            )
          : false;
        if (stale) {
          return staleResult(
            'repo_file_write',
            input.repoId,
            target.relativePath,
          );
        }
        const nextContent = normalizeOutputContent(input.content, before);
        const diff = await unifiedDiff(
          target.repoRoot,
          target.relativePath,
          before?.content ?? '',
          nextContent,
        );
        const lineCounts = countDiffLines(diff);
        const diffSummary = summarizeDiff([lineCounts]);
        if (!input.dryRun) {
          await atomicWrite(target.fullPath, nextContent);
        }
        const event = await recordRepoEditEvent(
          {
            repoId: input.repoId,
            worktreeId: input.worktreeId,
            sessionId,
            action: 'write',
            status: input.dryRun ? 'preview' : 'applied',
            reason: input.reason,
            paths: [target.relativePath],
            diffSummary,
            diffPatch: diff,
          },
          paths,
        );
        return {
          ok: true,
          action: 'repo_file_write',
          changed: !input.dryRun,
          message: input.dryRun
            ? `Previewed write to ${target.relativePath}.`
            : `Wrote ${target.relativePath}.`,
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          path: target.relativePath,
          dryRun: Boolean(input.dryRun),
          sensitive: target.sensitive,
          generatedLike: target.generatedLike,
          diff,
          diffSummary,
          eventId: event.id,
        };
      },
    );
  } catch (error) {
    return failureResult('repo_file_write', error, paths, rawInput);
  }
}

export async function replaceRepoFile(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  const parsed = parseInput(
    repoReplaceInputSchema,
    rawInput,
    'repo_file_replace',
  );
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    assertWorktreeMutationAllowed(
      {
        repoId: input.repoId,
        worktreeId: input.worktreeId,
        lockId: input.worktreeLockId,
      },
      paths,
    );
    const target = await resolveRepoPath(
      {
        repoId: input.repoId,
        worktreeId: input.worktreeId,
        path: input.path,
        intent: 'write',
      },
      paths,
    );

    return await withPathLocks(
      [lockKey(input.repoId, input.worktreeId, target.relativePath)],
      async () => {
        const sessionId = await resolveSessionId(input.sessionId, paths);
        const before = await readTextFile(target);
        if (
          await isStaleForInput(
            input.expectedStamp,
            before.stamp,
            input.repoId,
            input.worktreeId,
            target.relativePath,
            sessionId,
            paths,
          )
        ) {
          return staleResult(
            'repo_file_replace',
            input.repoId,
            target.relativePath,
          );
        }
        const replaced = replaceContent(before.content, input);
        if (!replaced.ok) {
          await recordRepoEditEvent(
            {
              repoId: input.repoId,
              worktreeId: input.worktreeId,
              sessionId,
              action: 'replace',
              status: 'failed',
              reason: input.reason,
              paths: [target.relativePath],
              error: {
                code: replaced.code,
                message: replaced.message,
                candidates: replaced.candidates,
              },
            },
            paths,
          );
          return failedResult('repo_file_replace', replaced.message, {
            code: replaced.code,
            message: replaced.message,
            path: target.relativePath,
            details: { candidates: replaced.candidates },
          });
        }
        const nextContent = normalizeOutputContent(replaced.content, before);
        const diff = await unifiedDiff(
          target.repoRoot,
          target.relativePath,
          before.content,
          nextContent,
        );
        const diffSummary = summarizeDiff([countDiffLines(diff)]);
        if (!input.dryRun) {
          await atomicWrite(target.fullPath, nextContent);
        }
        const event = await recordRepoEditEvent(
          {
            repoId: input.repoId,
            worktreeId: input.worktreeId,
            sessionId,
            action: 'replace',
            status: input.dryRun ? 'preview' : 'applied',
            reason: input.reason,
            paths: [target.relativePath],
            diffSummary,
            diffPatch: diff,
          },
          paths,
        );
        return {
          ok: true,
          action: 'repo_file_replace',
          changed: !input.dryRun,
          message: input.dryRun
            ? `Previewed replacement in ${target.relativePath}.`
            : `Replaced ${replaced.replacements} occurrence(s) in ${target.relativePath}.`,
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          path: target.relativePath,
          matched: replaced.matched,
          replacements: replaced.replacements,
          dryRun: Boolean(input.dryRun),
          sensitive: target.sensitive,
          generatedLike: target.generatedLike,
          diff,
          diffSummary,
          eventId: event.id,
        };
      },
    );
  } catch (error) {
    return failureResult('repo_file_replace', error, paths, rawInput);
  }
}

export async function replaceRepoFilesAtomically(
  input: {
    repoId: string;
    worktreeId: string;
    worktreeLockId?: string;
    replacements: Array<{
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
      fuzzy?: 'off' | 'safe';
    }>;
    expectedStamps: Record<string, FileStamp>;
    dryRun?: boolean;
    reason?: string;
  },
  paths = runtimePaths(),
  dependencies: {
    beforeExternalMutation?: (effect: {
      paths: string[];
      bytes: number;
      lines: number;
    }) => void | Promise<void>;
  } = {},
) {
  try {
    await ensureRuntimeHome(paths);
    assertWorktreeMutationAllowed(
      {
        repoId: input.repoId,
        worktreeId: input.worktreeId,
        lockId: input.worktreeLockId,
      },
      paths,
    );
    const targets = new Map<string, ResolvedRepoPath>();
    for (const replacement of input.replacements) {
      if (!targets.has(replacement.path)) {
        targets.set(
          replacement.path,
          await resolveRepoPath(
            {
              repoId: input.repoId,
              worktreeId: input.worktreeId,
              path: replacement.path,
              intent: 'write',
            },
            paths,
          ),
        );
      }
    }
    const lockKeys = [...targets.values()].map((target) =>
      lockKey(input.repoId, input.worktreeId, target.relativePath),
    );
    return await withPathLocks(lockKeys, async () => {
      const sessionId = await resolveSessionId(undefined, paths);
      const files = new Map<
        string,
        {
          target: ResolvedRepoPath;
          before: Awaited<ReturnType<typeof readTextFile>>;
          content: string;
          replacements: number;
        }
      >();
      for (const target of targets.values()) {
        const before = await readTextFile(target);
        if (
          await isStaleForInput(
            input.expectedStamps[target.relativePath],
            before.stamp,
            input.repoId,
            input.worktreeId,
            target.relativePath,
            sessionId,
            paths,
          )
        ) {
          return staleResult(
            'repo_files_replace',
            input.repoId,
            target.relativePath,
          );
        }
        files.set(target.relativePath, {
          target,
          before,
          content: before.content,
          replacements: 0,
        });
      }
      for (const replacement of input.replacements) {
        const file = files.get(replacement.path)!;
        const replaced = replaceContent(file.content, replacement);
        if (!replaced.ok) {
          return failedResult('repo_files_replace', replaced.message, {
            code: replaced.code,
            message: replaced.message,
            path: replacement.path,
            details: { candidates: replaced.candidates },
          });
        }
        file.content = replaced.content;
        file.replacements += replaced.replacements;
      }
      const planned = await Promise.all(
        [...files.values()].map(async (file) => {
          const after = normalizeOutputContent(file.content, file.before);
          const diff = await unifiedDiff(
            file.target.repoRoot,
            file.target.relativePath,
            file.before.content,
            after,
          );
          return { ...file, after, diff };
        }),
      );
      const written: typeof planned = [];
      if (!input.dryRun) {
        const effect = {
          paths: planned.map((file) => file.target.relativePath),
          bytes: planned.reduce(
            (total, file) =>
              total +
              Buffer.byteLength(file.before.content) +
              Buffer.byteLength(file.after),
            0,
          ),
          lines: planned.reduce((total, file) => {
            const count = countDiffLines(file.diff);
            return total + count.additions + count.deletions;
          }, 0),
        };
        await dependencies.beforeExternalMutation?.(effect);
        assertWorktreeMutationAllowed(
          {
            repoId: input.repoId,
            worktreeId: input.worktreeId,
            lockId: input.worktreeLockId,
          },
          paths,
        );
        const finalWrites: Array<Awaited<ReturnType<typeof stageWrite>>> = [];
        const rollbackWrites: Array<Awaited<ReturnType<typeof stageWrite>>> =
          [];
        try {
          for (const file of planned) {
            finalWrites.push(
              await stageWrite(file.target.fullPath, file.after),
            );
            rollbackWrites.push(
              await stageWrite(
                file.target.fullPath,
                restoreContent(file.before),
              ),
            );
          }
          for (let index = 0; index < planned.length; index += 1) {
            const file = planned[index]!;
            written.push(file);
            await dependencies.beforeExternalMutation?.(effect);
            assertWorktreeMutationAllowed(
              {
                repoId: input.repoId,
                worktreeId: input.worktreeId,
                lockId: input.worktreeLockId,
              },
              paths,
            );
            await commitStagedWrite(finalWrites[index]!);
          }
        } catch (error) {
          const rollbackErrors: string[] = [];
          for (let index = written.length - 1; index >= 0; index -= 1) {
            try {
              await commitStagedWrite(rollbackWrites[index]!);
            } catch (rollbackError) {
              rollbackErrors.push(
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
              );
            }
          }
          await cleanupStagedWrites([...finalWrites, ...rollbackWrites]);
          if (rollbackErrors.length > 0) {
            throw new Error(
              `Atomic replacement failed and rollback was incomplete: ${rollbackErrors.join('; ')}`,
              { cause: error },
            );
          }
          throw error;
        }
        await cleanupStagedWrites([...finalWrites, ...rollbackWrites]);
      }
      const diffSummary = summarizeDiff(
        planned.map((file) => countDiffLines(file.diff)),
      );
      const event = await recordRepoEditEvent(
        {
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          sessionId,
          action: 'replace',
          status: input.dryRun ? 'preview' : 'applied',
          reason: input.reason,
          paths: planned.map((file) => file.target.relativePath),
          diffSummary,
          diffPatch: planned.map((file) => file.diff).join('\n'),
        },
        paths,
      );
      return {
        ok: true,
        action: 'repo_files_replace',
        changed: !input.dryRun && planned.some((file) => file.diff.length > 0),
        message: `${input.dryRun ? 'Previewed' : 'Applied'} ${input.replacements.length} replacement(s) atomically.`,
        files: planned.map((file) => ({
          path: file.target.relativePath,
          replacements: file.replacements,
          ...countDiffLines(file.diff),
        })),
        diffSummary,
        eventId: event.id,
      };
    });
  } catch (error) {
    return failureResult('repo_files_replace', error, paths, input);
  }
}

export async function readRepoDiff(
  rawInput: unknown,
  paths = runtimePaths(),
  dependencies: {
    gitDiff?: typeof gitDiff;
    gitWorktreeRevision?: typeof gitWorktreeRevision;
  } = {},
) {
  const parsed = parseInput(repoDiffInputSchema, rawInput, 'repo_diff');
  if (!parsed.ok) return parsed.result;
  try {
    const root = await resolveRepoPath(
      {
        repoId: parsed.input.repoId,
        worktreeId: parsed.input.worktreeId,
        path: '.',
        intent: 'read',
      },
      paths,
    );
    const readDiff = dependencies.gitDiff ?? gitDiff;
    const readRevision =
      dependencies.gitWorktreeRevision ?? gitWorktreeRevision;
    const scopedPatch = Boolean(
      parsed.input.paths?.length && parsed.input.includePatch,
    );
    if (!scopedPatch) {
      const stable = await readStableDiffMetadata(
        root.repoRoot,
        parsed.input,
        dependencies,
      );
      if (!stable.stable) {
        return staleRepoDiffPatch(parsed.input, stable.revision);
      }
      return {
        ok: true,
        action: 'repo_diff',
        changed: false,
        message: `Read diff for ${parsed.input.repoId}.`,
        repoId: parsed.input.repoId,
        worktreeId: parsed.input.worktreeId,
        base: stable.diff.base,
        revision: stable.revision,
        files: stable.diff.files,
        diffSummary: stable.diff.summary,
      };
    }
    const beforeMetadata = scopedPatch
      ? await readDiff(root.repoRoot, {
          base: parsed.input.base,
          includePatch: false,
        })
      : null;
    const beforeRevision = beforeMetadata
      ? await readRevision(root.repoRoot, {
          base: beforeMetadata.base,
          files: beforeMetadata.files,
        })
      : null;
    if (
      beforeRevision &&
      parsed.input.expectedRevisionKey !== reviewRevisionKey(beforeRevision)
    ) {
      return staleRepoDiffPatch(parsed.input, beforeRevision);
    }
    const result = await readDiff(root.repoRoot, parsed.input);
    const revisionMetadata = parsed.input.paths?.length
      ? await readDiff(root.repoRoot, {
          base: parsed.input.base,
          includePatch: false,
        })
      : result;
    const revision = await readRevision(root.repoRoot, {
      base: revisionMetadata.base,
      files: revisionMetadata.files,
    });
    if (
      (parsed.input.expectedRevisionKey &&
        parsed.input.expectedRevisionKey !== reviewRevisionKey(revision)) ||
      (beforeRevision &&
        reviewRevisionKey(beforeRevision) !== reviewRevisionKey(revision))
    ) {
      return staleRepoDiffPatch(parsed.input, revision);
    }
    return {
      ok: true,
      action: 'repo_diff',
      changed: false,
      message: `Read diff for ${parsed.input.repoId}.`,
      repoId: parsed.input.repoId,
      worktreeId: parsed.input.worktreeId,
      base: result.base,
      revision,
      files: result.files,
      diffSummary: result.summary,
    };
  } catch (error) {
    return failureResult('repo_diff', error, paths, rawInput);
  }
}

function staleRepoDiffPatch(
  input: { repoId: string; worktreeId?: string },
  revision: ReviewRevision,
) {
  return {
    ok: false as const,
    action: 'repo_diff',
    changed: false,
    message: 'The worktree changed before this diff could be used.',
    repoId: input.repoId,
    worktreeId: input.worktreeId,
    revision,
    requires: ['refresh'],
    errors: ['The requested revision is stale.'],
  };
}

export async function readRepoCheckoutStatus(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  const parsed = parseInput(
    repoStatusInputSchema,
    rawInput,
    'repo_checkout_status',
  );
  if (!parsed.ok) return parsed.result;
  try {
    const root = await resolveRepoPath(
      {
        repoId: parsed.input.repoId,
        worktreeId: parsed.input.worktreeId,
        path: '.',
        intent: 'read',
      },
      paths,
    );
    const status = await gitStatus(root.repoRoot);
    return {
      ok: true,
      action: 'repo_checkout_status',
      changed: false,
      message: `Read checkout status for ${parsed.input.repoId}.`,
      repoId: parsed.input.repoId,
      worktreeId: parsed.input.worktreeId,
      ...status,
    };
  } catch (error) {
    return failureResult('repo_checkout_status', error, paths, rawInput);
  }
}
