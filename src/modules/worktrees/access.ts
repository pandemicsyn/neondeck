import { type RuntimePaths, runtimePaths } from '../../runtime-home';
import { WorktreeError } from './errors';
import { assertNoForeignActiveLock } from './locks';
import { validateManagedWorktreeRoot } from './paths';
import {
  listWorktreeRecords,
  recordWorktreeEvent,
  requireWorktree,
  upsertWorktree,
  updateWorktreeStatus,
} from './store';

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

export function readWorktreeRecord(
  worktreeId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  return requireWorktree(worktreeId, paths);
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

export async function recordWorktreePushBlocked(
  worktreeId: string,
  input: { message: string; data?: unknown },
  paths: RuntimePaths = runtimePaths(),
) {
  const record = requireWorktree(worktreeId, paths);
  updateWorktreeStatus(record.id, 'prepared-diff', paths);
  await recordWorktreeEvent(
    record.id,
    record.repoId,
    'push_blocked',
    'prepared-diff',
    input.message,
    input.data,
    paths,
  );
  return requireWorktree(worktreeId, paths);
}

export async function recordWorktreePushSucceeded(
  worktreeId: string,
  input: { commitSha: string; message: string; data?: unknown },
  paths: RuntimePaths = runtimePaths(),
) {
  const record = requireWorktree(worktreeId, paths);
  const now = new Date().toISOString();
  upsertWorktree(
    {
      ...record,
      lifecycleStatus: 'succeeded',
      lastPushedSha: input.commitSha,
      updatedAt: now,
    },
    paths,
  );
  await recordWorktreeEvent(
    record.id,
    record.repoId,
    'pushed',
    'succeeded',
    input.message,
    input.data,
    paths,
  );
  return requireWorktree(worktreeId, paths);
}
