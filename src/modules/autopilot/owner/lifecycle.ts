import type { RuntimePaths } from '../../../runtime-home';
import { addNotification } from '../../app-state';
import {
  beginWatchAutopilotCompletion,
  readWatch,
  setPrWatchPolling,
  transitionWatchAutopilot,
  updateWatch,
  watchPollingTaskId,
} from '../../watches';
import { readScheduledTask } from '../../scheduled-tasks';
import { cleanupWorktrees, readWorktreeRecord } from '../../worktrees';
import { gitCurrentSha, gitStatus } from '../../../repo-edit/git';

export async function completeAutopilotWatchIfTerminal(
  watchId: string,
  paths: RuntimePaths,
  options: {
    explicitStop?: boolean;
    confirmPreparedDiff?: boolean;
    cleanup?: typeof cleanupWorktrees;
    readWorktree?: typeof readWorktreeRecord;
    readPollingTask?: typeof readScheduledTask;
    setPolling?: typeof setPrWatchPolling;
    beginCompletion?: typeof beginWatchAutopilotCompletion;
  } = {},
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

  if (options.explicitStop && watch.worktreeId) {
    try {
      const worktree = (options.readWorktree ?? readWorktreeRecord)(
        watch.worktreeId,
        paths,
      );
      if (
        !worktree.adopted &&
        worktree.createdBy === 'neondeck' &&
        (await holdsUnpushedPreparedCommit(worktree)) &&
        options.confirmPreparedDiff !== true
      ) {
        return {
          complete: false,
          reason: 'prepared-diff-confirmation-required' as const,
          watch,
          requires: ['confirmPreparedDiff'] as const,
        };
      }
    } catch {
      // The existing recovery path retains and detaches unreadable worktrees.
    }
  }

  let stopping;
  try {
    if (options.readPollingTask || options.setPolling) {
      const readPollingTask = options.readPollingTask ?? readScheduledTask;
      let pollingTask = await readPollingTask(
        watchPollingTaskId(watch.id),
        paths,
      );
      if (pollingTask?.enabled) {
        await (options.setPolling ?? setPrWatchPolling)(
          { id: watch.id, enabled: false },
          paths,
        );
        pollingTask = await readPollingTask(
          watchPollingTaskId(watch.id),
          paths,
        );
        if (pollingTask?.enabled) {
          throw new Error('The persisted polling task remained enabled.');
        }
      }
      stopping = transitionWatchAutopilot(paths, watch.id, {
        from: ['watching', 'waiting', 'blocked', 'complete', 'stopping'],
        to: 'stopping',
      });
    } else {
      stopping = (options.beginCompletion ?? beginWatchAutopilotCompletion)(
        paths,
        watch.id,
        watch,
      );
    }
  } catch (error) {
    return {
      complete: false,
      reason: 'polling-disable-failed' as const,
      watch,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!stopping) return { complete: false, reason: 'changed' as const };

  let cleanup: Awaited<ReturnType<typeof cleanupWorktrees>> | null = null;
  let detachedWorktreeId: string | null = null;
  let cleanupRecovery: string | null = null;
  if (stopping.worktreeId) {
    try {
      const worktree = (options.readWorktree ?? readWorktreeRecord)(
        stopping.worktreeId,
        paths,
      );
      if (!worktree.adopted && worktree.createdBy === 'neondeck') {
        if (
          options.explicitStop &&
          (await holdsUnpushedPreparedCommit(worktree)) &&
          options.confirmPreparedDiff !== true
        ) {
          detachedWorktreeId = worktree.id;
          cleanupRecovery = `Managed worktree ${worktree.id} held an unpushed prepared commit and was retained without cleanup confirmation, then detached for manual recovery.`;
        } else {
          cleanup = await (options.cleanup ?? cleanupWorktrees)(
            {
              worktreeId: worktree.id,
              force: true,
              ...(options.explicitStop && options.confirmPreparedDiff === true
                ? { confirmPreparedDiff: true }
                : {}),
            },
            paths,
          );
          const results = 'results' in cleanup ? cleanup.results : [];
          const outcome = results.find(
            (result) => result.worktreeId === worktree.id,
          )?.outcome;
          if (outcome !== 'deleted') {
            detachedWorktreeId = worktree.id;
            cleanupRecovery = `Managed worktree ${worktree.id} was retained with cleanup outcome ${outcome ?? 'unknown'} and detached for manual recovery.`;
          }
        }
      } else if (!worktree.adopted) {
        detachedWorktreeId = worktree.id;
        cleanupRecovery = `Non-adopted worktree ${worktree.id} is not Neondeck-owned and was detached without deletion.`;
      }
    } catch (error) {
      detachedWorktreeId = stopping.worktreeId;
      cleanupRecovery = `Worktree ${stopping.worktreeId} could not be inspected or cleaned and was detached for manual recovery: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  let finalStopping = stopping;
  if (detachedWorktreeId) {
    const detached = {
      ...stopping,
      worktreeId: null,
      updatedAt: new Date().toISOString(),
    };
    if (!updateWatch(paths, detached, stopping)) {
      return {
        complete: false,
        reason: 'changed' as const,
        watch: readWatch(paths, watch.id),
        cleanup,
        detachedWorktreeId,
        cleanupRecovery,
      };
    }
    finalStopping = detached;
  }
  const finalWatch = transitionWatchAutopilot(paths, watch.id, {
    from: 'stopping',
    to: 'complete',
  });
  if (!finalWatch) {
    return {
      complete: false,
      reason: 'changed' as const,
      watch: readWatch(paths, watch.id) ?? finalStopping,
      cleanup,
      detachedWorktreeId,
      cleanupRecovery,
    };
  }
  const completionMessage = options.explicitStop
    ? `${watch.repoFullName}#${watch.prNumber} stopped. Its durable owner conversation remains available as the audit trail.`
    : `${watch.repoFullName}#${watch.prNumber} is closed with settled checks. Polling stopped and eligible managed resources were cleaned up.`;
  await addNotification(
    {
      level: cleanupRecovery ? 'attention' : 'ready',
      title: options.explicitStop
        ? 'Autopilot watch stopped'
        : 'Autopilot watch complete',
      message: cleanupRecovery
        ? `${completionMessage} ${cleanupRecovery}`
        : completionMessage,
      source: 'autopilot-owner',
      sourceId: `${watch.id}:complete`,
      data: {
        watchId: watch.id,
        ownerInstanceId: watch.ownerInstanceId,
        worktreeId: watch.worktreeId,
        cleanup,
        detachedWorktreeId,
        cleanupRecovery,
      },
    },
    paths,
  );
  return {
    complete: true,
    reason: 'terminal' as const,
    watch: finalWatch,
    cleanup,
    detachedWorktreeId,
    cleanupRecovery,
  };
}

async function holdsUnpushedPreparedCommit(
  worktree: ReturnType<typeof readWorktreeRecord>,
) {
  if (worktree.lifecycleStatus === 'prepared-diff') return true;
  const status = await gitStatus(worktree.localPath);
  if (!status.clean) return false;
  const currentSha = await gitCurrentSha(worktree.localPath);
  return (
    currentSha !== worktree.headSha && currentSha !== worktree.lastPushedSha
  );
}
