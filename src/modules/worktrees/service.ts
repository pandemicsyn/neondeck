import { randomUUID } from 'node:crypto';
import { currentFlueExecutionContext } from '../flue';
import { realpath } from 'node:fs/promises';
import type * as v from 'valibot';
import { invalidInputAction } from '../../lib/action-result';
import { parseInput as parseActionInput } from '../../lib/valibot';
import { ensurePreparedDiffForWorktree } from '../prepared-diffs';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import { cleanupDecision } from './cleanup';
import { WorktreeError, errorMessage, failureResult } from './errors';
import { git, gitStatus, isGitClean } from './git';
import {
  acquireLock,
  activeLocksForWorktree,
  assertNoForeignActiveLock,
  releaseLock,
  revokeLock,
  requireLock,
} from './locks';
import {
  assertAdoptableWorktree,
  defaultWorktreePath,
  ensureStorageRoot,
  exists,
  repoContext,
  repoFullName,
  resolveDeclaredWorktreePath,
  resolveStorageKind,
  validateManagedWorktreeRoot,
} from './paths';
import {
  cleanupInputSchema,
  createInputSchema,
  lockInputSchema,
  releaseInputSchema,
  statusInputSchema,
  syncInputSchema,
  type WorktreeLockRecord,
  type WorktreeRecord,
} from './schemas';
import {
  findReusableWorktree,
  listWorktreeRecords,
  recordCleanupAttempt,
  recordWorktreeCreating,
  recordWorktreeEvent,
  requireWorktree,
  updateWorktreeStatus,
  upsertWorktree,
} from './store';

export async function createWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(createInputSchema, rawInput, 'worktree_create');
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const context = await repoContext(input.repoId, paths);
    const repoRoot = await realpath(context.repo.path);
    const baseRef = input.baseRef ?? context.repo.defaultBranch;
    const headRef = input.headRef ?? input.headSha ?? baseRef;
    const existing = findReusableWorktree(
      context.repo.id,
      input.prNumber ?? null,
      headRef,
      paths,
    );
    if (existing && !input.localPath && !input.adopted) {
      return {
        ok: true,
        action: 'worktree_create',
        changed: false,
        message: `Reused worktree ${existing.id}.`,
        worktree: existing,
      };
    }

    const storageKind = resolveStorageKind(
      context.repo,
      input.storage,
      context.appDefaultStorage,
    );
    const storageRoot = await ensureStorageRoot(repoRoot, storageKind, paths);
    const localPath = input.localPath
      ? await resolveDeclaredWorktreePath(input.localPath, storageRoot)
      : await defaultWorktreePath(
          storageRoot,
          context.repo,
          input.prNumber,
          headRef,
        );
    const id = randomUUID();
    const now = new Date().toISOString();
    const adopted = Boolean(input.adopted);
    const createdBy = input.createdBy ?? (adopted ? 'user' : 'neondeck');
    const cleanupPolicy = context.appCleanup;

    if (adopted) {
      await assertAdoptableWorktree(localPath, repoRoot);
    } else {
      if (await exists(localPath)) {
        throw new WorktreeError(
          'PATH_EXISTS',
          `Worktree path already exists: ${localPath}. Pass adopted=true to adopt an existing checkout.`,
        );
      }
      recordWorktreeCreating(
        {
          id,
          repo: context.repo,
          prNumber: input.prNumber ?? null,
          baseRef,
          headOwner: input.headOwner ?? context.repo.github.owner,
          headName: input.headName ?? context.repo.github.name,
          headRef,
          headSha: input.headSha ?? null,
          localPath,
          storageKind,
          workflowRunId: input.workflowRunId ?? null,
          cleanupPolicy,
          directPushAllowed: Boolean(input.directPushAllowed),
          adopted,
          createdBy,
          now,
        },
        paths,
      );
      await recordWorktreeEvent(
        id,
        context.repo.id,
        'create_started',
        'creating',
        `Creating worktree at ${localPath}.`,
        { headRef, headSha: input.headSha ?? null },
        paths,
      );
      try {
        await git(context.repo.path, [
          'worktree',
          'add',
          '--detach',
          localPath,
          input.headSha ?? headRef,
        ]);
      } catch (error) {
        updateWorktreeStatus(id, 'failed', paths);
        await recordWorktreeEvent(
          id,
          context.repo.id,
          'create_failed',
          'failed',
          errorMessage(error),
          { headRef, headSha: input.headSha ?? null },
          paths,
        );
        throw error;
      }
    }

    const headSha = (await git(localPath, ['rev-parse', 'HEAD'])).trim();
    const record: WorktreeRecord = {
      id,
      repoId: context.repo.id,
      repoFullName: repoFullName(context.repo),
      githubOwner: context.repo.github.owner,
      githubName: context.repo.github.name,
      prNumber: input.prNumber ?? null,
      baseRef,
      headOwner: input.headOwner ?? context.repo.github.owner,
      headName: input.headName ?? context.repo.github.name,
      headRef,
      headSha,
      localPath,
      storageKind,
      owningWorkflowRunId: input.workflowRunId ?? null,
      lifecycleStatus: 'ready',
      lastSyncedSha: headSha,
      lastPushedSha: null,
      cleanupPolicy,
      directPushAllowed: Boolean(input.directPushAllowed),
      adopted,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    upsertWorktree(record, paths);
    await recordWorktreeEvent(
      id,
      context.repo.id,
      adopted ? 'adopted' : 'created',
      'ready',
      adopted
        ? `Adopted worktree ${localPath}.`
        : `Created worktree ${localPath}.`,
      { headRef, headSha },
      paths,
    );

    return {
      ok: true,
      action: 'worktree_create',
      changed: true,
      message: adopted ? `Adopted worktree ${id}.` : `Created worktree ${id}.`,
      worktree: record,
    };
  } catch (error) {
    return failureResult('worktree_create', error);
  }
}

