import { defineAction, defineTool } from '@flue/runtime';
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
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import type { RuntimePaths } from '../runtime-home';
import { ensureRuntimeHome, runtimePaths } from '../runtime-home';
import { readNeonSessionState } from '../session-actions';
import { recordRepoEditEvent, listRepoEditEvents } from './audit';
import { replaceContent } from './fuzzy-replace';
import {
  countDiffLines,
  gitDiff,
  gitStatus,
  summarizeDiff,
  unifiedDiff,
} from './git';
import { withPathLocks } from './locks';
import { parseV4APatch, PatchParseError, type PatchHunk } from './patch-parser';
import {
  resolveRepoPath,
  toRepoEditError,
  type ResolvedRepoPath,
} from './path-safety';
import {
  defaultReadLimit,
  failedResult,
  invalidInputResult,
  maxReadBytes,
  repoDiffInputSchema,
  repoEditOutputSchema,
  repoPatchInputSchema,
  repoReadInputSchema,
  repoReplaceInputSchema,
  repoSearchInputSchema,
  repoStatusInputSchema,
  repoWriteInputSchema,
  type FileStamp,
  type RepoPatchInput,
} from './schemas';

type TextFile = {
  content: string;
  stamp: FileStamp;
  lineEnding: '\n' | '\r\n';
  bom: boolean;
};

type SimulatedFileState = {
  target: ResolvedRepoPath;
  content: string;
  stamp?: FileStamp;
  lineEnding?: '\n' | '\r\n';
  bom?: boolean;
  exists: boolean;
};

export const repoFileReadAction = defineAction({
  name: 'neondeck_repo_file_read',
  description:
    'Read one text file from a configured Neondeck repo using a repo-relative path. Never prompts inside declared workspaces.',
  input: repoReadInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoFile(input);
  },
});

export const repoFileSearchAction = defineAction({
  name: 'neondeck_repo_file_search',
  description:
    'Search text files in a configured Neondeck repo using rg-style deterministic search.',
  input: repoSearchInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return searchRepoFiles(input);
  },
});

export const repoFileWriteAction = defineAction({
  name: 'neondeck_repo_file_write',
  description:
    'Write a complete text file inside a configured Neondeck repo. Use for generated files or deliberate full rewrites.',
  input: repoWriteInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return writeRepoFile(input);
  },
});

export const repoFileReplaceAction = defineAction({
  name: 'neondeck_repo_file_replace',
  description:
    'Replace an exact or safe fuzzy old string with a new string inside one configured repo file.',
  input: repoReplaceInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return replaceRepoFile(input);
  },
});

export const repoFilePatchAction = defineAction({
  name: 'neondeck_repo_file_patch',
  description:
    'Apply a V4A/Codex-style multi-file patch inside a configured Neondeck repo. Validates all files before mutating.',
  input: repoPatchInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return patchRepoFiles(input);
  },
});

export const repoDiffAction = defineAction({
  name: 'neondeck_repo_diff',
  description:
    'Return git-backed diff summary and optional patch content for a configured Neondeck repo.',
  input: repoDiffInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoDiff(input);
  },
});

export const repoStatusAction = defineAction({
  name: 'neondeck_repo_checkout_status',
  description:
    'Return branch, upstream, ahead/behind, and changed file status for a configured Neondeck repo.',
  input: repoStatusInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoCheckoutStatus(input);
  },
});

export const repoDiffTool = defineTool({
  name: 'neondeck_repo_diff_lookup',
  description: 'Read git diff summary for a configured Neondeck repo.',
  input: repoDiffInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoDiff(input);
  },
});

export const repoStatusTool = defineTool({
  name: 'neondeck_repo_checkout_status_lookup',
  description: 'Read checkout status for a configured Neondeck repo.',
  input: repoStatusInputSchema,
  output: repoEditOutputSchema,
  async run({ input }) {
    return readRepoCheckoutStatus(input);
  },
});

