import { AgentRunError, init, type FlueObservation } from '@flue/runtime';
import * as v from 'valibot';
import type { RuntimePaths } from '../../../runtime-home';
import { gitCurrentSha, gitStatus } from '../../../repo-edit/git';
import { addNotification } from '../../app-state';
import {
  listPrWatchRecords,
  readWatchByOwnerInstanceId,
  transitionWatchAutopilot,
  type PrWatchInitialWatermark,
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
import { prEventJsonValueSchema } from '../../pr-events';

const ownerTerminalObservationSchema = v.object({
  v: v.literal(3),
  type: v.literal('submission_settled'),
  eventIndex: v.number(),
  timestamp: v.string(),
  agentName: v.optional(v.string()),
  instanceId: v.optional(v.string()),
  submissionId: v.optional(v.string()),
  operationId: v.optional(v.string()),
  turnId: v.optional(v.string()),
  outcome: v.picklist(['completed', 'failed', 'aborted']),
});
type OwnerTerminalObservation = v.InferOutput<
  typeof ownerTerminalObservationSchema
>;
const reportableErrorSchema = v.union([v.instance(Error), v.string()]);

export async function settleAutopilotOwnerObservation(
  rawEvent: FlueObservation | OwnerTerminalObservation,
  paths: RuntimePaths,
  dependencies: OwnerSettlementLearningDependencies = {},
) {
  const parsedEvent = v.safeParse(ownerTerminalObservationSchema, rawEvent);
  if (!parsedEvent.success) return null;
  const event = parsedEvent.output;
  if (
    (event.agentName && event.agentName !== 'pr-autopilot-owner') ||
    !event.instanceId
  ) {
    return null;
  }
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
    return commitOwnerSettlementDecision(
      decision,
      watch,
      paths,
      eventWatermarksFromPendingTurn(pending),
    );
  } catch (caught) {
    const parsedError = v.safeParse(reportableErrorSchema, caught);
    const failure = parsedError.success
      ? errorMessage(parsedError.output)
      : 'The settlement failure could not be identified.';
    const message = `${watch.repoFullName}#${watch.prNumber} could not be settled safely: ${failure}`;
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
    prepareTurn?: (instanceId: string, paths: RuntimePaths) => Promise<void>;
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
      } catch (caught) {
        const parsedError = v.safeParse(reportableErrorSchema, caught);
        recordPendingAutopilotTurnError(
          paths.home,
          turn.instanceId,
          turn.turnId,
          parsedError.success
            ? errorMessage(parsedError.output)
            : 'The recovery admission failure could not be identified.',
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
    const terminalEvent: OwnerTerminalObservation = {
      v: 3,
      type: 'submission_settled',
      eventIndex: 0,
      timestamp: new Date().toISOString(),
      agentName: 'pr-autopilot-owner',
      instanceId,
      submissionId,
      outcome: outcome.failed ? 'failed' : 'completed',
    };
    await settleAutopilotOwnerObservation(terminalEvent, paths);
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
  eventWatermarks: PrWatchInitialWatermark[] | undefined,
) {
  if (decision.blockMessage) {
    return transitionWatchAutopilot(paths, watch.id, {
      from: ['working', 'waiting'],
      to: 'blocked',
    });
  }
  if (!decision.transition) return watch;
  const transition: Parameters<typeof transitionWatchAutopilot>[2] = {
    ...decision.transition,
  };
  if (eventWatermarks) {
    transition.eventWatermarks = eventWatermarks;
    transition.markInitialEventProcessed = true;
  }
  return transitionWatchAutopilot(paths, watch.id, transition);
}

/**
 * An owner envelope is a durable record of the facts that were actually
 * admitted. Reusing those facts at settlement advances only the handled event
 * baseline, leaving any feedback that arrived while the owner was working or
 * awaiting approval for the next poll.
 */
function eventWatermarksFromPendingTurn(
  pending: ReturnType<typeof claimPendingAutopilotTurnSettlement>,
) {
  if (pending?.source !== 'watch-event' || !pending.envelope) return undefined;
  const facts = objectValue(pending.envelope.facts);
  const event = facts ? objectValue(facts.event) : undefined;
  const values = event?.watermarks;
  if (!Array.isArray(values)) return undefined;
  const watermarks = values.flatMap((value) => {
    const record = v.safeParse(
      v.object({
        category: v.pipe(v.string(), v.minLength(1)),
        watermark: prEventJsonValueSchema,
        sourceUpdatedAt: v.nullable(v.string()),
      }),
      value,
    );
    return record.success
      ? [
          {
            category: record.output.category,
            value: record.output.watermark,
            sourceUpdatedAt: record.output.sourceUpdatedAt,
          },
        ]
      : [];
  });
  return watermarks.length > 0 ? watermarks : undefined;
}

function objectValue(value: import('@flue/runtime').JsonValue) {
  const parsed = v.safeParse(
    v.record(v.string(), prEventJsonValueSchema),
    value,
  );
  return parsed.success ? parsed.output : undefined;
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
  } catch (caught) {
    const parsedError = v.safeParse(reportableErrorSchema, caught);
    console.error(
      '[neondeck] failed to record Autopilot owner block notification',
      parsedError.success ? parsedError.output : caught,
    );
  }
}

function errorMessage(error: v.InferOutput<typeof reportableErrorSchema>) {
  return error instanceof Error ? error.message : error;
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
    if (value) return { kind, id: value };
  }
  return null;
}
