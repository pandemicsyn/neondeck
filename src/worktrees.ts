import { defineAction, defineTool } from '@flue/runtime';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { ensurePreparedDiffForWorktree } from './prepared-diffs';
import {
  type RepoConfig,
  type RuntimePaths,
  type WorktreeCleanupConfig,
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';

const execFileAsync = promisify(execFile);

export type WorktreeStorageKind = 'home' | 'repo-local';
export type WorktreeLockScope = 'worktree' | 'pr';
export type WorktreeLifecycleStatus =
  | 'creating'
  | 'ready'
  | 'busy'
  | 'stale'
  | 'needs-sync'
  | 'failed'
  | 'prepared-diff'
  | 'succeeded'
  | 'cleanup-pending'
  | 'deleted';

export type WorktreeRecord = {
  id: string;
  repoId: string;
  repoFullName: string;
  githubOwner: string;
  githubName: string;
  prNumber: number | null;
  baseRef: string;
  headOwner: string | null;
  headName: string | null;
  headRef: string;
  headSha: string | null;
  localPath: string;
  storageKind: WorktreeStorageKind;
  owningWorkflowRunId: string | null;
  lifecycleStatus: WorktreeLifecycleStatus;
  lastSyncedSha: string | null;
  lastPushedSha: string | null;
  cleanupPolicy: WorktreeCleanupPolicy;
  directPushAllowed: boolean;
  adopted: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeLockRecord = {
  id: string;
  scope: WorktreeLockScope;
  scopeKey: string;
  worktreeId: string | null;
  repoId: string;
  prNumber: number | null;
  owner: string;
  workflowRunId: string | null;
  expiresAt: string;
  releasedAt: string | null;
  staleRecoveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorktreeCleanupPolicy = {
  retainFailed: boolean;
  retainPreparedDiff: boolean;
  successfulGraceHours: number;
  staleAgeHours: number;
};

type RepoContext = {
  repo: RepoConfig;
  appDefaultStorage: WorktreeStorageKind | undefined;
  appCleanup: WorktreeCleanupPolicy;
};

const lifecycleStatusSchema = v.picklist([
  'creating',
  'ready',
  'busy',
  'stale',
  'needs-sync',
  'failed',
  'prepared-diff',
  'succeeded',
  'cleanup-pending',
  'deleted',
]);
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const repoIdSchema = nonEmptyStringSchema;
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const safeGitRefSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    return (
      !value.startsWith('-') &&
      !value.includes('\u0000') &&
      !/[\s\\~^:?*[\]]/.test(value)
    );
  }, 'Expected a safe git ref or SHA.'),
);
const outputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

const createInputSchema = v.object({
  repoId: repoIdSchema,
  prNumber: v.optional(positiveIntegerSchema),
  baseRef: v.optional(safeGitRefSchema),
  headOwner: v.optional(nonEmptyStringSchema),
  headName: v.optional(nonEmptyStringSchema),
  headRef: v.optional(safeGitRefSchema),
  headSha: v.optional(safeGitRefSchema),
  localPath: v.optional(nonEmptyStringSchema),
  storage: v.optional(v.picklist(['home', 'repo-local'])),
  adopted: v.optional(v.boolean()),
  workflowRunId: v.optional(nonEmptyStringSchema),
  directPushAllowed: v.optional(v.boolean()),
  createdBy: v.optional(v.picklist(['neondeck', 'user', 'external'])),
});

const syncInputSchema = v.object({
  worktreeId: nonEmptyStringSchema,
  lockId: v.optional(nonEmptyStringSchema),
  headRef: v.optional(safeGitRefSchema),
  headSha: v.optional(safeGitRefSchema),
  fetch: v.optional(v.boolean()),
  force: v.optional(v.boolean()),
});

const statusInputSchema = v.object({
  worktreeId: nonEmptyStringSchema,
});

const lockInputSchema = v.object({
  worktreeId: v.optional(nonEmptyStringSchema),
  repoId: v.optional(repoIdSchema),
  prNumber: v.optional(positiveIntegerSchema),
  scope: v.optional(v.picklist(['worktree', 'pr'])),
  owner: nonEmptyStringSchema,
  workflowRunId: v.optional(nonEmptyStringSchema),
  ttlSeconds: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(30), v.maxValue(86_400)),
  ),
});

