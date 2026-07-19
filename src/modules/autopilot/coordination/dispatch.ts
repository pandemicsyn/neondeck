import type { JsonValue } from '@flue/runtime';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import type { AutopilotConcurrencyPolicy } from '../../autopilot-policy';
import {
  advanceAutopilotAdmission,
  insertAutopilotAdmissionEvent,
} from './advance';
import { classifyAutopilotRetry } from './retry';
import {
  readAutopilotAdmission,
  readAutopilotStageAttempt,
  type AutopilotAdmission,
  type AutopilotStageAttempt,
} from './schemas';
import {
  settleAutopilotDispatchFailure,
  settlePendingAutopilotStageObservation,
} from './settle';
import { autopilotStageRegistry } from './transitions';
import {
  dispatchReservedAutopilotOwnerTurn,
  type AutopilotOwnerDispatcher,
} from '../owner/dispatch';
import type {
  OwnerEnvelopeFactsLoader,
  OwnerEnvelopeLocalShaLoader,
  OwnerEnvelopeReadinessLoader,
} from '../owner/envelope';

export type PackageOneAutopilotWorkflow =
  'triage-pr-event' | 'prepare-pr-worktree';

export type AutopilotWorkflowInvoker = (
  workflow: PackageOneAutopilotWorkflow,
  input: JsonValue,
) => Promise<{ runId: string }>;

type DispatchContext = {
  attempt: AutopilotStageAttempt;
  admission: AutopilotAdmission;
};

export type AutopilotDispatchRegistrationResult =
  | { status: 'missing' }
  | ({ status: 'cas-lost' } & DispatchContext)
  | ({ status: 'orphaned-receipt'; runId: string } & DispatchContext)
  | ({ status: 'running'; runId: string } & DispatchContext);

export type AutopilotDispatchResult =
  | { status: 'missing' }
  | ({
      status:
        | 'not-reserved'
        | 'stale-reservation'
        | 'unsupported-transport'
        | 'cas-lost';
    } & DispatchContext)
  | ({ status: 'running'; runId: string } & DispatchContext)
  | ({ status: 'orphaned-receipt'; runId: string } & DispatchContext)
  | ({ status: 'dispatch-failed'; error: string } & DispatchContext);

export type AutopilotOwnerDispatchResult = Awaited<
  ReturnType<typeof dispatchReservedAutopilotOwnerTurn>
>;

export type CoordinateAutopilotAdmissionResult = {
  advanced: Awaited<ReturnType<typeof advanceAutopilotAdmission>>;
  dispatched: AutopilotDispatchResult | AutopilotOwnerDispatchResult | null;
};

export async function coordinateAutopilotAdmission(
  input: {
    admissionId: string;
    invokeWorkflow: AutopilotWorkflowInvoker;
    dispatchOwner?: AutopilotOwnerDispatcher;
    ownerFactsLoader?: OwnerEnvelopeFactsLoader;
    ownerReadinessLoader?: OwnerEnvelopeReadinessLoader;
    ownerLocalShaLoader?: OwnerEnvelopeLocalShaLoader;
    enableOwnerDispatch?: boolean;
    limits?: AutopilotConcurrencyPolicy;
    now?: Date;
  },
  paths: RuntimePaths = runtimePaths(),
): Promise<CoordinateAutopilotAdmissionResult> {
  const advanced = await advanceAutopilotAdmission(
    {
      admissionId: input.admissionId,
      allowOwnerTurnReservation: input.enableOwnerDispatch === true,
      limits: input.limits,
      now: input.now,
    },
    paths,
  );
  if (
    (advanced.status === 'reserved' ||
      advanced.status === 'already-reserved') &&
    advanced.attempt.status === 'reserved'
  ) {
    const dispatched = await dispatchReservedAutopilotStage(
      {
        attemptId: advanced.attempt.id,
        invokeWorkflow: input.invokeWorkflow,
        dispatchOwner: input.dispatchOwner,
        ownerFactsLoader: input.ownerFactsLoader,
        ownerReadinessLoader: input.ownerReadinessLoader,
        ownerLocalShaLoader: input.ownerLocalShaLoader,
        enableOwnerDispatch: input.enableOwnerDispatch,
        limits: input.limits,
      },
      paths,
      input.now,
    );
    if (dispatched.status === 'settled' && dispatched.queuedAdmissionId) {
      await coordinateAutopilotAdmission(
        {
          ...input,
          admissionId: dispatched.queuedAdmissionId,
        },
        paths,
      );
    }
    return { advanced, dispatched };
  }
  return { advanced, dispatched: null };
}

