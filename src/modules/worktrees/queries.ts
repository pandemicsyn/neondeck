import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import { listLockRecords } from './locks';
import { listCleanupFailures, listWorktreeRecords } from './store';

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
