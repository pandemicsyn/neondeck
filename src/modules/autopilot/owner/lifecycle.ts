import type { RuntimePaths } from '../../../runtime-home';
import { addNotification } from '../../app-state';
import {
  readWatch,
  setPrWatchPolling,
  transitionWatchAutopilot,
} from '../../watches';
import { cleanupWorktrees, readWorktreeRecord } from '../../worktrees';

export async function completeAutopilotWatchIfTerminal(
  watchId: string,
  paths: RuntimePaths,
  options: { explicitStop?: boolean } = {},
) {
  const watch = readWatch(paths, watchId);
  if (!watch) return { complete: false, reason: 'missing' as const };
  const terminal =
    options.explicitStop === true ||
    watch.prState === 'closed' ||
    watch.lastSnapshot?.merged === true;
  if (!terminal) return { complete: false, reason: 'open' as const };
  if (
    !options.explicitStop &&
    watch.lastSnapshot?.checks?.status === 'pending'
  ) {
    return { complete: false, reason: 'checks-pending' as const };
  }
  if (
    watch.autopilotStatus === 'working' ||
    (!options.explicitStop && watch.autopilotStatus === 'blocked')
  ) {
    return {
      complete: false,
      reason:
        watch.autopilotStatus === 'working'
          ? ('owner-working' as const)
          : ('needs-human' as const),
    };
  }

  const completed =
    watch.autopilotStatus === 'complete'
      ? watch
      : transitionWatchAutopilot(paths, watch.id, {
          from: ['watching', 'waiting', 'blocked'],
          to: 'complete',
        });
  if (!completed) return { complete: false, reason: 'changed' as const };

  await setPrWatchPolling({ id: watch.id, enabled: false }, paths).catch(
    () => undefined,
  );
  let cleanup: Awaited<ReturnType<typeof cleanupWorktrees>> | null = null;
  if (watch.worktreeId) {
    const worktree = readWorktreeRecord(watch.worktreeId, paths);
    if (!worktree.adopted && worktree.createdBy === 'neondeck') {
      cleanup = await cleanupWorktrees(
        { worktreeId: worktree.id, force: true },
        paths,
      );
    }
  }
  await addNotification(
    {
      level: 'ready',
      title: options.explicitStop
        ? 'Autopilot watch stopped'
        : 'Autopilot watch complete',
      message: options.explicitStop
        ? `${watch.repoFullName}#${watch.prNumber} stopped. Its durable owner conversation remains available as the audit trail.`
        : `${watch.repoFullName}#${watch.prNumber} is closed with settled checks. Polling stopped and eligible managed resources were cleaned up.`,
      source: 'autopilot-owner',
      sourceId: `${watch.id}:complete`,
      data: {
        watchId: watch.id,
        ownerInstanceId: watch.ownerInstanceId,
        worktreeId: watch.worktreeId,
        cleanup,
      },
    },
    paths,
  );
  return {
    complete: true,
    reason: 'terminal' as const,
    watch: completed,
    cleanup,
  };
}