const releaseInputSchema = v.object({
  lockId: nonEmptyStringSchema,
  owner: v.optional(nonEmptyStringSchema),
  finalStatus: v.optional(
    v.picklist([
      'ready',
      'stale',
      'needs-sync',
      'failed',
      'prepared-diff',
      'succeeded',
      'cleanup-pending',
    ]),
  ),
});

const cleanupInputSchema = v.object({
  worktreeId: v.optional(nonEmptyStringSchema),
  dryRun: v.optional(v.boolean()),
  confirmAdopted: v.optional(v.boolean()),
});
const rowNullableStringSchema = v.nullable(v.string());
const rowNullableNumberSchema = v.nullable(v.number());
const worktreeCleanupPolicySchema = v.object({
  retainFailed: v.optional(v.boolean()),
  retainPreparedDiff: v.optional(v.boolean()),
  successfulGraceHours: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  staleAgeHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
const worktreeRowSchema = v.object({
  id: v.string(),
  repo_id: v.string(),
  repo_full_name: v.string(),
  github_owner: v.string(),
  github_name: v.string(),
  pr_number: rowNullableNumberSchema,
  base_ref: v.string(),
  head_owner: rowNullableStringSchema,
  head_name: rowNullableStringSchema,
  head_ref: v.string(),
  head_sha: rowNullableStringSchema,
  local_path: v.string(),
  storage_kind: v.string(),
  owning_workflow_run_id: rowNullableStringSchema,
  lifecycle_status: v.string(),
  last_synced_sha: rowNullableStringSchema,
  last_pushed_sha: rowNullableStringSchema,
  cleanup_policy_json: rowNullableStringSchema,
  direct_push_allowed: v.number(),
  adopted: v.number(),
  created_by: v.string(),
  created_at: v.string(),
  updated_at: v.string(),
});
const lockRowSchema = v.object({
  id: v.string(),
  scope: v.string(),
  scope_key: v.string(),
  worktree_id: rowNullableStringSchema,
  repo_id: v.string(),
  pr_number: rowNullableNumberSchema,
  owner: v.string(),
  workflow_run_id: rowNullableStringSchema,
  expires_at: v.string(),
  released_at: rowNullableStringSchema,
  stale_recovered_at: rowNullableStringSchema,
  created_at: v.string(),
  updated_at: v.string(),
});
const cleanupAttemptRowSchema = v.object({
  id: v.string(),
  worktree_id: v.string(),
  repo_id: v.string(),
  action: v.string(),
  outcome: v.string(),
  reason: v.string(),
  error: rowNullableStringSchema,
  deleted: v.number(),
  attempted_at: v.string(),
});

export const worktreeCreateAction = defineAction({
  name: 'neondeck_worktree_create',
  description:
    'Create or adopt a Neondeck-managed Git worktree inside declared worktree roots for isolated repo or PR work.',
  input: createInputSchema,
  output: outputSchema,
  async run({ input }) {
    return createWorktree(input);
  },
});

export const worktreeSyncAction = defineAction({
  name: 'neondeck_worktree_sync',
  description:
    'Safely update a Neondeck-managed worktree to a requested head ref or SHA. Refuses dirty worktrees unless force is true.',
  input: syncInputSchema,
  output: outputSchema,
  async run({ input }) {
    return syncWorktree(input);
  },
});

export const worktreeStatusAction = defineAction({
  name: 'neondeck_worktree_status',
  description:
    'Read branch, dirty state, HEAD SHA, base SHA, and lock status for one Neondeck-managed worktree.',
  input: statusInputSchema,
  output: outputSchema,
  async run({ input }) {
    return readWorktreeStatus(input);
  },
});

export const worktreeLockAction = defineAction({
  name: 'neondeck_worktree_lock',
  description:
    'Acquire a per-worktree or per-PR lock with expiration and stale-lock recovery.',
  input: lockInputSchema,
  output: outputSchema,
  async run({ input }) {
    return lockWorktree(input);
  },
});

export const worktreeReleaseAction = defineAction({
  name: 'neondeck_worktree_release',
  description:
    'Release a Neondeck worktree lock and optionally record the bounded workflow final status.',
  input: releaseInputSchema,
  output: outputSchema,
  async run({ input }) {
    return releaseWorktreeLock(input);
  },
});

export const worktreeCleanupAction = defineAction({
  name: 'neondeck_worktree_cleanup',
  description:
    'Apply Neondeck worktree cleanup policy. Retains dirty, failed, prepared-diff, and adopted worktrees unless policy/input allows cleanup.',
  input: cleanupInputSchema,
  output: outputSchema,
  async run({ input }) {
    return cleanupWorktrees(input);
  },
});

export const worktreesLookupTool = defineTool({
  name: 'neondeck_worktrees_lookup',
  description:
    'List Neondeck worktree records, active and stale locks, and cleanup failures without mutating state.',
  input: v.object({}),
  output: outputSchema,
  async run() {
    return listWorktrees();
  },
});

export const neondeckWorktreeActions = [
  worktreeCreateAction,
  worktreeSyncAction,
  worktreeStatusAction,
  worktreeLockAction,
  worktreeReleaseAction,
  worktreeCleanupAction,
];

export const neondeckWorktreeTools = [worktreesLookupTool];

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
    await git(record.localPath, ['checkout', '--detach', nextRef]);
    const headSha = (await git(record.localPath, ['rev-parse', 'HEAD'])).trim();
    const now = new Date().toISOString();
    const next = {
      ...record,
      headRef: input.headRef ?? record.headRef,
      headSha,
      lastSyncedSha: headSha,
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
      { headSha },
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
      workflowRunId: input.workflowRunId ?? null,
      expiresAt,
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
          summary: {
            lockId: lock.id,
            workflowRunId: lock.workflowRunId,
            preparedAt: now,
          },
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

      try {
        const context = await repoContext(record.repoId, paths);
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

export async function listWorktrees(paths: RuntimePaths = runtimePaths()) {
  await ensureRuntimeHome(paths);
  const worktrees = listWorktreeRecords(paths);
  const locks = listLockRecords(paths);
  const now = Date.now();
  const activeLocks = locks.filter((lock) => !lock.releasedAt);
  const staleLocks = activeLocks.filter(
    (lock) => Date.parse(lock.expiresAt) <= now,
  );
  const cleanupFailures = listCleanupFailures(paths);

  return {
    ok: true,
    action: 'worktrees_list',
    changed: false,
    message: `Read ${worktrees.length} worktree record(s).`,
    worktrees,
    activeLocks,
    staleLocks,
    cleanupFailures,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readManagedWorktree(
  worktreeId: string,
  repoId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const record = requireWorktree(worktreeId, paths);
  if (record.repoId !== repoId) {
    throw new WorktreeError(
      'REPO_MISMATCH',
      `Worktree ${worktreeId} belongs to repo ${record.repoId}, not ${repoId}.`,
    );
  }
  if (record.lifecycleStatus === 'deleted') {
    throw new WorktreeError(
      'WORKTREE_DELETED',
      `Worktree ${worktreeId} is deleted.`,
    );
  }
  if (
    ![
      'ready',
      'busy',
      'needs-sync',
      'stale',
      'prepared-diff',
      'succeeded',
      'failed',
      'cleanup-pending',
    ].includes(record.lifecycleStatus)
  ) {
    throw new WorktreeError(
      'WORKTREE_NOT_READY',
      `Worktree ${worktreeId} is not ready for repo operations.`,
    );
  }
  await validateManagedWorktreeRoot(record, paths);
  return record;
}

export function listActiveRepoWorktrees(
  repoId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return listWorktreeRecords(paths).filter(
    (record) =>
      record.repoId === repoId && record.lifecycleStatus !== 'deleted',
  );
}

export function assertWorktreeMutationAllowed(
  input: { repoId: string; worktreeId?: string; lockId?: string },
  paths: RuntimePaths = runtimePaths(),
) {
  if (!input.worktreeId) return;
  const record = requireWorktree(input.worktreeId, paths);
  if (record.repoId !== input.repoId) {
    throw new WorktreeError(
      'REPO_MISMATCH',
      `Worktree ${record.id} belongs to repo ${record.repoId}, not ${input.repoId}.`,
    );
  }
  assertNoForeignActiveLock(record, input.lockId, paths);
}

class WorktreeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
  }
}

async function validateManagedWorktreeRoot(
  record: WorktreeRecord,
  paths: RuntimePaths,
) {
  const context = await repoContext(record.repoId, paths);
  const sourceRepoRoot = await realpath(context.repo.path);
  const storageRoot =
    record.storageKind === 'repo-local'
      ? await realpath(resolve(sourceRepoRoot, '.neondeck', 'worktrees'))
      : await realpath(paths.worktrees);
  const rootStat = await lstat(record.localPath);
  if (rootStat.isSymbolicLink()) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree root must not be a symlink: ${record.localPath}.`,
    );
  }
  const root = await realpath(record.localPath);
  if (!isInside(storageRoot, root)) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree root resolves outside declared root ${storageRoot}.`,
    );
  }
  const [sourceCommon, targetCommon] = await Promise.all([
    gitCommonDir(sourceRepoRoot),
    gitCommonDir(root),
  ]);
  if (sourceCommon !== targetCommon) {
    throw new WorktreeError(
      'REPO_MISMATCH',
      'Managed worktree no longer shares git common dir with the configured repo.',
    );
  }
}

function assertNoForeignActiveLock(
  record: WorktreeRecord,
  lockId: string | undefined,
  paths: RuntimePaths,
) {
  const now = Date.now();
  const locks = activeLocksForWorktree(record, paths).filter(
    (lock) => Date.parse(lock.expiresAt) > now,
  );
  if (locks.length === 0) return;
  if (lockId && locks.some((lock) => lock.id === lockId)) return;
  throw new WorktreeError(
    'WORKTREE_LOCKED',
    `Worktree ${record.id} has an active lock held by ${locks[0]!.owner}.`,
  );
}

async function repoContext(
  repoId: string,
  paths: RuntimePaths,
): Promise<RepoContext> {
  await ensureRuntimeHome(paths);
  const [registry, config] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find((item) => item.id === repoId);
  if (!repo) {
    throw new WorktreeError(
      'REPO_NOT_FOUND',
      `Repository "${repoId}" is not configured.`,
    );
  }

  return {
    repo,
    appDefaultStorage: config.worktrees?.defaultStorage,
    appCleanup: cleanupPolicy(config.worktrees?.cleanup),
  };
}

function cleanupPolicy(config?: WorktreeCleanupConfig): WorktreeCleanupPolicy {
  return {
    retainFailed: config?.retainFailed ?? true,
    retainPreparedDiff: config?.retainPreparedDiff ?? true,
    successfulGraceHours: config?.successfulGraceHours ?? 24,
    staleAgeHours: config?.staleAgeHours ?? 168,
  };
}

function resolveStorageKind(
  repo: RepoConfig,
  requested: WorktreeStorageKind | undefined,
  configuredDefault: WorktreeStorageKind | undefined,
): WorktreeStorageKind {
  return requested ?? repo.worktreeRoot ?? configuredDefault ?? 'home';
}

async function ensureStorageRoot(
  repoRoot: string,
  storage: WorktreeStorageKind,
  paths: RuntimePaths,
) {
  const root =
    storage === 'repo-local'
      ? resolve(repoRoot, '.neondeck', 'worktrees')
      : paths.worktrees;
  await mkdir(root, { recursive: true });
  return realpath(root);
}

async function resolveDeclaredWorktreePath(input: string, root: string) {
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const parent = await nearestExistingAncestor(candidate);
  if (!isInside(root, parent) || !isInside(root, candidate)) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree path must stay inside declared root ${root}.`,
    );
  }
  const existing = await realpath(candidate).catch(() => undefined);
  if (existing && !isInside(root, existing)) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree path resolves outside declared root ${root}.`,
    );
  }
  return candidate;
}

