import type { DatabaseSync } from 'node:sqlite';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import { insertAutopilotAdmissionEvent } from './advance';
import {
  readAutopilotAdmission,
  readAutopilotStageAttempt,
  type AutopilotAdmissionState,
} from './schemas';
import { isLegalAutopilotTransition } from './transitions';

export async function stopAutopilotAdmission(
  input: {
    admissionId: string;
    expectedVersion?: number;
    reason?: string;
  },
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  return finishAutopilotAdmission(
    {
      ...input,
      target: 'stopped',
      reason: input.reason ?? 'operator-stop-requested',
    },
    paths,
    now,
  );
}

export async function supersedeAutopilotAdmission(
  input: {
    admissionId: string;
    expectedVersion?: number;
    reason?: string;
  },
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  return finishAutopilotAdmission(
    {
      ...input,
      target: 'superseded',
      reason: input.reason ?? 'newer-pr-event-superseded-attempt',
    },
    paths,
    now,
  );
}

async function finishAutopilotAdmission(
  input: {
    admissionId: string;
    expectedVersion?: number;
    target: Extract<AutopilotAdmissionState, 'stopped' | 'superseded'>;
    reason: string;
  },
  paths: RuntimePaths,
  now: Date,
) {
  await ensureRuntimeHome(paths);
  const nowIso = now.toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(input.admissionId),
      );
      if (!admission) return { status: 'missing' as const };
      if (admission.state === input.target) {
        if (input.target === 'stopped') {
          stopRemainingOwnerAdmissions(
            database,
            admission.ownerId,
            admission.id,
            input.reason,
            nowIso,
          );
          markOwnerDraining(database, admission.ownerId, nowIso);
        }
        return { status: 'already-finished' as const, admission };
      }
      if (
        input.expectedVersion !== undefined &&
        admission.version !== input.expectedVersion
      ) {
        return { status: 'cas-lost' as const, admission };
      }
      if (!isLegalAutopilotTransition(admission.state, input.target)) {
        return { status: 'illegal' as const, admission };
      }
      const attempt = admission.currentStageAttemptId
        ? readAutopilotStageAttempt(
            database
              .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
              .get(admission.currentStageAttemptId),
          )
        : undefined;
      if (
        attempt &&
        (attempt.status === 'reserved' || attempt.status === 'running')
      ) {
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
             SET status = 'cancelled', error = ?, finished_at = ?
             WHERE id = ? AND status IN ('reserved', 'running');`,
          )
          .run(input.reason, nowIso, attempt.id);
      }
      const outcome = {
        stage: attempt?.stage ?? admission.lastOutcome?.stage ?? 'triage',
        result: 'cancelled',
        message: input.reason,
      } as const;
      const update = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = ?, current_workflow = NULL, current_run_id = NULL,
               current_stage_attempt_id = NULL, next_attempt_at = NULL,
               last_error = ?, last_outcome_json = ?, stop_requested_at = ?,
               completed_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = ?;`,
        )
        .run(
          input.target,
          input.reason,
          JSON.stringify(outcome),
          input.target === 'stopped' ? nowIso : admission.stopRequestedAt,
          nowIso,
          nowIso,
          admission.id,
          admission.version,
          admission.state,
        );
      if (update.changes !== 1) {
        return { status: 'cas-lost' as const, admission };
      }
      if (input.target === 'stopped') {
        stopRemainingOwnerAdmissions(
          database,
          admission.ownerId,
          admission.id,
          input.reason,
          nowIso,
        );
        markOwnerDraining(database, admission.ownerId, nowIso);
      }
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: input.target,
        reason: input.reason,
        workflow: attempt?.workflow,
        runId: attempt?.runId,
        data: { attemptId: attempt?.id ?? null },
        now: nowIso,
      });
      return {
        status: input.target as 'stopped' | 'superseded',
        admission: readAutopilotAdmission(
          database
            .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
            .get(admission.id),
        ),
      };
    });
  } finally {
    database.close();
  }
}

function stopRemainingOwnerAdmissions(
  database: DatabaseSync,
  ownerId: string,
  excludedAdmissionId: string,
  reason: string,
  now: string,
) {
  const admissions = database
    .prepare(
      `SELECT * FROM autopilot_admissions
       WHERE owner_id = ? AND id <> ? AND state NOT IN
         ('archived', 'completed', 'stopped', 'superseded');`,
    )
    .all(ownerId, excludedAdmissionId)
    .map(readAutopilotAdmission)
    .filter((admission) => Boolean(admission));
  for (const admission of admissions) {
    if (!admission || !isLegalAutopilotTransition(admission.state, 'stopped')) {
      continue;
    }
    const attempt = admission.currentStageAttemptId
      ? readAutopilotStageAttempt(
          database
            .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
            .get(admission.currentStageAttemptId),
        )
      : undefined;
    if (
      attempt &&
      (attempt.status === 'reserved' || attempt.status === 'running')
    ) {
      database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = 'cancelled', error = ?, finished_at = ?
           WHERE id = ? AND status IN ('reserved', 'running');`,
        )
        .run(reason, now, attempt.id);
    }
    const outcome = {
      stage: attempt?.stage ?? admission.lastOutcome?.stage ?? 'triage',
      result: 'cancelled',
      message: reason,
    } as const;
    const update = database
      .prepare(
        `UPDATE autopilot_admissions
         SET state = 'stopped', current_workflow = NULL, current_run_id = NULL,
             current_stage_attempt_id = NULL, next_attempt_at = NULL,
             last_error = ?, last_outcome_json = ?, stop_requested_at = ?,
             completed_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ? AND state = ?;`,
      )
      .run(
        reason,
        JSON.stringify(outcome),
        now,
        now,
        now,
        admission.id,
        admission.version,
        admission.state,
      );
    if (update.changes !== 1) continue;
    insertAutopilotAdmissionEvent(database, {
      admissionId: admission.id,
      fromState: admission.state,
      toState: 'stopped',
      reason,
      workflow: attempt?.workflow,
      runId: attempt?.runId,
      data: { attemptId: attempt?.id ?? null, ownerScoped: true },
      now,
    });
  }
}

function markOwnerDraining(
  database: DatabaseSync,
  ownerId: string,
  now: string,
) {
  database
    .prepare(
      `UPDATE autopilot_pr_owners
       SET status = CASE WHEN status = 'archived' THEN status ELSE 'draining' END,
           updated_at = ?
       WHERE id = ?;`,
    )
    .run(now, ownerId);
}
