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
import {
  recordHandledPrEventAndMaybeQueueLearning,
  type PrBatchReviewInput,
} from '../../learning';
import {
  claimPendingAutopilotTurnSettlement,
  clearPendingAutopilotTurnIfMatches,
  readPendingAutopilotTurn,
} from './pending';
import { reconcileTransientAutopilotRuntimeBlocks } from './runtime-recovery';

type OwnerTerminalObservation = Extract<
  FlueObservation,
  { type: 'agent_end' | 'operation' | 'submission_settled' }
>;

type AutopilotOwnerSettlementDependencies = {
  invokePrBatchReview?: (
    input: PrBatchReviewInput,
  ) => Promise<{ runId: string }>;
  recordHandledPr?: typeof recordHandledPrEventAndMaybeQueueLearning;
};

type OwnerSettlementContext = {
  correlationKind: string;
  eventFingerprint?: string;
  learningMemoryIds: string[];
  memorySnapshotAvailable: boolean;
  memorySnapshotReason: string;
  mode: NonNullable<
    ReturnType<typeof readWatchByOwnerInstanceId>
  >['autopilotMode'];
  source: string;
  turnId: string;
};

export async function settleAutopilotOwnerObservation(
  event: OwnerTerminalObservation,
  paths: RuntimePaths,
  dependencies: AutopilotOwnerSettlementDependencies = {},
) {
  if (
    (event.agentName && event.agentName !== 'pr-autopilot-owner') ||
    !event.instanceId
  ) {
    return null;
  }
  if (
    event.type === 'operation' &&
    (event.operationKind !== 'prompt' || !event.isError)
  ) {
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
  if (!pending && event.type !== 'submission_settled') return null;
  const settlementContext: OwnerSettlementContext = pending
    ? {
        correlationKind: pending.correlationId
          ? 'dispatch-or-submission'
          : pending.eventFingerprint
            ? 'watch-event'
            : 'process-turn',
        eventFingerprint: pending.eventFingerprint,
        learningMemoryIds: pending.learningMemoryIds,
        memorySnapshotAvailable: pending.learningMemoryLoaded,
        memorySnapshotReason: pending.learningMemoryLoaded
          ? 'loaded-for-owner-turn'
          : 'owner-runtime-memory-context-was-not-loaded',
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
  const recordOutcome = (
    outcome: Parameters<typeof recordOwnerOutcomeQuietly>[2],
  ) =>
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
    if (failed) {
      const blocked = await blockOwnerTurn(
        watch.id,
        `${watch.repoFullName}#${watch.prNumber} owner turn failed. Human inspection is required before retry.`,
        paths,
      );
      await recordOutcome({
        eventType: 'autopilot-owner-failed',
        outcome: 'failed',
        summary: 'The continuing Autopilot owner turn failed.',
      });
      return blocked;
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
        const settled = transitionWatchAutopilot(paths, watch.id, {
          from: 'waiting',
          to: 'watching',
        });
        await recordOutcome(
          pushed
            ? {
                eventType: 'autopilot-owner-pushed',
                outcome: 'pushed',
                commitSha: currentSha,
                summary:
                  'The continuing Autopilot owner pushed a focused change.',
              }
            : {
                eventType: 'autopilot-owner-no-change',
                outcome: 'no-change',
                commitSha: currentSha,
                summary:
                  'The continuing Autopilot owner completed cleanly without a retained change.',
              },
        );
        return settled;
      }
      await recordOutcome(
        prepared
          ? {
              eventType: 'autopilot-owner-prepared',
              outcome: 'prepared',
              commitSha: currentSha,
              summary:
                'The continuing Autopilot owner left a committed change waiting for human review.',
            }
          : {
              eventType: 'autopilot-owner-blocked',
              outcome: 'blocked',
              commitSha: currentSha,
              summary:
                'The continuing Autopilot owner remains waiting with work that requires human inspection.',
            },
      );
      return watch;
    }
    if (watch.autopilotStatus === 'blocked') {
      await recordOutcome({
        eventType: prepared
          ? 'autopilot-owner-escalated'
          : 'autopilot-owner-blocked',
        outcome: prepared ? 'escalated' : 'blocked',
        commitSha: currentSha,
        summary: prepared
          ? 'The continuing Autopilot owner retained a committed change after delivery was blocked.'
          : 'The continuing Autopilot owner requires human inspection.',
      });
      return watch;
    }
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
      await recordOutcome({
        eventType: 'autopilot-owner-pushed',
        outcome: 'pushed',
        commitSha: currentSha,
        summary: 'The continuing Autopilot owner pushed a focused change.',
      });
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
            : 'The autonomous owner retained a committed change for human review after deciding not to deliver it.',
          data: { watchId: watch.id, commitSha: currentSha },
        },
        paths,
      );
      await addNotification(
        {
          level: 'attention',
          title: waiting
            ? 'Autopilot change is ready for review'
            : 'Autopilot escalated a committed change for review',
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
      await recordOutcome({
        eventType: waiting
          ? 'autopilot-owner-prepared'
          : 'autopilot-owner-escalated',
        outcome: waiting ? 'prepared' : 'escalated',
        commitSha: currentSha,
        summary: waiting
          ? 'The continuing Autopilot owner prepared a committed change for human review.'
          : 'The continuing Autopilot owner escalated a committed change without autonomous delivery.',
      });
      return settled;
    }

    if (!status.clean) {
      const blocked = await blockOwnerTurn(
        watch.id,
        `${watch.repoFullName}#${watch.prNumber} owner turn ended with uncommitted work.`,
        paths,
      );
      await recordOutcome({
        eventType: 'autopilot-owner-blocked',
        outcome: 'blocked',
        commitSha: currentSha,
        summary:
          'The continuing Autopilot owner ended with uncommitted work and requires inspection.',
      });
      return blocked;
    }

    const settled = transitionWatchAutopilot(paths, watch.id, {
      from: 'working',
      to: 'watching',
      ...(fingerprint ? { eventFingerprint: fingerprint } : {}),
    });
    await recordOutcome({
      eventType: 'autopilot-owner-no-change',
      outcome: 'no-change',
      commitSha: currentSha,
      summary:
        'The continuing Autopilot owner completed cleanly without a new commit.',
    });
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

async function recordOwnerOutcomeQuietly(
  watch: NonNullable<ReturnType<typeof readWatchByOwnerInstanceId>>,
  context: OwnerSettlementContext,
  outcome: {
    eventType: string;
    outcome: string;
    commitSha?: string;
    summary: string;
  },
  paths: RuntimePaths,
  dependencies: AutopilotOwnerSettlementDependencies,
) {
  const turnFingerprint = context.turnId;
  const sourceId = [
    'autopilot-owner',
    watch.id,
    turnFingerprint,
    outcome.outcome,
    outcome.commitSha ?? 'none',
  ].join(':');
  try {
    await (
      dependencies.recordHandledPr ?? recordHandledPrEventAndMaybeQueueLearning
    )(
      {
        eventType: outcome.eventType,
        source: 'pr-autopilot-owner',
        sourceId,
        repoId: watch.repoId,
        repoFullName: watch.repoFullName,
        prNumber: watch.prNumber,
        summary: outcome.summary,
        data: {
          watchId: watch.id,
          ownerInstanceId: watch.ownerInstanceId,
          turnFingerprint,
          outcome: outcome.outcome,
          commitSha: outcome.commitSha ?? null,
          mode: context.mode,
          source: context.source,
          correlationKind: context.correlationKind,
          memoryIds: context.learningMemoryIds,
          memorySnapshot: {
            available: context.memorySnapshotAvailable,
            ids: context.learningMemoryIds,
            reason: context.memorySnapshotReason,
          },
        },
      },
      paths,
      dependencies.invokePrBatchReview
        ? { invokePrBatchReview: dependencies.invokePrBatchReview }
        : {},
    );
  } catch (error) {
    console.error(
      '[neondeck] failed to record Autopilot owner learning event',
      error,
    );
  }
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