export async function syncWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(syncInputSchema, rawInput, 'worktree_sync');
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const record = requireWorktree(input.worktreeId, paths);
    if (record.lifecycleStatus === 'deleted') {
      throw new WorktreeError('WORKTREE_DELETED', 'Worktree is deleted.');
    }
    assertNoForeignActiveLock(record, input.lockId, paths);

    const dirty = !(await isGitClean(record.localPath));
    if (dirty && !input.force) {
      updateWorktreeStatus(record.id, 'needs-sync', paths);
      await recordWorktreeEvent(
        record.id,
        record.repoId,
        'sync_blocked',
        'needs-sync',
        'Sync blocked because the worktree is dirty.',
        { dirty: true },
        paths,
      );
      return {
        ok: false,
        action: 'worktree_sync',
        changed: true,
        message: 'Worktree is dirty; sync was blocked.',
        worktree: { ...record, lifecycleStatus: 'needs-sync' },
        error: {
          code: 'DIRTY_WORKTREE',
          message: 'Worktree is dirty; sync was blocked.',
        },
      };
    }

    if (input.fetch) {
      await git(record.localPath, ['fetch', '--all', '--prune']);
    }
    const nextRef =
      input.headSha ?? input.headRef ?? record.headSha ?? record.headRef;
    const strategy = input.strategy ?? 'checkout';
    const targetHeadSha =
      strategy === 'rebase'
        ? (input.headSha ??
          (await git(record.localPath, ['rev-parse', nextRef])).trim())
        : null;
    try {
      if (strategy === 'rebase') {
        await git(record.localPath, ['rebase', nextRef]);
      } else {
        await git(record.localPath, ['checkout', '--detach', nextRef]);
      }
    } catch (error) {
      if (strategy === 'rebase') {
        updateWorktreeStatus(record.id, 'needs-sync', paths);
        await recordWorktreeEvent(
          record.id,
          record.repoId,
          'sync_blocked',
          'needs-sync',
          `Rebase/resync blocked: ${errorMessage(error)}`,
          { strategy, ref: nextRef, error: errorMessage(error) },
          paths,
        );
      }
      throw error;
    }
    const localHeadSha = (
      await git(record.localPath, ['rev-parse', 'HEAD'])
    ).trim();
    const headSha = targetHeadSha ?? localHeadSha;
    const now = new Date().toISOString();
    const next = {
      ...record,
      headRef: input.headRef ?? record.headRef,
      headSha,
      lastSyncedSha: localHeadSha,
      lifecycleStatus: 'ready' as const,
      updatedAt: now,
    };
    upsertWorktree(next, paths);
    await recordWorktreeEvent(
      record.id,
      record.repoId,
      'synced',
      'ready',
      `Synced worktree ${record.id} to ${headSha.slice(0, 12)}.`,
      { headSha, localHeadSha, strategy },
      paths,
    );

    return {
      ok: true,
      action: 'worktree_sync',
      changed: headSha !== record.headSha || next.headRef !== record.headRef,
      message: `Synced worktree ${record.id}.`,
      worktree: next,
    };
  } catch (error) {
    return failureResult('worktree_sync', error);
  }
}

export async function readWorktreeStatus(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(statusInputSchema, rawInput, 'worktree_status');
  if (!parsed.ok) return parsed.result;

  try {
    await ensureRuntimeHome(paths);
    const record = requireWorktree(parsed.input.worktreeId, paths);
    const gitState =
      record.lifecycleStatus === 'deleted'
        ? null
        : await gitStatus(record.localPath, record.baseRef);
    const locks = activeLocksForWorktree(record, paths);
    const now = Date.now();

    return {
      ok: true,
      action: 'worktree_status',
      changed: false,
      message: `Read worktree ${record.id}.`,
      worktree: record,
      git: gitState,
      locks: locks.map((lock) => ({
        ...lock,
        stale: Date.parse(lock.expiresAt) <= now,
      })),
    };
  } catch (error) {
    return failureResult('worktree_status', error);
  }
}

