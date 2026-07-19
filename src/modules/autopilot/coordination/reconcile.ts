import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import {
  insertAutopilotAdmissionEvent,
  listAutopilotAdmissionsNeedingAdvance,
} from './advance';
import { readAutopilotAdmission, readAutopilotStageAttempt } from './schemas';
import {
  recordAutopilotStageTerminalObservation,
  settlePendingAutopilotStageObservation,
} from './settle';
import { isLegalAutopilotTransition } from './transitions';

export const defaultAutopilotReservationTimeoutMs = 5 * 60 * 1000;
export const defaultAutopilotStageTimeoutMs = 30 * 60 * 1000;
export const defaultAutopilotTerminalArtifactGraceMs = 30 * 1000;
export const defaultAutopilotTerminalFactRetentionMs = 60 * 60 * 1000;

export async function reconcileAutopilotStageAttempts(
  paths: RuntimePaths = runtimePaths(),
  options: {
    now?: Date;
    reservationTimeoutMs?: number;
    stageTimeoutMs?: number;
    terminalArtifactGraceMs?: number;
    terminalFactRetentionMs?: number;
  } = {},
) {
  await ensureRuntimeHome(paths);
  const now = options.now ?? new Date();
  const reservationBefore = new Date(
    now.getTime() -
      (options.reservationTimeoutMs ?? defaultAutopilotReservationTimeoutMs),
  ).toISOString();
  const stageBefore = new Date(
    now.getTime() - (options.stageTimeoutMs ?? defaultAutopilotStageTimeoutMs),
  ).toISOString();
  const terminalBefore = new Date(
    now.getTime() -
      (options.terminalArtifactGraceMs ??
        defaultAutopilotTerminalArtifactGraceMs),
  ).toISOString();
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let attempts;
  try {
    attempts = database
      .prepare(
        `SELECT attempt.*, observation.status AS observation_status,
                observation.last_event_at AS observation_last_event_at
         FROM autopilot_stage_attempts AS attempt
         LEFT JOIN workflow_run_observations AS observation
           ON observation.run_id = attempt.run_id
         WHERE attempt.status IN ('reserved', 'running')
           AND (
             (attempt.status = 'reserved' AND attempt.created_at <= ?)
             OR (attempt.status = 'running' AND attempt.run_id IS NULL
                 AND attempt.started_at <= ?)
             OR (attempt.status = 'running' AND attempt.run_id IS NOT NULL
                 AND attempt.started_at <= ?)
             OR observation.status IN ('completed', 'failed')
           );`,
      )
      .all(reservationBefore, reservationBefore, stageBefore);
  } finally {
    database.close();
  }

  const reconciled: string[] = [];
  for (const row of attempts) {
    const attempt = readAutopilotStageAttempt(row);
    if (!attempt) continue;
    if (attempt.status === 'reserved') {
      if (
        await markStaleAutopilotAttemptForManualReview(
          attempt.id,
          'reserved-dispatch-unattached',
          'The stage reservation expired before its external dispatch could be durably linked.',
          paths,
          now,
        )
      ) {
        reconciled.push(attempt.admissionId);
      }
      continue;
    }
    if (!attempt.runId) {
      if (
        await markStaleAutopilotAttemptForManualReview(
          attempt.id,
          'running-dispatch-unattached',
          'A running stage has no durable Flue run id.',
          paths,
          now,
        )
      ) {
        reconciled.push(attempt.admissionId);
      }
      continue;
    }
    const pending = await settlePendingAutopilotStageObservation(
      attempt.runId,
      paths,
      now,
    );
    if (pending.status === 'settled') {
      reconciled.push(attempt.admissionId);
      continue;
    }
    const observationStatus = stringField(row, 'observation_status');
    const observationAt = stringField(row, 'observation_last_event_at');
    if (observationStatus === 'failed') {
      const settled = await recordAutopilotStageTerminalObservation(
        {
          runId: attempt.runId,
          observation: {
            workflow: attempt.workflow ?? 'unknown',
            failed: true,
            errorCode: 'runner-unavailable',
            error: 'The attached Flue workflow run failed.',
          },
        },
        paths,
        now,
      );
      if (settled.status === 'settled') reconciled.push(attempt.admissionId);
      continue;
    }
    if (
      observationStatus === 'completed' &&
      observationAt &&
      observationAt <= terminalBefore
    ) {
      if (
        await markStaleAutopilotAttemptForManualReview(
          attempt.id,
          'terminal-artifact-missing',
          'The attached Flue run completed without its required durable terminal artifact.',
          paths,
          now,
        )
      ) {
        reconciled.push(attempt.admissionId);
      }
      continue;
    }
    if (
      attempt.startedAt &&
      attempt.startedAt <= stageBefore &&
      (observationStatus === 'active' || !observationStatus)
    ) {
      if (
        await markStaleAutopilotAttemptForManualReview(
          attempt.id,
          'stage-timeout',
          'The attached Flue run produced no terminal observation before the stage timeout.',
          paths,
          now,
        )
      ) {
        reconciled.push(attempt.admissionId);
      }
    }
  }

  const factBefore = new Date(
    now.getTime() -
      (options.terminalFactRetentionMs ??
        defaultAutopilotTerminalFactRetentionMs),
  ).toISOString();
  const cleanupDatabase = openDb(paths.neondeckDatabase);
  let removedTerminalFacts = 0;
  try {
    removedTerminalFacts = Number(
      cleanupDatabase
        .prepare(
          `DELETE FROM app_metadata
           WHERE key LIKE 'autopilot.stage.terminal:%' AND updated_at <= ?;`,
        )
        .run(factBefore).changes,
    );
  } finally {
    cleanupDatabase.close();
  }

  const due = await listAutopilotAdmissionsNeedingAdvance(paths, now);
  return {
    reconciledAdmissionIds: [...new Set(reconciled)],
    dueAdmissions: due,
    removedTerminalFacts,
  };
}

export async function markStaleAutopilotAttemptForManualReview(
  attemptId: string,
  reason: string,
  message: string,
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
          .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
          .get(attemptId),
      );
      if (
        !attempt ||
        (attempt.status !== 'reserved' && attempt.status !== 'running')
      ) {
        return false;
      }
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(attempt.admissionId),
      );
      if (!admission || admission.currentStageAttemptId !== attempt.id) {
        return false;
      }
      if (!isLegalAutopilotTransition(admission.state, 'manual-review')) {
        return false;
      }
      database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = 'failed', error = ?, finished_at = ?
           WHERE id = ? AND status IN ('reserved', 'running');`,
        )
        .run(message, nowIso, attempt.id);
      const outcome = {
        stage: attempt.stage,
        result: 'failed',
        retryClass: 'uncertain',
        errorCode: reason,
        message,
      } as const;
      const update = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = 'manual-review', current_workflow = NULL,
               current_run_id = NULL, current_stage_attempt_id = NULL,
               next_attempt_at = NULL, last_error = ?, last_outcome_json = ?,
               completed_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = ?
             AND current_stage_attempt_id = ?;`,
        )
        .run(
          message,
          JSON.stringify(outcome),
          nowIso,
          nowIso,
          admission.id,
          admission.version,
          admission.state,
          attempt.id,
        );
      if (update.changes !== 1) return false;
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: 'manual-review',
        reason,
        workflow: attempt.workflow,
        runId: attempt.runId,
        data: { attemptId: attempt.id, outcome },
        now: nowIso,
      });
      return true;
    });
  } finally {
    database.close();
  }
}

function stringField(row: unknown, key: string) {
  if (!row || typeof row !== 'object') return undefined;
  const value = (row as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