async function defaultWorktreePath(
  root: string,
  repo: RepoConfig,
  prNumber: number | undefined,
  headRef: string,
) {
  const base = slug(
    [
      repo.github.owner,
      repo.github.name,
      prNumber ? `pr-${prNumber}` : 'worktree',
      headRef.split('/').at(-1) ?? headRef,
    ].join('-'),
  );
  let candidate = resolve(root, base);
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = resolve(root, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

async function assertAdoptableWorktree(
  localPath: string,
  sourceRepoRoot: string,
) {
  const root = (await git(localPath, ['rev-parse', '--show-toplevel'])).trim();
  if (resolve(root) !== resolve(localPath)) {
    throw new WorktreeError(
      'INVALID_WORKTREE',
      `Adopted path must be the git worktree root: ${localPath}.`,
    );
  }
  const [sourceCommon, targetCommon] = await Promise.all([
    gitCommonDir(sourceRepoRoot),
    gitCommonDir(localPath),
  ]);
  if (sourceCommon !== targetCommon) {
    throw new WorktreeError(
      'REPO_MISMATCH',
      'Adopted worktree does not share git common dir with the configured repo.',
    );
  }
}

async function gitCommonDir(cwd: string) {
  const raw = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim();
  const full = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return realpath(full);
}

async function gitStatus(localPath: string, baseRef: string) {
  const [branch, headSha, baseSha, porcelain] = await Promise.all([
    git(localPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then((value) =>
      value.trim(),
    ),
    git(localPath, ['rev-parse', 'HEAD']).then((value) => value.trim()),
    git(localPath, ['rev-parse', baseRef])
      .then((value) => value.trim())
      .catch(() => null),
    git(localPath, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  const changes = porcelain.split('\n').filter(Boolean);
  return {
    branch,
    headSha,
    baseSha,
    dirty: changes.length > 0,
    changeCount: changes.length,
    changes: changes.slice(0, 50),
  };
}

async function isGitClean(localPath: string) {
  const status = await git(localPath, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  return status.trim().length === 0;
}

async function cleanupDecision(
  record: WorktreeRecord,
  input: { confirmAdopted?: boolean },
  paths: RuntimePaths,
): Promise<{ delete: boolean; reason: string }> {
  const policy = await currentCleanupPolicy(record, paths);
  if (record.lifecycleStatus === 'deleted') {
    return { delete: false, reason: 'already deleted' };
  }
  if (record.adopted && !input.confirmAdopted) {
    return {
      delete: false,
      reason: 'adopted worktrees require explicit confirmation',
    };
  }
  if (record.lifecycleStatus === 'failed' && policy.retainFailed) {
    return { delete: false, reason: 'failed worktrees are retained by policy' };
  }
  if (record.lifecycleStatus === 'prepared-diff' && policy.retainPreparedDiff) {
    return {
      delete: false,
      reason: 'prepared-diff worktrees are retained by policy',
    };
  }
  const activeLock = activeLocksForWorktree(record, paths).find(
    (lock) => Date.parse(lock.expiresAt) > Date.now(),
  );
  if (activeLock) {
    return { delete: false, reason: `active lock ${activeLock.id} is held` };
  }
  if (await exists(record.localPath)) {
    const clean = await isGitClean(record.localPath).catch(() => false);
    if (!clean) return { delete: false, reason: 'worktree is dirty' };
  }
  const ageHours =
    (Date.now() - Date.parse(record.updatedAt)) / (60 * 60 * 1000);
  if (
    record.lifecycleStatus === 'succeeded' &&
    ageHours >= policy.successfulGraceHours
  ) {
    return { delete: true, reason: 'successful grace period elapsed' };
  }
  const staleCleanupStatuses = [
    'stale',
    'needs-sync',
    'cleanup-pending',
    ...(policy.retainFailed ? [] : ['failed']),
    ...(policy.retainPreparedDiff ? [] : ['prepared-diff']),
  ];
  if (
    staleCleanupStatuses.includes(record.lifecycleStatus) &&
    ageHours >= policy.staleAgeHours
  ) {
    return { delete: true, reason: 'stale age threshold elapsed' };
  }
  return { delete: false, reason: 'cleanup policy retained worktree' };
}

async function currentCleanupPolicy(
  record: WorktreeRecord,
  paths: RuntimePaths,
) {
  try {
    return (await repoContext(record.repoId, paths)).appCleanup;
  } catch {
    return record.cleanupPolicy;
  }
}

function recordWorktreeCreating(
  input: {
    id: string;
    repo: RepoConfig;
    prNumber: number | null;
    baseRef: string;
    headOwner: string;
    headName: string;
    headRef: string;
    headSha: string | null;
    localPath: string;
    storageKind: WorktreeStorageKind;
    workflowRunId: string | null;
    cleanupPolicy: WorktreeCleanupPolicy;
    directPushAllowed: boolean;
    adopted: boolean;
    createdBy: string;
    now: string;
  },
  paths: RuntimePaths,
) {
  upsertWorktree(
    {
      id: input.id,
      repoId: input.repo.id,
      repoFullName: repoFullName(input.repo),
      githubOwner: input.repo.github.owner,
      githubName: input.repo.github.name,
      prNumber: input.prNumber,
      baseRef: input.baseRef,
      headOwner: input.headOwner,
      headName: input.headName,
      headRef: input.headRef,
      headSha: input.headSha,
      localPath: input.localPath,
      storageKind: input.storageKind,
      owningWorkflowRunId: input.workflowRunId,
      lifecycleStatus: 'creating',
      lastSyncedSha: null,
      lastPushedSha: null,
      cleanupPolicy: input.cleanupPolicy,
      directPushAllowed: input.directPushAllowed,
      adopted: input.adopted,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    },
    paths,
  );
}

function upsertWorktree(record: WorktreeRecord, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO worktrees (
          id, repo_id, repo_full_name, github_owner, github_name, pr_number,
          base_ref, head_owner, head_name, head_ref, head_sha, local_path,
          storage_kind, owning_workflow_run_id, lifecycle_status,
          last_synced_sha, last_pushed_sha, cleanup_policy_json,
          direct_push_allowed, adopted, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          repo_id = excluded.repo_id,
          repo_full_name = excluded.repo_full_name,
          github_owner = excluded.github_owner,
          github_name = excluded.github_name,
          pr_number = excluded.pr_number,
          base_ref = excluded.base_ref,
          head_owner = excluded.head_owner,
          head_name = excluded.head_name,
          head_ref = excluded.head_ref,
          head_sha = excluded.head_sha,
          local_path = excluded.local_path,
          storage_kind = excluded.storage_kind,
          owning_workflow_run_id = excluded.owning_workflow_run_id,
          lifecycle_status = excluded.lifecycle_status,
          last_synced_sha = excluded.last_synced_sha,
          last_pushed_sha = excluded.last_pushed_sha,
          cleanup_policy_json = excluded.cleanup_policy_json,
          direct_push_allowed = excluded.direct_push_allowed,
          adopted = excluded.adopted,
          created_by = excluded.created_by,
          updated_at = excluded.updated_at;
      `,
      )
      .run(
        record.id,
        record.repoId,
        record.repoFullName,
        record.githubOwner,
        record.githubName,
        record.prNumber,
        record.baseRef,
        record.headOwner,
        record.headName,
        record.headRef,
        record.headSha,
        record.localPath,
        record.storageKind,
        record.owningWorkflowRunId,
        record.lifecycleStatus,
        record.lastSyncedSha,
        record.lastPushedSha,
        JSON.stringify(record.cleanupPolicy),
        record.directPushAllowed ? 1 : 0,
        record.adopted ? 1 : 0,
        record.createdBy,
        record.createdAt,
        record.updatedAt,
      );
  } finally {
    database.close();
  }
}

function updateWorktreeStatus(
  id: string,
  status: WorktreeLifecycleStatus,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE worktrees
        SET lifecycle_status = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(status, new Date().toISOString(), id);
  } finally {
    database.close();
  }
}

async function recordWorktreeEvent(
  worktreeId: string,
  repoId: string,
  eventType: string,
  status: WorktreeLifecycleStatus,
  message: string,
  data: unknown,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO worktree_events (
          id, worktree_id, repo_id, event_type, status, message, data_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        worktreeId,
        repoId,
        eventType,
        status,
        message,
        data === undefined ? null : JSON.stringify(data),
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

function recordCleanupAttempt(
  record: WorktreeRecord,
  outcome: string,
  reason: string,
  deleted: boolean,
  error: string | undefined,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO worktree_cleanup_attempts (
          id, worktree_id, repo_id, action, outcome, reason, error, deleted, attempted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        record.id,
        record.repoId,
        'cleanup',
        outcome,
        reason,
        error ?? null,
        deleted ? 1 : 0,
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
}

function findReusableWorktree(
  repoId: string,
  prNumber: number | null,
  headRef: string,
  paths: RuntimePaths,
) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM worktrees
        WHERE repo_id = ?
          AND COALESCE(pr_number, -1) = COALESCE(?, -1)
          AND head_ref = ?
          AND lifecycle_status != 'deleted'
        ORDER BY updated_at DESC
        LIMIT 1;
      `,
      )
      .get(repoId, prNumber, headRef);
    return row ? readWorktreeRow(row) : undefined;
  } finally {
    database.close();
  }
}

function requireWorktree(id: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM worktrees WHERE id = ?;')
      .get(id);
    if (!row) {
      throw new WorktreeError(
        'WORKTREE_NOT_FOUND',
        `Worktree ${id} was not found.`,
      );
    }
    return readWorktreeRow(row);
  } finally {
    database.close();
  }
}

function listWorktreeRecords(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM worktrees
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all()
      .map(readWorktreeRow);
  } finally {
    database.close();
  }
}

function acquireLock(
  lock: WorktreeLockRecord,
  now: Date,
  paths: RuntimePaths,
):
  | { ok: true; lock: WorktreeLockRecord; recovered?: WorktreeLockRecord }
  | { ok: false; active: WorktreeLockRecord } {
  const database = new DatabaseSync(paths.neondeckDatabase);
  let committed = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    const activeRow = database
      .prepare(
        `
        SELECT *
        FROM worktree_locks
        WHERE scope_key = ?
          AND released_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      )
      .get(lock.scopeKey);
    const active = activeRow ? readLockRow(activeRow) : undefined;
    if (active && Date.parse(active.expiresAt) > now.getTime()) {
      database.exec('ROLLBACK;');
      committed = true;
      return { ok: false, active };
    }
    if (active) {
      database
        .prepare(
          `
          UPDATE worktree_locks
          SET released_at = ?, stale_recovered_at = ?, updated_at = ?
          WHERE id = ?
            AND released_at IS NULL;
        `,
        )
        .run(lock.createdAt, lock.createdAt, lock.createdAt, active.id);
    }
    database
      .prepare(
        `
        INSERT INTO worktree_locks (
          id, scope, scope_key, worktree_id, repo_id, pr_number, owner,
          workflow_run_id, expires_at, released_at, stale_recovered_at,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        lock.id,
        lock.scope,
        lock.scopeKey,
        lock.worktreeId,
        lock.repoId,
        lock.prNumber,
        lock.owner,
        lock.workflowRunId,
        lock.expiresAt,
        lock.releasedAt,
        lock.staleRecoveredAt,
        lock.createdAt,
        lock.updatedAt,
      );
    database.exec('COMMIT;');
    committed = true;
    return { ok: true, lock, recovered: active };
  } catch (error) {
    if (!committed) {
      database.exec('ROLLBACK;');
    }
    if (isSqliteUniqueConstraint(error)) {
      const active = activeLockByScope(lock.scopeKey, paths);
      if (active) return { ok: false, active };
    }
    throw error;
  } finally {
    database.close();
  }
}

function activeLockByScope(scopeKey: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM worktree_locks
        WHERE scope_key = ?
          AND released_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      )
      .get(scopeKey);
    return row ? readLockRow(row) : undefined;
  } finally {
    database.close();
  }
}

function activeLocksForWorktree(record: WorktreeRecord, paths: RuntimePaths) {
  const prScope =
    record.prNumber === null ? null : `pr:${record.repoId}:${record.prNumber}`;
  return listLockRecords(paths).filter(
    (lock) =>
      !lock.releasedAt &&
      (lock.scopeKey === `worktree:${record.id}` ||
        (prScope !== null && lock.scopeKey === prScope)),
  );
}

function listLockRecords(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM worktree_locks
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 200;
      `,
      )
      .all()
      .map(readLockRow);
  } finally {
    database.close();
  }
}

function requireLock(id: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM worktree_locks WHERE id = ?;')
      .get(id);
    if (!row)
      throw new WorktreeError('LOCK_NOT_FOUND', `Lock ${id} was not found.`);
    return readLockRow(row);
  } finally {
    database.close();
  }
}

function releaseLock(id: string, now: string, paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE worktree_locks
        SET released_at = ?, updated_at = ?
        WHERE id = ?
          AND released_at IS NULL;
      `,
      )
      .run(now, now, id);
  } finally {
    database.close();
  }
}

