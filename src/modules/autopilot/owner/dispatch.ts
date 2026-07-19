import { randomUUID } from 'node:crypto';
import { dispatch, type DispatchReceipt } from '@flue/runtime';
import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import { buildMemoryPromptSnapshotSync } from '../../memory';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import { insertAutopilotAdmissionEvent } from '../coordination/advance';
import { claimAutopilotStageDispatch } from '../coordination/dispatch';
import { classifyAutopilotRetry } from '../coordination/retry';
import {
  readAutopilotAdmission,
  readAutopilotPrOwner,
  readAutopilotStageAttempt,
} from '../coordination/schemas';
import { settleAutopilotDispatchFailure } from '../coordination/settle';
import {
  buildAutopilotOwnerEnvelope,
  type OwnerEnvelopeFactsLoader,
  type OwnerEnvelopeLocalShaLoader,
  type OwnerEnvelopeReadinessLoader,
} from './envelope';
import { classifyAutopilotOwnerDrift, stableJsonHash } from './grounding';
import {
  ensureAutopilotOwnerInstanceInDatabase,
  rotateAutopilotOwnerInstanceInDatabase,
} from './instance';
import { settlePendingAutopilotOwnerObservation } from './settle';
import { readAutopilotOwnerCapabilitySnapshot } from './capabilities';

export type AutopilotOwnerDispatcher = (request: {
  agent: 'pr-autopilot-owner';
  id: string;
  input: string;
}) => Promise<DispatchReceipt>;

