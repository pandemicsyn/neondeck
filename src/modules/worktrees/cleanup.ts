import type { RuntimePaths } from '../../runtime-home';
import { activeLocksForWorktree } from './locks';
import { exists, repoContext } from './paths';
import type { WorktreeRecord } from './schemas';
import { isGitClean } from './git';

export async function cleanupDecision(
  record: WorktreeRecord,
  input: {
    confirmAdopted?: boolean;
    confirmPreparedDiff?: boolean;
    terminalCleanupRetry?: boolean;
    force?: boolean;
  },
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
  if (
    record.lifecycleStatus === 'prepared-diff' &&
    policy.retainPreparedDiff &&
    !input.confirmPreparedDiff
  ) {
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
  if (
    record.lifecycleStatus === 'cleanup-pending' &&
    input.terminalCleanupRetry
  ) {
    // This signal is used only by the coordinator-owned terminal cleanup
    // workflow after a prior deletion attempt failed. It preserves the normal
    // adopted, lock, and clean-worktree guards above while allowing its bounded
    // retry schedule to retry before the unrelated stale-age threshold.
    return { delete: true, reason: 'terminal cleanup retry requested' };
  }
  if (input.force) {
    const forceCleanupStatuses = [
      'stale',
      'needs-sync',
      'cleanup-pending',
      'succeeded',
      ...(policy.retainFailed ? [] : ['failed']),
      ...(record.lifecycleStatus === 'prepared-diff' &&
      input.confirmPreparedDiff
        ? ['prepared-diff']
        : []),
    ];
    if (forceCleanupStatuses.includes(record.lifecycleStatus)) {
      return { delete: true, reason: 'explicit cleanup requested' };
    }
  }
  const ageHours =
    (Date.now() - Date.parse(record.updatedAt)) / (60 * 60 * 1000);
  if (
    record.lifecycleStatus === 'succeeded' &&
    ageHours >= policy.successfulGraceHours
  ) {
    return { delete: true, reason: 'successful grace period elapsed' };
  }
  if (
    record.lifecycleStatus === 'prepared-diff' &&
    input.confirmPreparedDiff &&
    ageHours >= policy.successfulGraceHours
  ) {
    return {
      delete: true,
      reason: 'terminal prepared-diff grace period elapsed',
    };
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
