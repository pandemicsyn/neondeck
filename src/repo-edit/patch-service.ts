import { constants } from 'node:fs';
import { access, rename, rm } from 'node:fs/promises';
import { assertWorktreeMutationAllowed } from '../modules/worktrees';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../runtime-home';
import { recordRepoEditEvent } from './audit';
import { countDiffLines, summarizeDiff, unifiedDiff } from './git';
import { withPathLocks } from './locks';
import { parseV4APatch, PatchParseError, type PatchHunk } from './patch-parser';
import { resolveRepoPath, type ResolvedRepoPath } from './path-safety';
import {
  failedResult,
  repoPatchInputSchema,
  type FileStamp,
  type RepoPatchInput,
} from './schemas';
import {
  cleanupStagedWrites,
  commitStagedWrite,
  failureResult,
  isStaleForInput,
  lockKey,
  normalizeOutputContent,
  parseInput,
  readTextFile,
  recordFailureEvent,
  resolveSessionId,
  restoreContent,
  stageWrite,
} from './support';

type SimulatedFileState = {
  target: ResolvedRepoPath;
  content: string;
  stamp?: FileStamp;
  lineEnding?: '\n' | '\r\n';
  bom?: boolean;
  exists: boolean;
};

export async function patchRepoFiles(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  const parsed = parseInput(repoPatchInputSchema, rawInput, 'repo_file_patch');
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
    const patch = parseV4APatch(input.patch);
    const resolved = await resolvePatchPaths(
      input.repoId,
      input.worktreeId,
      patch.operations,
      paths,
    );
    const lockKeys = resolved.map((item) =>
      lockKey(input.repoId, input.worktreeId, item.relativePath),
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
          worktreeId: input.worktreeId,
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
        worktreeId: input.worktreeId,
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

async function resolvePatchPaths(
  repoId: string,
  worktreeId: string | undefined,
  operations: ReturnType<typeof parseV4APatch>['operations'],
  paths: RuntimePaths,
) {
  const targets: ResolvedRepoPath[] = [];
  for (const operation of operations) {
    if (operation.type === 'move') {
      targets.push(
        await resolveRepoPath(
          { repoId, worktreeId, path: operation.from, intent: 'move' },
          paths,
        ),
      );
      targets.push(
        await resolveRepoPath(
          {
            repoId,
            worktreeId,
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
          worktreeId,
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
          input.worktreeId,
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
          input.worktreeId,
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
        input.worktreeId,
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