const groundingSnapshotRowSchema = v.looseObject({
  id: v.string(),
  owner_id: v.string(),
  admission_id: v.string(),
  attempt_id: v.string(),
  generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
  flue_instance_id: v.string(),
  config_history_id: v.pipe(v.number(), v.integer(), v.minValue(0)),
  memory_event_at: v.nullable(v.string()),
  memory_event_id: v.nullable(v.string()),
  memory_event_sequence: v.pipe(v.number(), v.integer(), v.minValue(0)),
  memory_cas_event_sequence: v.pipe(v.number(), v.integer(), v.minValue(0)),
  memory_ids_json: v.string(),
  envelope_hash: v.pipe(v.string(), v.minLength(1)),
  policy_hash: v.pipe(v.string(), v.minLength(1)),
  submit_token_hash: v.pipe(v.string(), v.minLength(1)),
  status: v.picklist(['reserved', 'accepted', 'blocked', 'orphaned']),
});
const configHighWaterRowSchema = v.object({
  id: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
const memoryHighWaterRowSchema = v.nullable(
  v.object({
    event_sequence: v.pipe(v.number(), v.integer(), v.minValue(1)),
    created_at: v.string(),
    id: v.string(),
  }),
);
const groundingMemoryIdsSchema = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
  v.maxLength(256),
);

export async function dispatchReservedAutopilotOwnerTurn(
  input: {
    attemptId: string;
    dispatchOwner?: AutopilotOwnerDispatcher;
    factsLoader?: OwnerEnvelopeFactsLoader;
    readinessLoader?: OwnerEnvelopeReadinessLoader;
    localShaLoader?: OwnerEnvelopeLocalShaLoader;
  },
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const initial = readContext(input.attemptId, paths);
  if (!initial) return { status: 'missing' as const };
  if (initial.attempt.status !== 'reserved') {
    return { status: 'not-reserved' as const, ...initial };
  }
  if (
    initial.attempt.stage !== 'owner-turn' ||
    initial.admission.currentStageAttemptId !== initial.attempt.id
  ) {
    return { status: 'stale-reservation' as const, ...initial };
  }
  const claim = await claimAutopilotStageDispatch(
    {
      attemptId: initial.attempt.id,
      expectedAdmissionVersion: initial.admission.version,
    },
    paths,
    now,
  );
  if (claim.status !== 'claimed') return claim;

  const memory = buildMemoryPromptSnapshotSync(paths, {
    repoId: initial.owner.repoId,
  });
  const prepared = prepareOwnerGeneration(
    input.attemptId,
    memory.memoryIds,
    paths,
    now,
  );
  if (prepared.status === 'blocked') return prepared;

  let built;
  try {
    built = await buildAutopilotOwnerEnvelope(
      {
        owner: prepared.owner,
        admission: prepared.admission,
        attempt: prepared.attempt,
        generation: prepared.owner.generation,
        instanceId: prepared.owner.flueInstanceId!,
        grounding: prepared.drift,
        factsLoader: input.factsLoader,
        readinessLoader: input.readinessLoader,
        localShaLoader: input.localShaLoader,
      },
      paths,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await settleAutopilotDispatchFailure(
      {
        attemptId: input.attemptId,
        classification: {
          kind: 'permanent',
          code:
            message.includes('truncated') || message.includes('exceed')
              ? 'authoritative-facts-incomplete'
              : 'owner-grounding-failed',
          reason:
            'The authoritative owner envelope could not be constructed safely.',
        },
        error: message,
      },
      paths,
      now,
    );
    return { status: 'dispatch-failed' as const, error: message, ...initial };
  }
  const snapshotId = reserveGroundingSnapshot(prepared, built, paths, now);
  let receipt: DispatchReceipt;
  try {
    receipt = await (input.dispatchOwner ?? defaultOwnerDispatcher)({
      agent: 'pr-autopilot-owner',
      id: prepared.owner.flueInstanceId!,
      input: built.serialized,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await settleAutopilotDispatchFailure(
      {
        attemptId: input.attemptId,
        classification: classifyAutopilotRetry({
          error,
          idempotent: true,
          effectMayHaveCompleted: false,
        }),
        error: message,
      },
      paths,
      now,
    );
    return { status: 'dispatch-failed' as const, error: message, ...initial };
  }
  const registered = registerOwnerDispatch(
    {
      snapshotId,
      attemptId: input.attemptId,
      dispatchId: receipt.dispatchId,
      expectedAdmissionVersion: prepared.admission.version,
      generation: prepared.owner.generation,
      instanceId: prepared.owner.flueInstanceId!,
    },
    paths,
    now,
  );
  if (registered.status === 'running') {
    const settled = await settlePendingAutopilotOwnerObservation(
      receipt.dispatchId,
      paths,
      now,
    );
    if (settled.status === 'settled') return settled;
  }
  return registered;
}

function prepareOwnerGeneration(
  attemptId: string,
  selectedMemoryIds: string[],
  paths: RuntimePaths,
  now: Date,
) {
  const capability = readAutopilotOwnerCapabilitySnapshot(paths);
  const nowIso = now.toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const context = readContextInDatabase(database, attemptId);
      if (!context) throw new Error('Owner turn context disappeared.');
      let drift = classifyAutopilotOwnerDrift(database, {
        owner: context.owner,
        selectedMemoryIds,
      });
      if (
        drift.kind === 'rotate' &&
        previousRotationAlreadyCovers(
          database,
          context.owner.id,
          context.owner.generation,
          drift.rotationConfigHistoryId,
        )
      ) {
        drift = {
          ...drift,
          kind: 'reground',
          reasons: ['pending-rotation-retry', ...drift.reasons],
        };
      }
      const memoryCas = database
        .prepare(
          `SELECT sequence AS event_sequence, created_at, id FROM memory_events
           ORDER BY sequence DESC LIMIT 1;`,
        )
        .get() as
        | { event_sequence?: unknown; created_at?: unknown; id?: unknown }
        | undefined;
      if (drift.kind === 'block') {
        const message = `Owner grounding blocked: ${drift.reasons.join(', ')}`;
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET status = 'blocked', error = ?, finished_at = ?
             WHERE id = ? AND status = 'running';`,
          )
          .run(message, nowIso, attemptId);
        database
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'blocked', current_workflow = NULL,
                 current_stage_attempt_id = NULL, last_error = ?,
                 last_outcome_json = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND version = ? AND state = 'owner-turn-admitted'
               AND current_stage_attempt_id = ?;`,
          )
          .run(
            message,
            JSON.stringify({
              stage: 'owner-turn',
              result: 'blocked',
              retryClass: 'permanent',
              errorCode: 'grounding-drift-blocked',
              message,
              artifact: { reasons: drift.reasons },
            }),
            nowIso,
            context.admission.id,
            context.admission.version,
            attemptId,
          );
        database
          .prepare(
            `INSERT INTO autopilot_owner_grounding_snapshots (
               id, owner_id, admission_id, attempt_id, generation,
               flue_instance_id, config_history_id, memory_event_at,
               memory_event_id, memory_event_sequence, memory_ids_json, stale_reasons_json,
               envelope_hash, policy_hash, submit_token_hash, status, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'blocked', ?);`,
          )
          .run(
            `autopilot-grounding:${randomUUID()}`,
            context.owner.id,
            context.admission.id,
            attemptId,
            context.owner.generation,
            context.owner.flueInstanceId ?? 'uncreated',
            context.owner.groundingConfigHistoryId,
            context.owner.groundingMemoryEventAt,
            context.owner.groundingMemoryEventId,
            context.owner.groundingMemoryEventSequence,
            JSON.stringify(context.owner.groundingMemoryIds),
            JSON.stringify(drift.staleReasons),
            stableJsonHash(drift.reasons),
            nowIso,
          );
        insertAutopilotAdmissionEvent(database, {
          admissionId: context.admission.id,
          fromState: 'owner-turn-admitted',
          toState: 'blocked',
          reason: 'owner-grounding-blocked',
          data: { attemptId, reasons: drift.reasons },
          now: nowIso,
        });
        return { status: 'blocked' as const, ...context, drift };
      }
      let owner = context.owner;
      if (drift.kind === 'rotate') {
        owner = rotateAutopilotOwnerInstanceInDatabase(database, {
          ownerId: owner.id,
          admissionId: context.admission.id,
          attemptId,
          expectedGeneration: owner.generation,
          reason: drift.reasons.join(', '),
          handoff: {
            previousInstanceId: owner.flueInstanceId,
            previousGeneration: owner.generation,
            lastSettledSequence: owner.lastSettledSequence,
            worktreeId: owner.worktreeId,
            headSha: owner.currentHeadSha,
            groundingReasons: drift.reasons,
            rotationConfigHistoryId: drift.rotationConfigHistoryId,
            rotationMemoryEventAt: drift.memoryEventAt,
            rotationMemoryEventId: drift.memoryEventId,
          },
          capability,
          now: nowIso,
        });
      } else {
        owner = ensureAutopilotOwnerInstanceInDatabase(
          database,
          context.owner.id,
          nowIso,
          capability,
        );
      }
      return {
        status: 'ready' as const,
        ...context,
        owner,
        drift,
        memoryCasEventAt:
          typeof memoryCas?.created_at === 'string'
            ? memoryCas.created_at
            : null,
        memoryCasEventId:
          typeof memoryCas?.id === 'string' ? memoryCas.id : null,
        memoryCasEventSequence: Number(memoryCas?.event_sequence ?? 0),
      };
    });
  } finally {
    database.close();
  }
}

