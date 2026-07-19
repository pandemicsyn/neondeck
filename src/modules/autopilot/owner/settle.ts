import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import { insertAutopilotAdmissionEvent } from '../coordination/advance';
import { coalesceQueuedOwnerAdmissionsInDatabase } from './queue';
import {
  readAutopilotAdmission,
  readAutopilotStageAttempt,
  type AutopilotAdmissionState,
} from '../coordination/schemas';

const terminalPrefix = 'autopilot.owner.terminal:';

export type AutopilotOwnerTerminalObservation = {
  agent: 'pr-autopilot-owner';
  instanceId: string;
  dispatchId: string;
  failed: boolean;
  error?: string | null;
  source: 'agent_end' | 'operation' | 'submission_settled';
};

export async function recordAutopilotOwnerTerminalObservation(
  observation: AutopilotOwnerTerminalObservation,
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING;`,
      )
      .run(
        `${terminalPrefix}${observation.dispatchId}`,
        JSON.stringify(observation),
        now.toISOString(),
      );
  } finally {
    database.close();
  }
  return settlePendingAutopilotOwnerObservation(
    observation.dispatchId,
    paths,
    now,
  );
}

export async function settlePendingAutopilotOwnerObservation(
  dispatchId: string,
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let observation: AutopilotOwnerTerminalObservation | undefined;
  try {
    const row = database
      .prepare('SELECT value FROM app_metadata WHERE key = ?;')
      .get(`${terminalPrefix}${dispatchId}`) as { value?: unknown } | undefined;
    if (typeof row?.value === 'string') {
      try {
        observation = JSON.parse(
          row.value,
        ) as AutopilotOwnerTerminalObservation;
      } catch {
        observation = undefined;
      }
    }
  } finally {
    database.close();
  }
  if (!observation) return { status: 'pending' as const };
  return settleAutopilotOwnerObservation(observation, paths, now);
}

export async function settleAutopilotOwnerObservation(
  observation: AutopilotOwnerTerminalObservation,
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const nowIso = now.toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const attempt = readAutopilotStageAttempt(
        database
          .prepare(
            'SELECT * FROM autopilot_stage_attempts WHERE dispatch_id = ?;',
          )
          .get(observation.dispatchId),
      );
      if (!attempt) return { status: 'unattached' as const };
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(attempt.admissionId),
      );
      if (!admission) return { status: 'missing' as const };
      if (
        attempt.status !== 'running' ||
        attempt.flueInstanceId !== observation.instanceId ||
        admission.currentStageAttemptId !== attempt.id ||
        admission.state !== 'owner-turn-running'
      ) {
        database
          .prepare('DELETE FROM app_metadata WHERE key = ?;')
          .run(`${terminalPrefix}${observation.dispatchId}`);
        return { status: 'stale-or-duplicate' as const, attempt, admission };
      }
      const submission = database
        .prepare(
          `SELECT status, prepared_diff_id, result_json, error
           FROM autopilot_owner_fix_submissions WHERE attempt_id = ?;`,
        )
        .get(attempt.id) as
        | {
            status?: unknown;
            prepared_diff_id?: unknown;
            result_json?: unknown;
            error?: unknown;
          }
        | undefined;
      if (submission?.status === 'applying') {
        return {
          status: 'submission-applying' as const,
          attempt,
          admission,
        };
      }
      const settlement = ownerSettlement(observation, submission, nowIso);
      const attemptUpdate = database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = ?, artifact_json = ?, error = ?, finished_at = ?
           WHERE id = ? AND status = 'running' AND dispatch_id = ?;`,
        )
        .run(
          settlement.attemptStatus,
          JSON.stringify(settlement.artifact),
          settlement.message,
          nowIso,
          attempt.id,
          observation.dispatchId,
        );
      if (attemptUpdate.changes !== 1) {
        return { status: 'cas-lost' as const, attempt, admission };
      }
      const admissionUpdate = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = ?, current_workflow = NULL, current_stage_attempt_id = NULL,
               prepared_diff_id = COALESCE(?, prepared_diff_id), fixer_kind = 'neon-owner',
               next_attempt_at = ?, last_error = ?, last_outcome_json = ?,
               completed_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = 'owner-turn-running'
             AND current_stage_attempt_id = ?;`,
        )
        .run(
          settlement.state,
          settlement.preparedDiffId,
          settlement.nextAttemptAt,
          settlement.message,
          JSON.stringify(settlement.outcome),
          settlement.completedAt,
          nowIso,
          admission.id,
          admission.version,
          attempt.id,
        );
      if (admissionUpdate.changes !== 1) {
        throw new Error('Owner terminal settlement lost its admission CAS.');
      }
      database
        .prepare(
          `UPDATE autopilot_pr_owners
           SET last_settled_sequence = MAX(last_settled_sequence, ?), updated_at = ?
           WHERE id = ? AND generation = ? AND flue_instance_id = ?;`,
        )
        .run(
          admission.eventSequence,
          nowIso,
          admission.ownerId,
          attempt.ownerGeneration,
          attempt.flueInstanceId,
        );
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: settlement.state,
        reason: settlement.reason,
        data: {
          attemptId: attempt.id,
          dispatchId: observation.dispatchId,
          ownerGeneration: attempt.ownerGeneration,
          outcome: settlement.outcome,
        },
        now: nowIso,
      });
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(`${terminalPrefix}${observation.dispatchId}`);
      const queuedAdmissionId =
        settlement.nextAttemptAt === null
          ? coalesceQueuedOwnerAdmissionsInDatabase(
              database,
              admission.ownerId,
              nowIso,
            )
          : null;
      return {
        status: 'settled' as const,
        admission: readAutopilotAdmission(
          database
            .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
            .get(admission.id),
        ),
        attemptId: attempt.id,
        queuedAdmissionId,
      };
    });
  } finally {
    database.close();
  }
}

function ownerSettlement(
  observation: AutopilotOwnerTerminalObservation,
  submission:
    | {
        status?: unknown;
        prepared_diff_id?: unknown;
        result_json?: unknown;
        error?: unknown;
      }
    | undefined,
  now: string,
) {
  if (
    submission?.status === 'prepared' &&
    typeof submission.prepared_diff_id === 'string'
  ) {
    return {
      state: 'fix-prepared' as const,
      attemptStatus: 'completed' as const,
      preparedDiffId: submission.prepared_diff_id,
      nextAttemptAt: null,
      completedAt: null,
      message: null,
      reason: 'owner-fix-prepared',
      artifact: parseJson(submission.result_json),
      outcome: {
        stage: 'owner-turn' as const,
        result: 'completed' as const,
        preparedDiffId: submission.prepared_diff_id,
        artifact: parseJson(submission.result_json),
      },
    };
  }
  if (submission?.status === 'no-op') {
    return {
      state: 'completed' as const,
      attemptStatus: 'completed' as const,
      preparedDiffId: null,
      nextAttemptAt: null,
      completedAt: now,
      message: null,
      reason: 'owner-explicit-no-op',
      artifact: parseJson(submission.result_json),
      outcome: {
        stage: 'owner-turn' as const,
        result: 'completed' as const,
        artifact: parseJson(submission.result_json),
      },
    };
  }
  if (observation.failed) {
    const message = observation.error ?? 'The PR-owner model turn failed.';
    return failedSettlement('model-failure', message, now, true);
  }
  const message =
    typeof submission?.error === 'string'
      ? submission.error
      : 'The PR-owner turn ended without a valid one-time fix submission.';
  return failedSettlement('missing-or-invalid-submission', message, now, false);
}

function failedSettlement(
  code: string,
  message: string,
  now: string,
  retry: boolean,
) {
  return {
    state: (retry ? 'failed' : 'blocked') as AutopilotAdmissionState,
    attemptStatus: (retry ? 'failed' : 'blocked') as 'failed' | 'blocked',
    preparedDiffId: null,
    nextAttemptAt: retry
      ? new Date(Date.parse(now) + 30_000).toISOString()
      : null,
    completedAt: null,
    message,
    reason: code,
    artifact: {},
    outcome: {
      stage: 'owner-turn' as const,
      result: (retry ? 'failed' : 'blocked') as 'failed' | 'blocked',
      retryClass: (retry ? 'transient' : 'permanent') as
        'transient' | 'permanent',
      retryStage: retry ? ('owner-turn' as const) : undefined,
      resumeState: 'owner-turn-admitted' as const,
      errorCode: code,
      message,
    },
  };
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