export async function lockWorktree(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(lockInputSchema, rawInput, 'worktree_lock');
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const scope = input.scope ?? (input.prNumber ? 'pr' : 'worktree');
    const record = input.worktreeId
      ? requireWorktree(input.worktreeId, paths)
      : undefined;
    const repoId = record?.repoId ?? input.repoId;
    const prNumber = record?.prNumber ?? input.prNumber ?? null;
    if (!repoId) {
      throw new WorktreeError(
        'INVALID_INPUT',
        'repoId is required when locking without worktreeId.',
      );
    }
    if (scope === 'worktree' && !record) {
      throw new WorktreeError(
        'INVALID_INPUT',
        'worktreeId is required for worktree-scoped locks.',
      );
    }
    if (scope === 'pr' && prNumber === null) {
      throw new WorktreeError(
        'INVALID_INPUT',
        'prNumber is required for PR-scoped locks.',
      );
    }

    const scopeKey =
      scope === 'worktree'
        ? `worktree:${record!.id}`
        : `pr:${repoId}:${prNumber}`;
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + (input.ttlSeconds ?? 3_600) * 1000,
    ).toISOString();
    const createdAt = now.toISOString();
    const lock: WorktreeLockRecord = {
      id: randomUUID(),
      scope,
      scopeKey,
      worktreeId: record?.id ?? null,
      repoId,
      prNumber,
      owner: input.owner,
      workflowRunId:
        input.workflowRunId ?? currentFlueExecutionContext()?.runId ?? null,
      expiresAt,
      revokedAt: null,
      releasedAt: null,
      staleRecoveredAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const acquired = acquireLock(lock, now, paths);
    if (!acquired.ok) {
      return {
        ok: false,
        action: 'worktree_lock',
        changed: false,
        message: `Lock is already held by ${acquired.active.owner}.`,
        lock: acquired.active,
        error: {
          code: 'LOCKED',
          message: `Lock is already held by ${acquired.active.owner}.`,
        },
      };
    }
    if (acquired.recovered) {
      await recordWorktreeEvent(
        record?.id ?? acquired.recovered.worktreeId ?? 'none',
        repoId,
        'stale_lock_recovered',
        record?.lifecycleStatus ?? 'ready',
        `Recovered stale ${scope} lock ${acquired.recovered.id}.`,
        { lockId: acquired.recovered.id, owner: acquired.recovered.owner },
        paths,
      );
    }
    if (record) updateWorktreeStatus(record.id, 'busy', paths);
    if (record) {
      await recordWorktreeEvent(
        record.id,
        record.repoId,
        'locked',
        'busy',
        `Acquired ${scope} lock ${lock.id}.`,
        { lockId: lock.id, owner: lock.owner, expiresAt },
        paths,
      );
    }

    return {
      ok: true,
      action: 'worktree_lock',
      changed: true,
      message: `Acquired ${scope} lock ${lock.id}.`,
      lock,
    };
  } catch (error) {
    return failureResult('worktree_lock', error);
  }
}

export async function revokeWorktreeLockLease(
  lockId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const lock = requireLock(lockId, paths);
  if (lock.releasedAt || lock.revokedAt) return lock;
  const now = new Date().toISOString();
  revokeLock(lock.id, now, paths);
  return requireLock(lock.id, paths);
}

export function readWorktreeLock(
  lockId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return requireLock(lockId, paths);
}

export async function releaseWorktreeLock(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(releaseInputSchema, rawInput, 'worktree_release');
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const lock = requireLock(input.lockId, paths);
    if (lock.releasedAt) {
      return {
        ok: true,
        action: 'worktree_release',
        changed: false,
        message: `Lock ${lock.id} was already released.`,
        lock,
      };
    }
    if (input.owner && input.owner !== lock.owner) {
      throw new WorktreeError(
        'LOCK_OWNER_MISMATCH',
        `Lock ${lock.id} is owned by ${lock.owner}.`,
      );
    }
    const now = new Date().toISOString();
    releaseLock(lock.id, now, paths);
    let worktree: WorktreeRecord | undefined;
    if (lock.worktreeId) {
      worktree = requireWorktree(lock.worktreeId, paths);
      const finalStatus = input.finalStatus ?? 'ready';
      updateWorktreeStatus(worktree.id, finalStatus, paths);
      await recordWorktreeEvent(
        worktree.id,
        worktree.repoId,
        'released',
        finalStatus,
        `Released lock ${lock.id}.`,
        { lockId: lock.id, finalStatus },
        paths,
      );
      worktree = requireWorktree(worktree.id, paths);
      if (finalStatus === 'prepared-diff') {
        await ensurePreparedDiffForWorktree(worktree, paths, {
          createdBy: lock.owner,
          resetDecisionState: true,
        });
      }
    }

    return {
      ok: true,
      action: 'worktree_release',
      changed: true,
      message: `Released lock ${lock.id}.`,
      lock: { ...lock, releasedAt: now, updatedAt: now },
      worktree,
    };
  } catch (error) {
    return failureResult('worktree_release', error);
  }
}

