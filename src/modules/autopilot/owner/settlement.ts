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
  type WorktreeRecord,
} from '../../worktrees';
import {
  claimPendingAutopilotTurnSettlement,
  clearPendingAutopilotTurnIfMatches,
  readPendingAutopilotTurn,
} from './pending';
import { reconcileTransientAutopilotRuntimeBlocks } from './runtime-recovery';
import {
  deriveOwnerSettlementDecision,
  failedOwnerSettlementDecision,
  type OwnerSettlementDecision,
  type OwnerSettlementOutcome,
} from './settlement-decision';
import {
  recordOwnerOutcomeQuietly,
  type OwnerSettlementContext,
  type OwnerSettlementLearningDependencies,
} from './settlement-learning';

type OwnerTerminalObservation = Extract<
  FlueObservation,
  { type: 'agent_end' | 'operation' | 'submission_settled' }
>;

export async function settleAutopilotOwnerObservation(
  event: OwnerTerminalObservation,
  paths: RuntimePaths,
  dependencies: OwnerSettlementLearningDependencies = {},
) {
  if (
    (event.agentName && event.agentName !== 'pr-autopilot-owner') ||
    !event.instanceId
  ) {
    return null;
  }
  if (event.type === 'agent_end') return null;
  if (event.type === 'operation' && event.operationKind !== 'prompt') {
    return null;
  }
  const observation = event as unknown as Record<string, unknown>;
  if (observation.taskId || observation.parentSession) return null;
  const watch = readWatchByOwnerInstanceId(paths, event.instanceId);
  if (!watch || !watch.worktreeId) return null;
  const registeredPending = readPendingAutopilotTurn(
    paths.home,
    event.instanceId,
  );
  const pending = claimPendingAutopilotTurnSettlement(
    paths.home,
    event.instanceId,
  );
  if (registeredPending && !pending) return null;
  if (!pending && !strongObservationCorrelation(event)) return null;
  const settlementContext: OwnerSettlementContext = pending
    ? {
        correlationKind: pending.correlationId
          ? 'dispatch-or-submission'
          : pending.eventFingerprint
            ? 'watch-event'
            : 'process-turn',
        eventFingerprint: pending.eventFingerprint,
        learningMemoryIds: pending.learningMemoryIds,
        memorySnapshotAvailable:
          pending.learningMemoryLoaded && pending.learningMemoryAvailable,
        memorySnapshotReason: !pending.learningMemoryLoaded
          ? 'owner-runtime-memory-context-was-not-loaded'
          : pending.learningMemoryAvailable
            ? 'loaded-for-owner-turn'
            : 'owner-runtime-memory-context-was-unavailable',
        mode: pending.mode,
        source: pending.source,
        turnId:
          pending.correlationId ??
          strongObservationCorrelation(event)?.id ??
          pending.eventFingerprint ??
          pending.turnId,
      }
    : recoveredSettlementContext(event, watch.autopilotMode);
  const fingerprint = settlementContext.eventFingerprint;
  const recordOutcome = (outcome: OwnerSettlementOutcome) =>
    recordOwnerOutcomeQuietly(
      watch,
      settlementContext,
      outcome,
      paths,
      dependencies,
    );
  const failed =
    event.type === 'operation'
      ? event.isError
      : event.type === 'submission_settled'
        ? event.outcome !== 'completed'
        : false;

  try {
    let worktree: WorktreeRecord | null = null;
    let decision: OwnerSettlementDecision;
    if (failed) {
      decision = failedOwnerSettlementDecision(watch);
    } else {
      worktree = await readManagedWorktree(
        watch.worktreeId,
        watch.repoId,
        paths,
      );
      const [status, currentSha] = await Promise.all([
        gitStatus(worktree.localPath),
        gitCurrentSha(worktree.localPath),
      ]);
      decision = deriveOwnerSettlementDecision({
        currentSha,
        eventFingerprint: fingerprint,
        statusClean: status.clean,
        watch,
        worktree: {
          headSha: worktree.headSha,
          id: worktree.id,
          lastPushedSha: worktree.lastPushedSha,
        },
      });
    }
    const settled = await applyOwnerSettlementDecision(
      decision,
      watch,
      worktree,
      paths,
    );
    if (decision.outcome) await recordOutcome(decision.outcome);
    return settled;
  } catch (error) {
    const blocked = await blockOwnerTurn(
      watch.id,
      `${watch.repoFullName}#${watch.prNumber} could not be settled safely: ${errorMessage(error)}`,
      paths,
    );
    await recordOutcome({
      eventType: 'autopilot-owner-settlement-failed',
      outcome: 'failed',
      summary: 'The continuing Autopilot owner could not be settled safely.',
    });
    return blocked;
  } finally {
    if (pending) {
      clearPendingAutopilotTurnIfMatches(
        paths.home,
        event.instanceId,
        pending.turnId,
      );
    }
  }
}

export async function recoverInterruptedAutopilotOwners(paths: RuntimePaths) {
  try {
    await reconcileTransientAutopilotRuntimeBlocks(paths, { rearm: true });
  } catch (error) {
    console.warn(
      '[neondeck] failed to reconcile transient Autopilot runtime blocks',
      error,
    );
  }
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

async function applyOwnerSettlementDecision(
  decision: OwnerSettlementDecision,
  watch: NonNullable<ReturnType<typeof readWatchByOwnerInstanceId>>,
  worktree: WorktreeRecord | null,
  paths: RuntimePaths,
) {
  if (decision.blockMessage) {
    return blockOwnerTurn(watch.id, decision.blockMessage, paths);
  }
  const settled = decision.transition
    ? transitionWatchAutopilot(paths, watch.id, decision.transition)
    : watch;
  if (decision.worktreePushBlocked) {
    if (!worktree) {
      throw new Error(
        'Owner settlement requires a worktree for blocked-push evidence.',
      );
    }
    await recordWorktreePushBlocked(
      worktree.id,
      decision.worktreePushBlocked,
      paths,
    );
  }
  if (decision.notification) {
    await addNotification(decision.notification, paths);
  }
  return settled;
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

function recoveredSettlementContext(
  event: OwnerTerminalObservation,
  mode: OwnerSettlementContext['mode'],
): OwnerSettlementContext {
  const correlation = strongObservationCorrelation(event) ?? {
    kind: 'observation-envelope',
    id: `${event.type}:${event.eventIndex}:${event.timestamp}`,
  };
  return {
    correlationKind: correlation.kind,
    learningMemoryIds: [],
    memorySnapshotAvailable: false,
    memorySnapshotReason:
      'process-restarted-before-owner-memory-audit-correlation-could-be-recovered',
    mode,
    source: 'recovered-flue-observation',
    turnId: correlation.id,
  };
}

function strongObservationCorrelation(event: OwnerTerminalObservation) {
  for (const [kind, value] of [
    ['dispatch', event.dispatchId],
    ['submission', event.submissionId],
    ['operation', event.operationId],
    ['turn', event.turnId],
  ] as const) {
    if (typeof value === 'string' && value) return { kind, id: value };
  }
  return null;
}
