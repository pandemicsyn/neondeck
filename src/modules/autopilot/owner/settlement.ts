import { AgentRunError, init, type FlueObservation } from '@flue/runtime';
import type { RuntimePaths } from '../../../runtime-home';
import { gitCurrentSha, gitStatus } from '../../../repo-edit/git';
import { addNotification } from '../../app-state';
import {
  listPrWatchRecords,
  readWatchByOwnerInstanceId,
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
  listRecoverableAutopilotTurns,
  readAutopilotTurnBySubmissionId,
  readPendingAutopilotTurn,
  recordPendingAutopilotTurnCorrelationId,
  recordPendingAutopilotTurnError,
  resetSettlingAutopilotTurns,
} from './pending';
import {
  dispatchAutopilotOwnerMessage,
  dispatchAutopilotOwnerTurn,
} from './dispatch';
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
  if (event.type !== 'submission_settled') return null;
  if (
    (event.agentName && event.agentName !== 'pr-autopilot-owner') ||
    !event.instanceId
  ) {
    return null;
  }
  const observation = event as unknown as Record<string, unknown>;
  if (observation.taskId || observation.parentSession) return null;
  const watch = readWatchByOwnerInstanceId(paths, event.instanceId);
  if (!watch || !watch.worktreeId) return null;
  let registeredPending = readPendingAutopilotTurn(
    paths.home,
    event.instanceId,
  );
  const historicalSubmission = event.submissionId
    ? readAutopilotTurnBySubmissionId(
        paths.home,
        event.instanceId,
        event.submissionId,
      )
    : undefined;
  if (!registeredPending && historicalSubmission?.status === 'settled') {
    return null;
  }
  const observationCorrelation = strongObservationCorrelation(event);
  if (
    registeredPending &&
    !registeredPending.correlationId &&
    event.submissionId
  ) {
    if (
      historicalSubmission &&
      historicalSubmission.turnId !== registeredPending.turnId
    ) {
      return null;
    }
    recordPendingAutopilotTurnCorrelationId(
      paths.home,
      event.instanceId,
      registeredPending.turnId,
      event.submissionId,
    );
    registeredPending = readPendingAutopilotTurn(paths.home, event.instanceId);
  }
  if (
    registeredPending &&
    (event.submissionId || registeredPending.correlationId) &&
    event.submissionId !== registeredPending.correlationId
  ) {
    return null;
  }
  const pending = claimPendingAutopilotTurnSettlement(
    paths.home,
    event.instanceId,
  );
  if (registeredPending && !pending) return null;
  if (!pending && !observationCorrelation) return null;
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
          observationCorrelation?.id ??
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
  const failed = event.outcome !== 'completed';

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
    await applyOwnerSettlementEffects(decision, watch, worktree, paths);
    if (decision.outcome) await recordOutcome(decision.outcome);
    return commitOwnerSettlementDecision(decision, watch, paths);
  } catch (error) {
    const message = `${watch.repoFullName}#${watch.prNumber} could not be settled safely: ${errorMessage(error)}`;
    await recordOutcome({
      eventType: 'autopilot-owner-settlement-failed',
      outcome: 'failed',
      summary: 'The continuing Autopilot owner could not be settled safely.',
    });
    await addOwnerBlockNotificationQuietly(watch.id, message, paths);
    return transitionWatchAutopilot(paths, watch.id, {
      from: ['working', 'waiting'],
      to: 'blocked',
    });
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

const settlementWatchers = new Map<string, Promise<void>>();

export async function recoverInterruptedAutopilotOwners(
  paths: RuntimePaths,
  dependencies: {
    dispatchTurn?: typeof dispatchAutopilotOwnerTurn;
    dispatchMessage?: typeof dispatchAutopilotOwnerMessage;
    prepareTurn?: (instanceId: string, paths: RuntimePaths) => Promise<unknown>;
    readSettlement?: typeof readAutopilotOwnerSettlement;
    reclaimSettling?: boolean;
  } = {},
) {
  try {
    await reconcileTransientAutopilotRuntimeBlocks(paths, { rearm: true });
  } catch (error) {
    console.warn(
      '[neondeck] failed to reconcile transient Autopilot runtime blocks',
      error,
    );
  }
  let recovered = 0;
  if (dependencies.reclaimSettling !== false) {
    resetSettlingAutopilotTurns(paths.home);
  }
  const activeTurns = listRecoverableAutopilotTurns(paths.home);
  for (const turn of activeTurns) {
    let submissionId = turn.correlationId;
    if (!submissionId && turn.status === 'reserved') {
      try {
        if (!turn.prepared) {
          await (dependencies.prepareTurn ?? prepareAutopilotOwnerTurn)(
            turn.instanceId,
            paths,
          );
          const prepared = readPendingAutopilotTurn(
            paths.home,
            turn.instanceId,
          );
          if (prepared?.turnId !== turn.turnId || !prepared.prepared) {
            throw new Error(
              'The reserved owner turn could not persist its prepared context.',
            );
          }
        }
        const receipt =
          turn.source === 'watch-event' && turn.envelope
            ? await (dependencies.dispatchTurn ?? dispatchAutopilotOwnerTurn)({
                instanceId: turn.instanceId,
                envelope: turn.envelope,
                idempotencyKey: turn.idempotencyKey ?? turn.turnId,
              })
            : turn.source === 'direct-human' && turn.messageBody
              ? await (
                  dependencies.dispatchMessage ?? dispatchAutopilotOwnerMessage
                )({
                  agent: 'pr-autopilot-owner',
                  id: turn.instanceId,
                  input: turn.messageBody,
                  idempotencyKey: turn.idempotencyKey ?? turn.turnId,
                })
              : null;
        if (!receipt) {
          throw new Error('The reserved owner turn has no replayable payload.');
        }
        submissionId = receipt.submissionId;
        recordPendingAutopilotTurnCorrelationId(
          paths.home,
          turn.instanceId,
          turn.turnId,
          submissionId,
        );
        recovered += 1;
      } catch (error) {
        recordPendingAutopilotTurnError(
          paths.home,
          turn.instanceId,
          turn.turnId,
          errorMessage(error),
        );
        continue;
      }
    }
    if (submissionId) {
      watchAutopilotOwnerSettlement(
        turn.instanceId,
        submissionId,
        paths,
        dependencies.readSettlement,
        turn.turnId,
      );
    }
  }
  const activeInstances = new Set(activeTurns.map((turn) => turn.instanceId));
  const interrupted = (await listPrWatchRecords(paths)).filter(
    (watch) =>
      watch.autopilotStatus === 'working' &&
      (!watch.ownerInstanceId || !activeInstances.has(watch.ownerInstanceId)),
  );
  for (const watch of interrupted) {
    transitionWatchAutopilot(paths, watch.id, {
      from: 'working',
      to: 'blocked',
    });
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
  return recovered + interrupted.length;
}

async function prepareAutopilotOwnerTurn(
  instanceId: string,
  paths: RuntimePaths,
) {
  const { buildPrAutopilotOwnerRuntime } =
    await import('../../../agents/pr-autopilot-owner');
  await buildPrAutopilotOwnerRuntime(instanceId, paths);
}

export function watchAutopilotOwnerSettlement(
  instanceId: string,
  submissionId: string,
  paths: RuntimePaths,
  readSettlement: typeof readAutopilotOwnerSettlement = readAutopilotOwnerSettlement,
  expectedTurnId?: string,
) {
  const key = `${paths.home}\0${instanceId}\0${submissionId}`;
  const existing = settlementWatchers.get(key);
  if (existing) return existing;
  const watcher = (async () => {
    const outcome = await readSettlement(instanceId, submissionId);
    if (
      expectedTurnId &&
      readPendingAutopilotTurn(paths.home, instanceId)?.turnId !==
        expectedTurnId
    ) {
      return;
    }
    await settleAutopilotOwnerObservation(
      {
        v: 3,
        type: 'submission_settled',
        eventIndex: 0,
        timestamp: new Date().toISOString(),
        agentName: 'pr-autopilot-owner',
        instanceId,
        submissionId,
        outcome: outcome.failed ? 'failed' : 'completed',
        ...(outcome.failed
          ? {
              error: {
                type: 'agent_run_error',
                name: 'AgentRunError',
                message: outcome.error,
              },
            }
          : {}),
      } as OwnerTerminalObservation,
      paths,
    );
  })()
    .catch((error) => {
      console.warn('[neondeck] failed to observe owner settlement', error);
    })
    .finally(() => settlementWatchers.delete(key));
  settlementWatchers.set(key, watcher);
  return watcher;
}

export async function readAutopilotOwnerSettlement(
  instanceId: string,
  submissionId: string,
) {
  const { PrAutopilotOwner } =
    await import('../../../agents/pr-autopilot-owner');
  const handle = init(PrAutopilotOwner, { id: instanceId });
  try {
    await handle.read(submissionId);
    return { failed: false as const };
  } catch (error) {
    if (error instanceof AgentRunError) {
      return { failed: true as const, error: error.message };
    }
    throw error;
  }
}

async function applyOwnerSettlementEffects(
  decision: OwnerSettlementDecision,
  watch: NonNullable<ReturnType<typeof readWatchByOwnerInstanceId>>,
  worktree: WorktreeRecord | null,
  paths: RuntimePaths,
) {
  if (decision.blockMessage) {
    await addOwnerBlockNotification(watch.id, decision.blockMessage, paths);
    return;
  }
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
}

function commitOwnerSettlementDecision(
  decision: OwnerSettlementDecision,
  watch: NonNullable<ReturnType<typeof readWatchByOwnerInstanceId>>,
  paths: RuntimePaths,
) {
  if (decision.blockMessage) {
    return transitionWatchAutopilot(paths, watch.id, {
      from: ['working', 'waiting'],
      to: 'blocked',
    });
  }
  return decision.transition
    ? transitionWatchAutopilot(paths, watch.id, decision.transition)
    : watch;
}

function addOwnerBlockNotification(
  watchId: string,
  message: string,
  paths: RuntimePaths,
) {
  return addNotification(
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
}

async function addOwnerBlockNotificationQuietly(
  watchId: string,
  message: string,
  paths: RuntimePaths,
) {
  try {
    await addOwnerBlockNotification(watchId, message, paths);
  } catch (error) {
    console.error(
      '[neondeck] failed to record Autopilot owner block notification',
      error,
    );
  }
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
    ['submission', event.submissionId],
    ['operation', event.operationId],
    ['turn', event.turnId],
  ] as const) {
    if (typeof value === 'string' && value) return { kind, id: value };
  }
  return null;
}