export async function cleanupWorktrees(
  rawInput: unknown,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = parseInput(cleanupInputSchema, rawInput, 'worktree_cleanup');
  if (!parsed.ok) return parsed.result;
  const input = parsed.input;

  try {
    await ensureRuntimeHome(paths);
    const records = input.worktreeId
      ? [requireWorktree(input.worktreeId, paths)]
      : listWorktreeRecords(paths).filter(
          (record) => record.lifecycleStatus !== 'deleted',
        );
    const results = [];
    let changed = false;

    for (const record of records) {
      const decision = await cleanupDecision(record, input, paths);
      if (!decision.delete) {
        recordCleanupAttempt(
          record,
          input.dryRun ? 'dry-run-retained' : 'retained',
          decision.reason,
          false,
          undefined,
          paths,
        );
        results.push({
          worktreeId: record.id,
          outcome: 'retained',
          ...decision,
        });
        continue;
      }

      if (input.dryRun) {
        recordCleanupAttempt(
          record,
          'dry-run-delete',
          decision.reason,
          false,
          undefined,
          paths,
        );
        results.push({
          worktreeId: record.id,
          outcome: 'dry-run-delete',
          ...decision,
        });
        continue;
      }

      const cleanupOwner = `cleanup:${randomUUID()}`;
      const acquired = await lockWorktree(
        {
          worktreeId: record.id,
          scope: record.prNumber === null ? 'worktree' : 'pr',
          owner: cleanupOwner,
          ttlSeconds: 300,
        },
        paths,
      );
      if (!acquired.ok || !('lock' in acquired)) {
        const reason = 'worktree became locked before cleanup';
        recordCleanupAttempt(
          record,
          'retained',
          reason,
          false,
          undefined,
          paths,
        );
        results.push({
          worktreeId: record.id,
          outcome: 'retained',
          delete: false,
          reason,
        });
        continue;
      }

      const cleanupLock = acquired.lock;
      try {
        const context = await repoContext(record.repoId, paths);
        if (await exists(record.localPath)) {
          if (record.adopted) {
            await assertAdoptableWorktree(record.localPath, context.repo.path);
          } else {
            await validateManagedWorktreeRoot(record, paths);
          }
          if (!(await isGitClean(record.localPath))) {
            throw new WorktreeError(
              'WORKTREE_DIRTY',
              `Worktree ${record.id} became dirty before cleanup.`,
            );
          }
        }
        await git(context.repo.path, ['worktree', 'remove', record.localPath]);
      } catch (error) {
        recordCleanupAttempt(
          record,
          'failed',
          decision.reason,
          false,
          errorMessage(error),
          paths,
        );
        updateWorktreeStatus(record.id, 'cleanup-pending', paths);
        results.push({
          worktreeId: record.id,
          outcome: 'failed',
          reason: decision.reason,
          error: errorMessage(error),
        });
        continue;
      } finally {
        releaseLock(cleanupLock.id, new Date().toISOString(), paths);
      }

      changed = true;
      updateWorktreeStatus(record.id, 'deleted', paths);
      recordCleanupAttempt(
        record,
        'deleted',
        decision.reason,
        true,
        undefined,
        paths,
      );
      await recordWorktreeEvent(
        record.id,
        record.repoId,
        'deleted',
        'deleted',
        `Deleted worktree ${record.id}.`,
        { reason: decision.reason },
        paths,
      );
      results.push({ worktreeId: record.id, outcome: 'deleted', ...decision });
    }

    return {
      ok: true,
      action: 'worktree_cleanup',
      changed,
      message: `Evaluated ${records.length} worktree(s) for cleanup.`,
      results,
    };
  } catch (error) {
    return failureResult('worktree_cleanup', error);
  }
}

function parseInput<T>(
  schema: v.GenericSchema<unknown, T>,
  rawInput: unknown,
  action: string,
):
  | { ok: true; input: T }
  | { ok: false; result: ReturnType<typeof invalidInputResult> } {
  return parseActionInput(
    schema,
    rawInput,
    (message) => invalidInputResult(action, message),
    (issues) => issues[0]?.message ?? 'Invalid input.',
  );
}

const invalidInputResult = invalidInputAction;