export async function dispatchReservedAutopilotStage(
  input: {
    attemptId: string;
    invokeWorkflow: AutopilotWorkflowInvoker;
    dispatchOwner?: AutopilotOwnerDispatcher;
    ownerFactsLoader?: OwnerEnvelopeFactsLoader;
    ownerReadinessLoader?: OwnerEnvelopeReadinessLoader;
    ownerLocalShaLoader?: OwnerEnvelopeLocalShaLoader;
    enableOwnerDispatch?: boolean;
    limits?: AutopilotConcurrencyPolicy;
  },
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
): Promise<AutopilotDispatchResult | AutopilotOwnerDispatchResult> {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let attempt;
  let admission;
  try {
    attempt = readAutopilotStageAttempt(
      database
        .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
        .get(input.attemptId),
    );
    admission = attempt
      ? readAutopilotAdmission(
          database
            .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
            .get(attempt.admissionId),
        )
      : undefined;
  } finally {
    database.close();
  }
  if (!attempt || !admission) return { status: 'missing' as const };
  if (attempt.status !== 'reserved') {
    return { status: 'not-reserved' as const, attempt, admission };
  }
  if (admission.currentStageAttemptId !== attempt.id) {
    return { status: 'stale-reservation' as const, attempt, admission };
  }
  if (attempt.stage === 'owner-turn') {
    if (!input.enableOwnerDispatch) {
      return deferReservedAutopilotOwnerTurn(attempt.id, paths, now);
    }
    return dispatchReservedAutopilotOwnerTurn(
      {
        attemptId: attempt.id,
        dispatchOwner: input.dispatchOwner,
        factsLoader: input.ownerFactsLoader,
        readinessLoader: input.ownerReadinessLoader,
        localShaLoader: input.ownerLocalShaLoader,
      },
      paths,
      now,
    );
  }
  if (attempt.stage !== 'triage' && attempt.stage !== 'prepare-worktree') {
    return {
      status: 'unsupported-transport' as const,
      attempt,
      admission,
    };
  }
  const registry = autopilotStageRegistry[attempt.stage];

  const claim = await claimAutopilotStageDispatch(
    {
      attemptId: attempt.id,
      expectedAdmissionVersion: admission.version,
    },
    paths,
    now,
  );
  if (claim.status !== 'claimed') return claim;

  let receipt: { runId: string };
  try {
    receipt = await input.invokeWorkflow(
      registry.workflow,
      workflowInput(admission, attempt.stage),
    );
  } catch (error) {
    const classification = classifyAutopilotRetry({
      error,
      idempotent: attempt.stage === 'triage',
      effectMayHaveCompleted: false,
    });
    await settleAutopilotDispatchFailure(
      {
        attemptId: attempt.id,
        classification,
        error: error instanceof Error ? error.message : String(error),
      },
      paths,
      now,
    );
    return {
      status: 'dispatch-failed' as const,
      attempt,
      admission,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const registration = await registerAutopilotStageDispatch(
    {
      attemptId: attempt.id,
      runId: receipt.runId,
      expectedAdmissionVersion: admission.version,
    },
    paths,
    now,
  );
  if (registration.status === 'running') {
    const pending = await settlePendingAutopilotStageObservation(
      receipt.runId,
      paths,
      now,
    );
    if (pending.status === 'settled' && pending.admission) {
      if (pending.admission.state !== 'prepared' || input.enableOwnerDispatch) {
        await coordinateAutopilotAdmission(
          {
            admissionId: pending.admission.id,
            invokeWorkflow: input.invokeWorkflow,
            dispatchOwner: input.dispatchOwner,
            ownerFactsLoader: input.ownerFactsLoader,
            ownerReadinessLoader: input.ownerReadinessLoader,
            ownerLocalShaLoader: input.ownerLocalShaLoader,
            enableOwnerDispatch: input.enableOwnerDispatch,
            limits: input.limits,
            now,
          },
          paths,
        );
      }
    }
  }
  return registration;
}

async function deferReservedAutopilotOwnerTurn(
  attemptId: string,
  paths: RuntimePaths,
  now: Date,
): Promise<AutopilotDispatchResult> {
  const nowIso = now.toISOString();
  const message =
    'Owner dispatch is disabled; the prepared admission remains deferred.';
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const attempt = readAutopilotStageAttempt(
        database
          .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
          .get(attemptId),
      );
      if (!attempt) return { status: 'missing' as const };
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(attempt.admissionId),
      );
      if (!admission) return { status: 'missing' as const };
      if (attempt.status !== 'reserved') {
        return { status: 'not-reserved' as const, attempt, admission };
      }
      if (
        attempt.stage !== 'owner-turn' ||
        admission.state !== 'owner-turn-admitted' ||
        admission.currentStageAttemptId !== attempt.id
      ) {
        return { status: 'stale-reservation' as const, attempt, admission };
      }

      const attemptUpdate = database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = 'cancelled', error = ?, finished_at = ?
           WHERE id = ? AND status = 'reserved' AND run_id IS NULL
             AND dispatch_id IS NULL;`,
        )
        .run(message, nowIso, attempt.id);
      const admissionUpdate = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = 'prepared', current_workflow = NULL,
               current_run_id = NULL, current_stage_attempt_id = NULL,
               version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = 'owner-turn-admitted'
             AND current_stage_attempt_id = ?;`,
        )
        .run(nowIso, admission.id, admission.version, attempt.id);
      if (attemptUpdate.changes !== 1 || admissionUpdate.changes !== 1) {
        throw new Error('Owner dispatch deferral lost its reservation CAS.');
      }
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: 'owner-turn-admitted',
        toState: 'prepared',
        reason: 'owner-dispatch-disabled',
        data: { attemptId: attempt.id },
        now: nowIso,
      });
      return {
        status: 'unsupported-transport' as const,
        attempt: readAutopilotStageAttempt(
          database
            .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
            .get(attempt.id),
        )!,
        admission: readAutopilotAdmission(
          database
            .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
            .get(admission.id),
        )!,
      };
    });
  } finally {
    database.close();
  }
}