function listCleanupFailures(paths: RuntimePaths) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `
        SELECT *
        FROM worktree_cleanup_attempts
        WHERE outcome = 'failed'
        ORDER BY attempted_at DESC
        LIMIT 50;
      `,
      )
      .all()
      .map(readCleanupAttemptRow);
  } finally {
    database.close();
  }
}

function readWorktreeRow(row: unknown): WorktreeRecord {
  const item = parseDatabaseRow(worktreeRowSchema, row, 'worktree');
  return {
    id: item.id,
    repoId: item.repo_id,
    repoFullName: item.repo_full_name,
    githubOwner: item.github_owner,
    githubName: item.github_name,
    prNumber: item.pr_number,
    baseRef: item.base_ref,
    headOwner: item.head_owner,
    headName: item.head_name,
    headRef: item.head_ref,
    headSha: item.head_sha,
    localPath: item.local_path,
    storageKind: item.storage_kind === 'repo-local' ? 'repo-local' : 'home',
    owningWorkflowRunId: item.owning_workflow_run_id,
    lifecycleStatus: normalizeStatus(item.lifecycle_status),
    lastSyncedSha: item.last_synced_sha,
    lastPushedSha: item.last_pushed_sha,
    cleanupPolicy: parseCleanupPolicy(item.cleanup_policy_json),
    directPushAllowed: item.direct_push_allowed === 1,
    adopted: item.adopted === 1,
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function readLockRow(row: unknown): WorktreeLockRecord {
  const item = parseDatabaseRow(lockRowSchema, row, 'worktree lock');
  return {
    id: item.id,
    scope: item.scope === 'pr' ? 'pr' : 'worktree',
    scopeKey: item.scope_key,
    worktreeId: item.worktree_id,
    repoId: item.repo_id,
    prNumber: item.pr_number,
    owner: item.owner,
    workflowRunId: item.workflow_run_id,
    expiresAt: item.expires_at,
    releasedAt: item.released_at,
    staleRecoveredAt: item.stale_recovered_at,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

function readCleanupAttemptRow(row: unknown) {
  const item = parseDatabaseRow(
    cleanupAttemptRowSchema,
    row,
    'worktree cleanup attempt',
  );
  return {
    id: item.id,
    worktreeId: item.worktree_id,
    repoId: item.repo_id,
    action: item.action,
    outcome: item.outcome,
    reason: item.reason,
    error: item.error,
    deleted: item.deleted === 1,
    attemptedAt: item.attempted_at,
  };
}

function parseCleanupPolicy(value: unknown): WorktreeCleanupPolicy {
  if (typeof value !== 'string') return cleanupPolicy();
  try {
    const parsed = JSON.parse(value) as unknown;
    const policy = v.safeParse(worktreeCleanupPolicySchema, parsed);
    if (!policy.success) {
      throw new Error(v.summarize(policy.issues));
    }
    return cleanupPolicy(policy.output);
  } catch (error) {
    throw new WorktreeError(
      'CORRUPT_WORKTREE_ROW',
      `Invalid worktree cleanup policy JSON: ${errorMessage(error)}`,
    );
  }
}

function normalizeStatus(value: unknown): WorktreeLifecycleStatus {
  const parsed = v.safeParse(lifecycleStatusSchema, value);
  return parsed.success ? parsed.output : 'failed';
}

function parseDatabaseRow<T>(
  schema: v.GenericSchema<unknown, T>,
  row: unknown,
  label: string,
) {
  const parsed = v.safeParse(schema, row);
  if (parsed.success) return parsed.output;
  throw new WorktreeError(
    'CORRUPT_WORKTREE_ROW',
    `Invalid ${label} row: ${v.summarize(parsed.issues)}`,
  );
}

function repoFullName(repo: RepoConfig) {
  return `${repo.github.owner}/${repo.github.name}`;
}

async function nearestExistingAncestor(path: string) {
  let current = path;
  while (true) {
    if (await exists(current)) return realpath(current);
    const parent = resolve(current, '..');
    if (parent === current) return current;
    current = parent;
  }
}

async function exists(path: string) {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

function isInside(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function isSqliteUniqueConstraint(error: unknown) {
  return (
    error instanceof Error &&
    ('code' in error
      ? String((error as { code?: unknown }).code).includes('CONSTRAINT')
      : /constraint/i.test(error.message))
  );
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
      parsed.issues[0]?.message ?? 'Invalid input.',
    ),
  };
}

function invalidInputResult(action: string, message: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code: 'INVALID_INPUT', message },
  };
}

function failureResult(action: string, error: unknown) {
  const message = errorMessage(error);
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: {
      code: error instanceof WorktreeError ? error.code : 'WORKTREE_ERROR',
      message,
    },
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
