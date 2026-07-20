import type { FlueObservation } from '@flue/runtime';
import type { RuntimePaths } from '../../../runtime-home';
import { gitCurrentSha, gitStatus } from '../../../repo-edit/git';
import { addNotification } from '../../app-state';
import {
  listPrWatchRecords,
  readWatchByOwnerInstanceId,
  recoverInterruptedAutopilotWatches,
  transitionWatchAutopilot,
} from '../../watches';
import {
  readManagedWorktree,
  recordWorktreePushBlocked,
} from '../../worktrees';
import { clearPendingAutopilotTurn, readPendingAutopilotTurn } from './pending';

type OwnerTerminalObservation = Extract<
  FlueObservation,
  { type: 'agent_end' | 'submission_settled' }
>;

export async function settleAutopilotOwnerObservation(
  event: OwnerTerminalObservation,
  paths: RuntimePaths,
) {
  if (event.agentName !== 'pr-autopilot-owner' || !event.instanceId)
    return null;
  const watch = readWatchByOwnerInstanceId(paths, event.instanceId);
  if (!watch || !watch.worktreeId) return null;
  const pending = readPendingAutopilotTurn(paths.home, event.instanceId);
  const fingerprint = pending?.eventFingerprint;
  const failed =
    event.type === 'submission_settled' && event.outcome !== 'completed';

  try {
    if (failed) {
      return await blockOwnerTurn(
        watch.id,
        `${watch.repoFullName}#${watch.prNumber} owner turn ${event.outcome}. Human inspection is required before retry.`,
        paths,
      );
    }

    const worktree = await readManagedWorktree(
      watch.worktreeId,
      watch.repoId,
      paths,
    );
    const [status, currentSha] = await Promise.all([
      gitStatus(worktree.localPath),
      gitCurrentSha(worktree.localPath),
    ]);
    const pushed =
      Boolean(worktree.lastPushedSha) && currentSha === worktree.lastPushedSha;
    const prepared =
      status.clean &&
      currentSha !== worktree.headSha &&
      currentSha !== worktree.lastPushedSha;

    if (watch.autopilotStatus === 'waiting') {
      if (pushed || (status.clean && currentSha === worktree.headSha)) {
        return transitionWatchAutopilot(paths, watch.id, {
          from: 'waiting',
          to: 'watching',
        });
      }
      if (prepared || !status.clean) return watch;
      return watch;
    }
    if (watch.autopilotStatus === 'blocked') return watch;
    if (watch.autopilotStatus !== 'working') return watch;

    if (pushed) {
      const settled = transitionWatchAutopilot(paths, watch.id, {
        from: 'working',
        to: 'watching',
        ...(fingerprint ? { eventFingerprint: fingerprint } : {}),
      });
      await addNotification(
        {
          level: 'ready',
          title: 'Autopilot pushed a focused change',
          message: `${watch.repoFullName}#${watch.prNumber} was pushed and remains watched for later feedback.`,
          source: 'autopilot-owner',
          sourceId: `${watch.id}:pushed:${currentSha}`,
          data: { watchId: watch.id, worktreeId: worktree.id, currentSha },
        },
        paths,
      );
      return settled;
    }

    if (prepared) {
      const waiting =
        watch.autopilotMode === 'prepare-only' ||
        watch.autopilotMode === 'autofix-with-approval';
      const settled = transitionWatchAutopilot(paths, watch.id, {
        from: 'working',
        to: waiting ? 'waiting' : 'blocked',
        ...(waiting && fingerprint ? { eventFingerprint: fingerprint } : {}),
      });
      await recordWorktreePushBlocked(
        worktree.id,
        {
          message: waiting
            ? 'Autopilot prepared a committed change for human review.'
            : 'Autopilot ended without proving a safe autonomous push.',
          data: { watchId: watch.id, commitSha: currentSha },
        },
        paths,
      );
      await addNotification(
        {
          level: 'attention',
          title: waiting
            ? 'Autopilot change is ready for review'
            : 'Autopilot prepared a change but did not safely push',
          message: `${watch.repoFullName}#${watch.prNumber} has a committed change held in managed worktree ${worktree.id}.`,
          source: 'autopilot-owner',
          sourceId: `${watch.id}:prepared:${currentSha}`,
          data: {
            watchId: watch.id,
            ownerInstanceId: watch.ownerInstanceId,
            worktreeId: worktree.id,
            commitSha: currentSha,
          },
        },
        paths,
      );
      return settled;
    }

    if (!status.clean) {
      return await blockOwnerTurn(
        watch.id,
        `${watch.repoFullName}#${watch.prNumber} owner turn ended with uncommitted work.`,
        paths,
      );
    }

    return transitionWatchAutopilot(paths, watch.id, {
      from: 'working',
      to: 'watching',
      ...(fingerprint ? { eventFingerprint: fingerprint } : {}),
    });
  } catch (error) {
    return blockOwnerTurn(
      watch.id,
      `${watch.repoFullName}#${watch.prNumber} could not be settled safely: ${errorMessage(error)}`,
      paths,
    );
  } finally {
    clearPendingAutopilotTurn(paths.home, event.instanceId);
  }
}

export async function recoverInterruptedAutopilotOwners(paths: RuntimePaths) {
  const interrupted = (await listPrWatchRecords(paths)).filter(
    (watch) => watch.autopilotStatus === 'working',
  );
  if (interrupted.length === 0) return 0;
  recoverInterruptedAutopilotWatches(paths);
  for (const watch of interrupted) {
    await addNotification(
      {
        level: 'attention',
        title: 'Autopilot turn interrupted',
        message: `${watch.repoFullName}#${watch.prNumber} may have stopped around an external effect. Inspect the continuing owner and managed worktree before retrying.`,
        source: 'autopilot-owner',
        sourceId: `${watch.id}:interrupted`,
        data: {
          watchId: watch.id,
          ownerInstanceId: watch.ownerInstanceId,
          worktreeId: watch.worktreeId,
        },
      },
      paths,
    );
  }
  return interrupted.length;
}

async function blockOwnerTurn(
  watchId: string,
  message: string,
  paths: RuntimePaths,
) {
  const blocked = transitionWatchAutopilot(paths, watchId, {
    from: ['working', 'waiting'],
    to: 'blocked',
  });
  await addNotification(
    {
      level: 'attention',
      title: 'Autopilot needs human inspection',
      message,
      source: 'autopilot-owner',
      sourceId: `${watchId}:needs-human`,
      data: { watchId },
    },
    paths,
  );
  return blocked;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