export async function registerAutopilotStageDispatch(
  input: {
    attemptId: string;
    runId: string;
    expectedAdmissionVersion: number;
  },
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
): Promise<AutopilotDispatchRegistrationResult> {
  await ensureRuntimeHome(paths);
  const nowIso = now.toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const attempt = readAutopilotStageAttempt(
        database
          .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
          .get(input.attemptId),
      );
      if (!attempt) return { status: 'missing' as const };
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(attempt.admissionId),
      );
      if (!admission) return { status: 'missing' as const };
      const registrationIsCurrent =
        attempt.status === 'running' &&
        attempt.runId === null &&
        admission.currentStageAttemptId === attempt.id &&
        admission.version === input.expectedAdmissionVersion &&
        !admission.stopRequestedAt;
      if (!registrationIsCurrent && attempt.runId === null) {
        const message =
          'Flue accepted the stage, but its receipt lost the admission CAS and cannot advance it.';
        const receiptUpdate = database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET run_id = ?,
                 status = CASE
                   WHEN status IN ('reserved', 'running') THEN 'failed'
                   ELSE status
                 END,
                 error = COALESCE(error, ?),
                 finished_at = CASE
                   WHEN status IN ('reserved', 'running') THEN ?
                   ELSE finished_at
                 END
             WHERE id = ? AND run_id IS NULL;`,
          )
          .run(input.runId, message, nowIso, attempt.id);
        if (receiptUpdate.changes !== 1) {
          return { status: 'cas-lost' as const, attempt, admission };
        }
        const orphanedOutcome = {
          stage: attempt.stage,
          result: 'failed',
          retryClass: 'uncertain',
          errorCode: 'orphaned-dispatch-receipt',
          message,
        } as const;
        const admissionUpdate =
          admission.currentStageAttemptId === attempt.id &&
          (admission.state === 'triage-admitted' ||
            admission.state === 'prepare-admitted')
            ? database
                .prepare(
                  `UPDATE autopilot_admissions
                   SET state = 'manual-review', current_workflow = NULL,
                       current_run_id = NULL, current_stage_attempt_id = NULL,
                       next_attempt_at = NULL, last_error = ?,
                       last_outcome_json = ?, completed_at = ?,
                       version = version + 1, updated_at = ?
                   WHERE id = ? AND version = ? AND state = ?
                     AND current_stage_attempt_id = ?;`,
                )
                .run(
                  message,
                  JSON.stringify(orphanedOutcome),
                  nowIso,
                  nowIso,
                  admission.id,
                  admission.version,
                  admission.state,
                  attempt.id,
                )
            : undefined;
        if (admissionUpdate && admissionUpdate.changes !== 1) {
          return { status: 'cas-lost' as const, attempt, admission };
        }
        insertAutopilotAdmissionEvent(database, {
          admissionId: admission.id,
          fromState: admission.state,
          toState: admissionUpdate ? 'manual-review' : admission.state,
          reason: admissionUpdate
            ? 'orphaned-dispatch-receipt-manual-review'
            : 'orphaned-dispatch-receipt-recorded',
          workflow: attempt.workflow,
          runId: input.runId,
          data: {
            attemptId: attempt.id,
            attemptStatus: attempt.status,
            expectedAdmissionVersion: input.expectedAdmissionVersion,
            actualAdmissionVersion: admission.version,
            outcome: admissionUpdate ? orphanedOutcome : undefined,
          },
          now: nowIso,
        });
        const updatedAttempt = readAutopilotStageAttempt(
          database
            .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
            .get(attempt.id),
        );
        if (!updatedAttempt) {
          throw new Error('Orphaned autopilot receipt could not be read.');
        }
        const updatedAdmission = admissionUpdate
          ? readAutopilotAdmission(
              database
                .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
                .get(admission.id),
            )
          : admission;
        if (!updatedAdmission) {
          throw new Error('Orphaned autopilot admission could not be read.');
        }
        return {
          status: 'orphaned-receipt' as const,
          runId: input.runId,
          attempt: updatedAttempt,
          admission: updatedAdmission,
        };
      }
      if (!registrationIsCurrent || attempt.runId !== null) {
        return { status: 'cas-lost' as const, attempt, admission };
      }
      const attemptUpdate = database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET run_id = ?
           WHERE id = ? AND status = 'running' AND run_id IS NULL;`,
        )
        .run(input.runId, attempt.id);
      if (attemptUpdate.changes !== 1) {
        return { status: 'cas-lost' as const, attempt, admission };
      }
      const admissionUpdate = database
        .prepare(
          `UPDATE autopilot_admissions
           SET current_run_id = ?, updated_at = ?
           WHERE id = ? AND version = ? AND current_stage_attempt_id = ?
             AND stop_requested_at IS NULL;`,
        )
        .run(
          input.runId,
          nowIso,
          admission.id,
          input.expectedAdmissionVersion,
          attempt.id,
        );
      if (admissionUpdate.changes !== 1) {
        throw new Error(
          'Autopilot dispatch registration lost its admission CAS.',
        );
      }
      database
        .prepare(
          `UPDATE autopilot_pr_owners
           SET status = CASE WHEN status = 'awaiting-event' THEN 'active' ELSE status END,
               last_dispatched_sequence = MAX(last_dispatched_sequence, ?),
               updated_at = ?
           WHERE id = ?;`,
        )
        .run(admission.eventSequence, nowIso, admission.ownerId);
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: admission.state,
        reason: 'stage-dispatched',
        workflow: attempt.workflow,
        runId: input.runId,
        data: { attemptId: attempt.id, attemptNumber: attempt.attemptNumber },
        now: nowIso,
      });
      const updatedAttempt = readAutopilotStageAttempt(
        database
          .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
          .get(attempt.id),
      );
      const updatedAdmission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(admission.id),
      );
      if (!updatedAttempt || !updatedAdmission) {
        throw new Error('Registered autopilot dispatch could not be read.');
      }
      return {
        status: 'running' as const,
        attempt: updatedAttempt,
        admission: updatedAdmission,
        runId: input.runId,
      };
    });
  } finally {
    database.close();
  }
}