export const neondeckRepoEditActions = [
  repoFileReadAction,
  repoFileSearchAction,
  repoFileWriteAction,
  repoFileReplaceAction,
  repoFilePatchAction,
  repoDiffAction,
  repoStatusAction,
];

export const neondeckRepoEditTools = [repoDiffTool, repoStatusTool];

export { listRepoEditEvents };

export async function readRepoFile(rawInput: unknown, paths = runtimePaths()) {
  const parsed = parseInput(repoReadInputSchema, rawInput, 'repo_file_read');
  if (!parsed.ok) return parsed.result;

  try {
    const sessionId = await resolveSessionId(parsed.input.sessionId, paths);
    const target = await resolveRepoPath(
      {
        repoId: parsed.input.repoId,
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
      target.relativePath,
      file.stamp,
      sessionId,
      paths,
    );
    await recordRepoEditEvent(
      {
        repoId: parsed.input.repoId,
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
    const target = await resolveRepoPath(
      {
        repoId: input.repoId,
        path: input.path,
        intent: 'write',
        createParentDirectories: input.createParentDirectories,
      },
      paths,
    );

    return await withPathLocks(
      [lockKey(input.repoId, target.relativePath)],
      async () => {
        const sessionId = await resolveSessionId(input.sessionId, paths);
        const before = target.exists ? await readTextFile(target) : undefined;
        const stale = before
          ? await isStaleForInput(
              input.expectedStamp,
              before.stamp,
              input.repoId,
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
    const target = await resolveRepoPath(
      {
        repoId: input.repoId,
        path: input.path,
        intent: 'write',
      },
      paths,
    );

    return await withPathLocks(
      [lockKey(input.repoId, target.relativePath)],
      async () => {
        const sessionId = await resolveSessionId(input.sessionId, paths);
        const before = await readTextFile(target);
        if (
          await isStaleForInput(
            input.expectedStamp,
            before.stamp,
            input.repoId,
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

export async function patchRepoFiles(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  const parsed = parseInput(repoPatchInputSchema, rawInput, 'repo_file_patch');
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    const patch = parseV4APatch(input.patch);
    const resolved = await resolvePatchPaths(
      input.repoId,
      patch.operations,
      paths,
    );
    const lockKeys = resolved.map((item) =>
      lockKey(input.repoId, item.relativePath),
    );

    return await withPathLocks(lockKeys, async () => {
      const sessionId = await resolveSessionId(input.sessionId, paths);
      const planned = await planPatch({ ...input, sessionId }, resolved, paths);
      if (!input.dryRun) {
        await applyPlannedPatch(planned.files);
      }
      const event = await recordRepoEditEvent(
        {
          repoId: input.repoId,
          sessionId,
          action: 'patch',
          status: input.dryRun ? 'preview' : 'applied',
          reason: input.reason,
          paths: planned.files.flatMap((file) =>
            file.destination
              ? [file.target.relativePath, file.destination.relativePath]
              : [file.target.relativePath],
          ),
          diffSummary: planned.diffSummary,
          diffPatch: planned.diff,
        },
        paths,
      );
      return {
        ok: true,
        action: 'repo_file_patch',
        changed: !input.dryRun,
        message: input.dryRun
          ? `Previewed patch touching ${planned.files.length} file(s).`
          : `Applied patch touching ${planned.files.length} file(s).`,
        repoId: input.repoId,
        dryRun: Boolean(input.dryRun),
        files: planned.files.map((file) => ({
          path: file.destination?.relativePath ?? file.target.relativePath,
          operation: file.operation,
          diff: file.diff,
          ...countDiffLines(file.diff),
        })),
        diff: planned.diff,
        diffSummary: planned.diffSummary,
        eventId: event.id,
      };
    });
  } catch (error) {
    if (error instanceof PatchParseError) {
      await recordFailureEvent('patch', error, paths, rawInput);
      return failedResult('repo_file_patch', error.message, {
        code: 'PATCH_PARSE_ERROR',
        message: error.message,
        details: { line: error.line },
      });
    }
    return failureResult('repo_file_patch', error, paths, rawInput);
  }
}

export async function readRepoDiff(rawInput: unknown, paths = runtimePaths()) {
  const parsed = parseInput(repoDiffInputSchema, rawInput, 'repo_diff');
  if (!parsed.ok) return parsed.result;
  try {
    const root = await resolveRepoPath(
      { repoId: parsed.input.repoId, path: '.', intent: 'read' },
      paths,
    );
    const result = await gitDiff(root.repoRoot, parsed.input);
    return {
      ok: true,
      action: 'repo_diff',
      changed: false,
      message: `Read diff for ${parsed.input.repoId}.`,
      repoId: parsed.input.repoId,
      base: result.base,
      files: result.files,
      diffSummary: result.summary,
    };
  } catch (error) {
    return failureResult('repo_diff', error, paths, rawInput);
  }
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
      { repoId: parsed.input.repoId, path: '.', intent: 'read' },
      paths,
    );
    const status = await gitStatus(root.repoRoot);
    return {
      ok: true,
      action: 'repo_checkout_status',
      changed: false,
      message: `Read checkout status for ${parsed.input.repoId}.`,
      repoId: parsed.input.repoId,
      ...status,
    };
  } catch (error) {
    return failureResult('repo_checkout_status', error, paths, rawInput);
  }
}

async function resolvePatchPaths(
  repoId: string,
  operations: ReturnType<typeof parseV4APatch>['operations'],
  paths: RuntimePaths,
) {
  const targets: ResolvedRepoPath[] = [];
  for (const operation of operations) {
    if (operation.type === 'move') {
      targets.push(
        await resolveRepoPath(
          { repoId, path: operation.from, intent: 'move' },
          paths,
        ),
      );
      targets.push(
        await resolveRepoPath(
          {
            repoId,
            path: operation.to,
            intent: 'write',
            createParentDirectories: true,
          },
          paths,
        ),
      );
      continue;
    }

    targets.push(
      await resolveRepoPath(
        {
          repoId,
          path: operation.path,
          intent: operation.type === 'delete' ? 'delete' : 'write',
          createParentDirectories: operation.type === 'add',
        },
        paths,
      ),
    );
  }
  return targets;
}

async function planPatch(
  input: RepoPatchInput,
  resolved: ResolvedRepoPath[],
  paths: RuntimePaths,
) {
  const patch = parseV4APatch(input.patch);
  let resolvedIndex = 0;
  const simulated = new Map<string, SimulatedFileState>();
  const files: Array<{
    operation: 'add' | 'update' | 'delete' | 'move';
    target: ResolvedRepoPath;
    destination?: ResolvedRepoPath;
    before: string;
    restoreBefore?: string;
    after: string;
    diff: string;
  }> = [];
  const stateFor = async (
    target: ResolvedRepoPath,
  ): Promise<SimulatedFileState> => {
    const existing = simulated.get(target.relativePath);
    if (existing) return existing;
    if (!target.exists) {
      const state = { target, content: '', exists: false };
      simulated.set(target.relativePath, state);
      return state;
    }
    const file = await readTextFile(target);
    const state = {
      target,
      content: file.content,
      stamp: file.stamp,
      lineEnding: file.lineEnding,
      bom: file.bom,
      exists: true,
    };
    simulated.set(target.relativePath, state);
    return state;
  };

  for (const operation of patch.operations) {
    const target = resolved[resolvedIndex++]!;
    if (operation.type === 'add') {
      const state = await stateFor(target);
      if (state.exists) {
        throw new PatchParseError(
          `Add File target already exists: ${operation.path}`,
          1,
        );
      }
      const after = operation.lines.join('\n');
      files.push({
        operation: 'add',
        target,
        before: '',
        after,
        diff: await unifiedDiff(
          target.repoRoot,
          target.relativePath,
          '',
          after,
        ),
      });
      simulated.set(target.relativePath, {
        target,
        content: after,
        exists: true,
      });
      continue;
    }

    if (operation.type === 'delete') {
      const state = await stateFor(target);
      if (!state.exists) {
        throw new PatchParseError(
          `Delete File target does not exist: ${operation.path}`,
          1,
        );
      }
      if (
        state.stamp &&
        (await isStaleForInput(
          input.expectedStamps?.[target.relativePath],
          state.stamp!,
          input.repoId,
          target.relativePath,
          input.sessionId,
          paths,
        ))
      ) {
        throw new PatchParseError(`File is stale: ${target.relativePath}`, 1);
      }
      files.push({
        operation: 'delete',
        target,
        before: state.content,
        restoreBefore: restoreContent(state),
        after: '',
        diff: await unifiedDiff(
          target.repoRoot,
          target.relativePath,
          state.content,
          '',
        ),
      });
      simulated.set(target.relativePath, {
        ...state,
        content: '',
        exists: false,
      });
      continue;
    }

    if (operation.type === 'move') {
      const destination = resolved[resolvedIndex++]!;
      const state = await stateFor(target);
      if (!state.exists) {
        throw new PatchParseError(
          `Move source does not exist: ${operation.from}`,
          1,
        );
      }
      const destinationState = await stateFor(destination);
      if (destinationState.exists) {
        throw new PatchParseError(
          `Move destination already exists: ${operation.to}`,
          1,
        );
      }
      if (
        state.stamp &&
        (await isStaleForInput(
          input.expectedStamps?.[target.relativePath],
          state.stamp!,
          input.repoId,
          target.relativePath,
          input.sessionId,
          paths,
        ))
      ) {
        throw new PatchParseError(`File is stale: ${target.relativePath}`, 1);
      }
      const after = applyHunks(state.content, operation.hunks, operation.from);
      files.push({
        operation: 'move',
        target,
        destination,
        before: state.content,
        restoreBefore: restoreContent(state),
        after,
        diff: await unifiedDiff(
          target.repoRoot,
          destination.relativePath,
          state.content,
          after,
        ),
      });
      simulated.set(target.relativePath, {
        ...state,
        content: '',
        exists: false,
      });
      simulated.set(destination.relativePath, {
        target: destination,
        content: after,
        exists: true,
      });
      continue;
    }

    const state = await stateFor(target);
    if (!state.exists) {
      throw new PatchParseError(
        `Update File target does not exist: ${operation.path}`,
        1,
      );
    }
    const expected = input.expectedStamps?.[target.relativePath];
    if (
      state.stamp &&
      (await isStaleForInput(
        expected,
        state.stamp!,
        input.repoId,
        target.relativePath,
        input.sessionId,
        paths,
      ))
    ) {
      throw new PatchParseError(`File is stale: ${target.relativePath}`, 1);
    }
    const after = applyHunks(state.content, operation.hunks, operation.path);
    const afterNormalized = state.stamp
      ? normalizeOutputContent(after, {
          content: state.content,
          stamp: state.stamp,
          lineEnding: state.lineEnding ?? '\n',
          bom: state.bom ?? false,
        })
      : after;
    files.push({
      operation: 'update',
      target,
      before: state.content,
      restoreBefore: restoreContent(state),
      after: afterNormalized,
      diff: await unifiedDiff(
        target.repoRoot,
        target.relativePath,
        state.content,
        after,
      ),
    });
    simulated.set(target.relativePath, {
      ...state,
      content: after,
      exists: true,
    });
  }

  const diff = files
    .map((file) => file.diff)
    .filter(Boolean)
    .join('\n');
  const diffSummary = summarizeDiff(
    files.map((file) => countDiffLines(file.diff)),
  );
  await ensureRuntimeHome(paths);
  return { files, diff, diffSummary };
}

async function applyPlannedPatch(
  files: Awaited<ReturnType<typeof planPatch>>['files'],
) {
  const finalWrites: Array<{ temp: string; target: string }> = [];
  const rollbackWrites: Array<{ temp: string; target: string }> = [];
  const rollbackSteps: Array<() => Promise<void>> = [];

  try {
    for (const file of files) {
      if (file.operation !== 'delete') {
        finalWrites.push(
          await stageWrite(
            file.operation === 'move'
              ? file.destination!.fullPath
              : file.target.fullPath,
            file.after,
          ),
        );
      }

      if (file.restoreBefore !== undefined) {
        rollbackWrites.push(
          await stageWrite(file.target.fullPath, file.restoreBefore),
        );
      }
    }

    let finalIndex = 0;
    let rollbackIndex = 0;
    for (const file of files) {
      if (file.operation === 'add') {
        const final = finalWrites[finalIndex++]!;
        await rename(final.temp, final.target);
        rollbackSteps.push(() => rm(final.target, { force: true }));
        await access(final.target, constants.R_OK);
        continue;
      }

      if (file.operation === 'update') {
        const final = finalWrites[finalIndex++]!;
        const rollback = rollbackWrites[rollbackIndex++]!;
        await rename(final.temp, final.target);
        rollbackSteps.push(() => commitStagedWrite(rollback));
        await access(final.target, constants.R_OK);
        continue;
      }

      if (file.operation === 'delete') {
        const rollback = rollbackWrites[rollbackIndex++]!;
        await rm(file.target.fullPath, { force: true });
        rollbackSteps.push(() => commitStagedWrite(rollback));
        continue;
      }

      const final = finalWrites[finalIndex++]!;
      const rollback = rollbackWrites[rollbackIndex++]!;
      await rename(final.temp, final.target);
      rollbackSteps.push(() => rm(final.target, { force: true }));
      await access(final.target, constants.R_OK);
      await rm(file.target.fullPath, { force: true });
      rollbackSteps.push(() => commitStagedWrite(rollback));
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const step of rollbackSteps.reverse()) {
      try {
        await step();
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
      throw Object.assign(
        new Error(
          `Patch failed and rollback was incomplete: ${rollbackErrors.join('; ')}`,
        ),
        {
          code: 'IO_ERROR',
          cause: error,
          details: { rollbackErrors },
        },
      );
    }
    throw error;
  }

  await cleanupStagedWrites(rollbackWrites);
}

function applyHunks(content: string, hunks: PatchHunk[], path: string) {
  let nextLines = content.split('\n');
  for (const [index, hunk] of hunks.entries()) {
    const oldLines = hunk.lines
      .filter((line) => line.kind === 'context' || line.kind === 'remove')
      .map((line) => line.text);
    const newLines = hunk.lines
      .filter((line) => line.kind === 'context' || line.kind === 'add')
      .map((line) => line.text);

    if (oldLines.length === 0) {
      if (!hunk.contextHint) {
        throw new PatchParseError(
          `Addition-only hunk ${index + 1} in ${path} requires a context hint.`,
          1,
        );
      }
      const location = uniqueContextLocation(nextLines, hunk.contextHint);
      if (location === undefined) {
        throw new PatchParseError(
          `Addition-only hunk ${index + 1} in ${path} has missing or ambiguous context.`,
          1,
        );
      }
      nextLines.splice(location, 0, ...newLines);
      continue;
    }

    const locations = lineBlockLocations(nextLines, oldLines);
    if (locations.length === 0) {
      throw new PatchParseError(
        `Hunk ${index + 1} context was not found in ${path}. Re-read the file and regenerate the patch.`,
        1,
      );
    }
    if (locations.length > 1) {
      throw new PatchParseError(
        `Hunk ${index + 1} context is ambiguous in ${path}. Add more surrounding context.`,
        1,
      );
    }
    nextLines.splice(locations[0]!, oldLines.length, ...newLines);
  }
  return nextLines.join('\n');
}

function lineBlockLocations(lines: string[], block: string[]) {
  const locations: number[] = [];
  if (block.length === 0) return locations;
  for (let index = 0; index <= lines.length - block.length; index += 1) {
    if (block.every((line, offset) => lines[index + offset] === line)) {
      locations.push(index);
    }
  }
  return locations;
}

function uniqueContextLocation(lines: string[], contextHint: string) {
  const hintLines = contextHint.split('\n');
  const exactMatches = lineBlockLocations(lines, hintLines);
  if (exactMatches.length === 1) return exactMatches[0]! + hintLines.length;
  if (exactMatches.length > 1 || hintLines.length > 1) return undefined;

  const containingMatches = lines
    .map((line, index) => (line.includes(contextHint) ? index : -1))
    .filter((index) => index >= 0);
  return containingMatches.length === 1 ? containingMatches[0]! + 1 : undefined;
}

async function readTextFile(target: ResolvedRepoPath): Promise<TextFile> {
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

function normalizeOutputContent(content: string, before?: TextFile) {
  const lineEnding = before?.lineEnding ?? '\n';
  const normalized = content.replace(/\r\n/g, '\n').replace(/\n/g, lineEnding);
  return before?.bom ? `\uFEFF${normalized}` : normalized;
}

async function atomicWrite(path: string, content: string) {
  const staged = await stageWrite(path, content);
  await commitStagedWrite(staged);
}

async function stageWrite(path: string, content: string) {
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

async function commitStagedWrite(staged: { temp: string; target: string }) {
  await rename(staged.temp, staged.target);
  await access(staged.target, constants.R_OK);
}

async function cleanupStagedWrites(
  stagedWrites: Array<{ temp: string; target: string }>,
) {
  await Promise.all(
    stagedWrites.map((staged) =>
      rm(staged.temp, { force: true }).catch(() => undefined),
    ),
  );
}

function restoreContent(state: SimulatedFileState) {
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

async function isStaleForInput(
  expected: FileStamp | undefined,
  actual: FileStamp,
  repoId: string,
  path: string,
  sessionId: string | undefined,
  paths: RuntimePaths,
) {
  if (expected) return isStale(expected, actual);
  if (!sessionId) return false;
  const latest = await latestReadStamp(repoId, path, sessionId, paths);
  return Boolean(latest && latest.sha256 !== actual.sha256);
}

async function latestReadStamp(
  repoId: string,
  path: string,
  sessionId: string,
  paths: RuntimePaths,
): Promise<FileStamp | undefined> {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT mtime_ms, size, sha256
        FROM repo_file_reads
        WHERE session_id = ?
          AND repo_id = ?
          AND path = ?
        ORDER BY read_at DESC
        LIMIT 1;
      `,
      )
      .get(sessionId, repoId, path) as
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

function staleResult(action: string, repoId: string, path: string) {
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

async function recordReadStamp(
  repoId: string,
  path: string,
  stamp: FileStamp,
  sessionId: string | undefined,
  paths: RuntimePaths,
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO repo_file_reads (
          session_id,
          repo_id,
          path,
          mtime_ms,
          size,
          sha256,
          partial,
          read_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        sessionId ?? null,
        repoId,
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

function lockKey(repoId: string, path: string) {
  return `${repoId}\0${path}`;
}

function parseInput<T>(
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

async function failureResult(
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

async function resolveSessionId(
  inputSessionId: string | undefined,
  paths: RuntimePaths,
) {
  if (inputSessionId) return inputSessionId;
  return readNeonSessionState(paths)
    .then((state) => state.activeSession.id)
    .catch(() => undefined);
}

async function recordFailureEvent(
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
  const converted = toRepoEditError(error);
  const requestedPaths = extractRequestedPaths(input);
  const sessionId =
    'sessionId' in input && typeof input.sessionId === 'string'
      ? input.sessionId
      : await resolveSessionId(undefined, paths);
  await recordRepoEditEvent(
    {
      repoId,
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
    'IO_ERROR',
  ].includes(value);
}

async function execRg(cwd: string, args: string[]) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync('rg', args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function safeGlobs(globs?: string[]) {
  return (globs ?? []).filter(
    (glob) =>
      glob.trim() &&
      !glob.startsWith('/') &&
      !glob.split(/[\\/]/).includes('..'),
  );
}

async function fallbackSearch(root: string, query: string, maxResults: number) {
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