function previousRotationAlreadyCovers(
  database: ReturnType<typeof openDb>,
  ownerId: string,
  generation: number,
  rotationConfigHistoryId: number | null,
) {
  if (generation <= 1 || rotationConfigHistoryId === null) return false;
  const row = database
    .prepare(
      `SELECT handoff_json FROM autopilot_owner_generations
       WHERE owner_id = ? AND generation = ? AND status = 'archived';`,
    )
    .get(ownerId, generation - 1) as { handoff_json?: unknown } | undefined;
  if (typeof row?.handoff_json !== 'string') return false;
  try {
    const handoff = JSON.parse(row.handoff_json) as Record<string, unknown>;
    return (
      typeof handoff.rotationConfigHistoryId === 'number' &&
      handoff.rotationConfigHistoryId >= rotationConfigHistoryId
    );
  } catch {
    return false;
  }
}

function reserveGroundingSnapshot(
  prepared: Extract<
    ReturnType<typeof prepareOwnerGeneration>,
    { status: 'ready' }
  >,
  built: Awaited<ReturnType<typeof buildAutopilotOwnerEnvelope>>,
  paths: RuntimePaths,
  now: Date,
) {
  const id = `autopilot-grounding:${randomUUID()}`;
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO autopilot_owner_grounding_snapshots (
           id, owner_id, admission_id, attempt_id, generation, flue_instance_id,
           worktree_id, pr_head_sha, worktree_head_sha, base_sha,
           checkout_branch, checkout_detached, diff_base_sha, diff_revision_key,
           repo_binding_hash, workspace_binding_hash,
           config_history_id, memory_event_at, memory_event_id,
           memory_event_sequence, memory_cas_event_at, memory_cas_event_id,
           memory_cas_event_sequence, memory_ids_json,
           stale_reasons_json, envelope_hash, policy_hash, submit_token_hash,
           status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?);`,
      )
      .run(
        id,
        prepared.owner.id,
        prepared.admission.id,
        prepared.attempt.id,
        prepared.owner.generation,
        prepared.owner.flueInstanceId,
        built.worktreeId,
        built.expectedPrHeadSha,
        built.expectedWorktreeHeadSha,
        built.baseSha,
        built.checkoutBranch,
        built.checkoutDetached ? 1 : 0,
        built.diffBaseSha,
        built.diffRevisionKey,
        built.repoBindingHash,
        built.workspaceBindingHash,
        prepared.drift.configHistoryId,
        prepared.drift.memoryEventAt,
        prepared.drift.memoryEventId,
        prepared.drift.memoryEventSequence,
        prepared.memoryCasEventAt,
        prepared.memoryCasEventId,
        prepared.memoryCasEventSequence,
        JSON.stringify(built.selectedMemoryIds),
        JSON.stringify(prepared.drift.staleReasons),
        built.envelopeHash,
        built.policyHash,
        built.submitTokenHash,
        now.toISOString(),
      );
    return id;
  } finally {
    database.close();
  }
}

function registerOwnerDispatch(
  input: {
    snapshotId: string;
    attemptId: string;
    dispatchId: string;
    expectedAdmissionVersion: number;
    generation: number;
    instanceId: string;
  },
  paths: RuntimePaths,
  now: Date,
) {
  const nowIso = now.toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const context = readContextInDatabase(database, input.attemptId);
      const rawSnapshot = database
        .prepare(
          'SELECT * FROM autopilot_owner_grounding_snapshots WHERE id = ?;',
        )
        .get(input.snapshotId);
      if (!context || !rawSnapshot) return { status: 'missing' as const };
      const snapshotResult = v.safeParse(
        groundingSnapshotRowSchema,
        rawSnapshot,
      );
      const snapshot = snapshotResult.success
        ? snapshotResult.output
        : undefined;
      const configHighWater = v.safeParse(
        configHighWaterRowSchema,
        database
          .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM config_history;')
          .get(),
      );
      const memoryHighWater = v.safeParse(
        memoryHighWaterRowSchema,
        database
          .prepare(
            `SELECT sequence AS event_sequence, created_at, id FROM memory_events
             ORDER BY sequence DESC LIMIT 1;`,
          )
          .get() ?? null,
      );
      const selectedMemoryIds = v.safeParse(
        groundingMemoryIdsSchema,
        parsePersistedJson(snapshot?.memory_ids_json ?? ''),
      );
      const current =
        snapshot !== undefined &&
        configHighWater.success &&
        memoryHighWater.success &&
        selectedMemoryIds.success &&
        context.attempt.status === 'running' &&
        context.attempt.dispatchId === null &&
        context.admission.version === input.expectedAdmissionVersion &&
        context.admission.state === 'owner-turn-admitted' &&
        context.admission.currentStageAttemptId === context.attempt.id &&
        context.owner.generation === input.generation &&
        context.owner.flueInstanceId === input.instanceId &&
        snapshot.status === 'reserved' &&
        snapshot.config_history_id === configHighWater.output.id &&
        (memoryHighWater.output?.event_sequence ?? 0) ===
          snapshot.memory_cas_event_sequence;
      if (!current) {
        database
          .prepare(
            `UPDATE autopilot_owner_grounding_snapshots
             SET status = 'orphaned', dispatch_id = ?, accepted_at = ?
             WHERE id = ? AND status = 'reserved';`,
          )
          .run(input.dispatchId, nowIso, input.snapshotId);
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET dispatch_id = ?, status = 'failed', error = ?, finished_at = ?
             WHERE id = ? AND dispatch_id IS NULL;`,
          )
          .run(
            input.dispatchId,
            'Accepted owner dispatch lost its grounding CAS; manual review is required.',
            nowIso,
            input.attemptId,
          );
        database
          .prepare(
            `UPDATE autopilot_admissions
             SET state = 'manual-review', current_workflow = NULL,
                 current_stage_attempt_id = NULL, last_error = ?,
                 last_outcome_json = ?, completed_at = ?, version = version + 1,
                 updated_at = ?
             WHERE id = ? AND version = ? AND state = 'owner-turn-admitted'
               AND current_stage_attempt_id = ?;`,
          )
          .run(
            'Accepted owner dispatch lost its grounding CAS; manual review is required.',
            JSON.stringify({
              stage: 'owner-turn',
              result: 'failed',
              retryClass: 'uncertain',
              errorCode: 'orphaned-dispatch-receipt',
              message:
                'Accepted owner dispatch lost its grounding CAS; manual review is required.',
            }),
            nowIso,
            nowIso,
            context.admission.id,
            context.admission.version,
            input.attemptId,
          );
        insertAutopilotAdmissionEvent(database, {
          admissionId: context.admission.id,
          fromState: 'owner-turn-admitted',
          toState: 'manual-review',
          reason: 'owner-dispatch-grounding-cas-lost',
          data: {
            attemptId: input.attemptId,
            dispatchId: input.dispatchId,
            groundingSnapshotId: input.snapshotId,
          },
          now: nowIso,
        });
        return {
          status: 'orphaned-receipt' as const,
          dispatchId: input.dispatchId,
          ...context,
        };
      }
      if (!snapshot || !selectedMemoryIds.success) {
        throw new Error('Validated grounding state became unavailable.');
      }
      const attemptUpdate = database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET dispatch_id = ?, flue_instance_id = ?, owner_generation = ?,
               artifact_json = ?
           WHERE id = ? AND status = 'running' AND dispatch_id IS NULL;`,
        )
        .run(
          input.dispatchId,
          input.instanceId,
          input.generation,
          JSON.stringify({
            groundingSnapshotId: input.snapshotId,
            envelopeHash: snapshot.envelope_hash,
            policyHash: snapshot.policy_hash,
          }),
          input.attemptId,
        );
      const admissionUpdate = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = 'owner-turn-running', version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = 'owner-turn-admitted'
             AND current_stage_attempt_id = ?;`,
        )
        .run(
          nowIso,
          context.admission.id,
          input.expectedAdmissionVersion,
          input.attemptId,
        );
      if (attemptUpdate.changes !== 1 || admissionUpdate.changes !== 1) {
        throw new Error('Owner dispatch registration lost its CAS.');
      }
      database
        .prepare(
          `UPDATE autopilot_owner_grounding_snapshots
           SET status = 'accepted', dispatch_id = ?, accepted_at = ?
           WHERE id = ? AND status = 'reserved';`,
        )
        .run(input.dispatchId, nowIso, input.snapshotId);
      database
        .prepare(
          `UPDATE autopilot_pr_owners
           SET grounding_config_history_id = ?, grounding_memory_event_at = ?,
               grounding_memory_event_id = ?, grounding_memory_event_sequence = ?,
               grounding_memory_ids_json = ?,
               last_dispatched_sequence = MAX(last_dispatched_sequence, ?),
               status = 'active', updated_at = ?
           WHERE id = ? AND generation = ? AND flue_instance_id = ?;`,
        )
        .run(
          snapshot.config_history_id,
          snapshot.memory_event_at,
          snapshot.memory_event_id,
          snapshot.memory_event_sequence,
          JSON.stringify(selectedMemoryIds.output),
          context.admission.eventSequence,
          nowIso,
          context.owner.id,
          input.generation,
          input.instanceId,
        );
      insertAutopilotAdmissionEvent(database, {
        admissionId: context.admission.id,
        fromState: 'owner-turn-admitted',
        toState: 'owner-turn-running',
        reason: 'owner-dispatch-accepted',
        data: {
          attemptId: input.attemptId,
          dispatchId: input.dispatchId,
          instanceId: input.instanceId,
          generation: input.generation,
          groundingSnapshotId: input.snapshotId,
          envelopeHash: snapshot.envelope_hash,
        },
        now: nowIso,
      });
      return {
        status: 'running' as const,
        dispatchId: input.dispatchId,
        attempt: readAutopilotStageAttempt(
          database
            .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
            .get(input.attemptId),
        )!,
        admission: readAutopilotAdmission(
          database
            .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
            .get(context.admission.id),
        )!,
      };
    });
  } finally {
    database.close();
  }
}

function readContext(attemptId: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return readContextInDatabase(database, attemptId);
  } finally {
    database.close();
  }
}

function readContextInDatabase(
  database: ReturnType<typeof openDb>,
  attemptId: string,
) {
  const attempt = readAutopilotStageAttempt(
    database
      .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
      .get(attemptId),
  );
  if (!attempt) return undefined;
  const admission = readAutopilotAdmission(
    database
      .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
      .get(attempt.admissionId),
  );
  if (!admission) return undefined;
  const owner = readAutopilotPrOwner(
    database
      .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
      .get(attempt.ownerId),
  );
  return owner ? { attempt, admission, owner } : undefined;
}

function parsePersistedJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function defaultOwnerDispatcher(request: {
  agent: 'pr-autopilot-owner';
  id: string;
  input: string;
}) {
  return dispatch(request) as Promise<DispatchReceipt>;
}