export async function claimAutopilotStageDispatch(
  input: { attemptId: string; expectedAdmissionVersion: number },
  paths: RuntimePaths,
  now: Date,
) {
  const nowIso = now.toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const attempt = readAutopilotStageAttempt(
        database
          .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
          .get(input.attemptId),
      );
      if (!attempt) return { status: 'missing' as const };
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(attempt.admissionId),
      );
      if (!admission) return { status: 'missing' as const };
      if (
        attempt.status !== 'reserved' ||
        admission.currentStageAttemptId !== attempt.id ||
        admission.version !== input.expectedAdmissionVersion ||
        admission.stopRequestedAt
      ) {
        return { status: 'cas-lost' as const, attempt, admission };
      }
      const update = database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = 'running', started_at = ?
           WHERE id = ? AND status = 'reserved';`,
        )
        .run(nowIso, attempt.id);
      if (update.changes !== 1) {
        return { status: 'cas-lost' as const, attempt, admission };
      }
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: admission.state,
        reason: 'stage-dispatch-claimed',
        workflow: attempt.workflow,
        data: { attemptId: attempt.id },
        now: nowIso,
      });
      return { status: 'claimed' as const, attempt, admission };
    });
  } finally {
    database.close();
  }
}

function workflowInput(
  admission: NonNullable<ReturnType<typeof readAutopilotAdmission>>,
  stage: string,
) {
  if (stage === 'triage') {
    return {
      ...admission.input,
      admissionId: admission.id,
    } as JsonValue;
  }
  if (stage === 'prepare-worktree') {
    return {
      repoId: admission.repoId,
      prNumber: admission.prNumber,
      eventId: admission.eventFingerprint,
      ownerId: admission.ownerId,
      worktreeId: admission.worktreeId ?? undefined,
      lock: false,
      sourceEvent: admission.input,
    } as JsonValue;
  }
  throw new Error(`Package 1 cannot dispatch autopilot stage ${stage}.`);
}
