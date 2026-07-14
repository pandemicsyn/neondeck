import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import type { RepoConfig, RuntimePaths } from '../../runtime-home';
import { WorktreeError, errorMessage } from './errors';
import { cleanupPolicy, repoFullName } from './paths';
import {
  cleanupAttemptRowSchema,
  lifecycleStatusSchema,
  lockRowSchema,
  type WorktreeCleanupPolicy,
  type WorktreeLifecycleStatus,
  type WorktreeLockRecord,
  type WorktreeRecord,
  type WorktreeStorageKind,
  worktreeCleanupPolicySchema,
  worktreeRowSchema,
} from './schemas';

export function recordWorktreeCreating(
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

export function upsertWorktree(record: WorktreeRecord, paths: RuntimePaths) {
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

export function updateWorktreeStatus(
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

export async function recordWorktreeEvent(
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

export function recordCleanupAttempt(
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

export function findReusableWorktree(
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

export function requireWorktree(id: string, paths: RuntimePaths) {
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

export function listWorktreeRecords(paths: RuntimePaths) {
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

export function listCleanupFailures(paths: RuntimePaths) {
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

export function readWorktreeRow(row: unknown): WorktreeRecord {
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

export function readLockRow(row: unknown): WorktreeLockRecord {
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
    revokedAt: item.revoked_at,
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
