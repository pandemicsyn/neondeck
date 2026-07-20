import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import { runUnattendedGit } from '../../../lib/git';
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
import {
  flushPendingAutopilotOwnerLearning,
  settlePendingAutopilotOwnerObservation,
} from '../owner/settle';
import { hasAutopilotSubmissionProcessLease } from '../owner/submission-lease';
import { readPreparedDiffRecord } from '../../prepared-diffs';

export const defaultAutopilotReservationTimeoutMs = 5 * 60 * 1000;
export const defaultAutopilotStageTimeoutMs = 30 * 60 * 1000;
export const defaultAutopilotOwnerStageTimeoutMs = 65 * 60 * 1000;
export const defaultAutopilotTerminalArtifactGraceMs = 30 * 1000;
export const defaultAutopilotTerminalFactRetentionMs = 60 * 60 * 1000;
export const defaultAutopilotOwnerApplyingTimeoutMs = 2 * 60 * 60 * 1000;
async function recoverPendingPushReceipts(paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase);
  try {
    const rows = database
      .prepare(
        `SELECT key, value FROM app_metadata
         WHERE key LIKE 'autopilot.push-reconciliation:%';`,
      )
      .all() as Array<{ key: string; value: string }>;
    const recovered: string[] = [];
    for (const row of rows) {
      let receipt: {
        preparedDiffId?: string;
        commitSha?: string;
        remote?: string;
        remoteUrl?: string;
        branch?: string;
        admissionId?: string | null;
        attemptId?: string | null;
        phase?: 'push-intent' | 'push-receipt';
      };
      try {
        receipt = JSON.parse(row.value) as typeof receipt;
      } catch {
        continue;
      }
      if (
        !receipt.preparedDiffId ||
        !receipt.commitSha ||
        !receipt.remote ||
        !receipt.branch ||
        !receipt.admissionId ||
        !receipt.attemptId
      )
        continue;
      const receiptAdmissionId = receipt.admissionId;
      const receiptAttemptId = receipt.attemptId;
      const receiptCommitSha = receipt.commitSha;
      const preparedDiffId = receipt.preparedDiffId;
      const preparedDiff = readPreparedDiffRecord(preparedDiffId, paths);
      if (!preparedDiff) continue;
      if (receipt.phase === 'push-intent') {
        const remoteSha = await readRemotePushSha(
          receipt.remoteUrl ?? receipt.remote,
          receipt.branch,
          paths,
        );
        if (remoteSha !== receipt.commitSha) continue;
      }
      const now = new Date().toISOString();
      const recoveredAdmission = withImmediateTransaction(database, () => {
        const admission = readAutopilotAdmission(
          database
            .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
            .get(receiptAdmissionId),
        );
        if (!admission || admission.preparedDiffId !== preparedDiffId) {
          return false;
        }
        const activeAttempt = database
          .prepare(
            `SELECT * FROM autopilot_stage_attempts
               WHERE id = ? AND admission_id = ? AND stage = 'push'
               LIMIT 1;`,
          )
          .get(receiptAttemptId, receiptAdmissionId);
        const attempt = readAutopilotStageAttempt(activeAttempt);
        if (!attempt) return false;
        const activePushAttempt =
          admission.state === 'push-admitted' &&
          admission.currentStageAttemptId === receiptAttemptId &&
          (attempt.status === 'reserved' || attempt.status === 'running');
        const terminalCancelledPush =
          admission.state !== 'push-admitted' && attempt.status === 'cancelled';
        // Never let an older receipt override a newer active push reservation.
        // The only non-current receipt that can still become canonical is a
        // terminal path which cancelled this exact push after Git accepted it.
        if (!activePushAttempt && !terminalCancelledPush) return false;
        database
          .prepare(
            `UPDATE prepared_diffs
               SET status = 'pushed', pushed_commit_sha = ?, updated_at = ?
               WHERE id = ?;`,
          )
          .run(receiptCommitSha, now, preparedDiffId);
        database
          .prepare(
            `UPDATE prepared_diff_approvals
               SET status = 'superseded',
                   reason = COALESCE(reason, 'push receipt recovered'),
                   resolved_at = COALESCE(resolved_at, ?), updated_at = ?
               WHERE prepared_diff_id = ? AND approval_type = 'push'
                 AND status IN ('pending', 'approved', 'rejected');`,
          )
          .run(now, now, preparedDiffId);
        database
          .prepare(
            `UPDATE worktrees SET lifecycle_status = 'succeeded',
                   last_pushed_sha = ?, updated_at = ? WHERE id = ?;`,
          )
          .run(receiptCommitSha, now, preparedDiff.worktreeId);
        if (terminalCancelledPush) {
          // Git already accepted the exact intent, but another durable path
          // (usually terminal cleanup) advanced the admission before the local
          // receipt was written. Preserve the side-effect fact without reviving
          // the terminal state or re-dispatching any workflow.
          database
            .prepare(
              `UPDATE autopilot_admissions
               SET pushed_commit_sha = COALESCE(pushed_commit_sha, ?),
                   updated_at = ? WHERE id = ?;`,
            )
            .run(receiptCommitSha, now, admission.id);
          insertAutopilotAdmissionEvent(database, {
            admissionId: admission.id,
            fromState: admission.state,
            toState: admission.state,
            reason: 'push-receipt-recovered-after-admission-transition',
            workflow: attempt.workflow ?? 'push-pr-autofix',
            runId: attempt.runId,
            data: {
              preparedDiffId,
              pushedCommitSha: receiptCommitSha,
              attemptId: receiptAttemptId,
            },
            now,
          });
          return true;
        }
        database
          .prepare(
            `UPDATE autopilot_stage_attempts
               SET status = 'completed', artifact_json = ?, error = NULL,
                   finished_at = ?
               WHERE id = ? AND status IN ('reserved', 'running');`,
          )
          .run(
            JSON.stringify({
              ...attempt.artifact,
              preparedDiffId,
              pushedCommitSha: receiptCommitSha,
              recoveredPushReceipt: true,
            }),
            now,
            attempt.id,
          );
        const updated = database
          .prepare(
            `UPDATE autopilot_admissions
               SET state = 'pushed', pushed_commit_sha = ?, current_workflow = NULL,
                   current_run_id = NULL, current_stage_attempt_id = NULL,
                   next_attempt_at = NULL, version = version + 1, updated_at = ?
               WHERE id = ? AND state = 'push-admitted'
                 AND current_stage_attempt_id = ?;`,
          )
          .run(receiptCommitSha, now, receiptAdmissionId, receiptAttemptId);
        if (updated.changes !== 1) return false;
        insertAutopilotAdmissionEvent(database, {
          admissionId: admission.id,
          fromState: admission.state,
          toState: 'pushed',
          reason: 'push-receipt-recovered',
          workflow: attempt.workflow ?? 'push-pr-autofix',
          runId: attempt.runId,
          data: {
            preparedDiffId,
            pushedCommitSha: receiptCommitSha,
            attemptId: attempt.id,
          },
          now,
        });
        return true;
      });
      if (recoveredAdmission) {
        recovered.push(receiptAdmissionId);
        database
          .prepare('DELETE FROM app_metadata WHERE key = ?;')
          .run(row.key);
      }
    }
    return recovered;
  } finally {
    database.close();
  }
}

async function readRemotePushSha(
  remote: string,
  branch: string,
  paths: RuntimePaths,
) {
  try {
    const stdout = await runUnattendedGit(paths.home, [
      'ls-remote',
      '--exit-code',
      '--',
      remote,
      `refs/heads/${branch}`,
    ]);
    return stdout.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

export async function reconcileAutopilotStageAttempts(
  paths: RuntimePaths = runtimePaths(),
  options: {
    now?: Date;
    reservationTimeoutMs?: number;
    stageTimeoutMs?: number;
    ownerStageTimeoutMs?: number;
    terminalArtifactGraceMs?: number;
    terminalFactRetentionMs?: number;
    ownerApplyingTimeoutMs?: number;
  } = {},
) {
  await ensureRuntimeHome(paths);
  const recoveredPushAdmissions = await recoverPendingPushReceipts(paths);
  await flushPendingAutopilotOwnerLearning(paths);
  const now = options.now ?? new Date();
  const reservationBefore = new Date(
    now.getTime() -
      (options.reservationTimeoutMs ?? defaultAutopilotReservationTimeoutMs),
  ).toISOString();
  const stageBefore = new Date(
    now.getTime() - (options.stageTimeoutMs ?? defaultAutopilotStageTimeoutMs),
  ).toISOString();
  const ownerStageBefore = new Date(
    now.getTime() -
      (options.ownerStageTimeoutMs ?? defaultAutopilotOwnerStageTimeoutMs),
  ).toISOString();
  const terminalBefore = new Date(
    now.getTime() -
      (options.terminalArtifactGraceMs ??
        defaultAutopilotTerminalArtifactGraceMs),
  ).toISOString();
  const ownerApplyingBefore = new Date(
    now.getTime() -
      (options.ownerApplyingTimeoutMs ??
        defaultAutopilotOwnerApplyingTimeoutMs),
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
             OR (attempt.stage = 'owner-turn' AND attempt.status = 'running')
           );`,
      )
      .all(reservationBefore, reservationBefore, stageBefore);
  } finally {
    database.close();
  }

  const reconciled: string[] = [...recoveredPushAdmissions];
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
    if (attempt.stage === 'owner-turn') {
      if (attempt.dispatchId) {
        const pending = await settlePendingAutopilotOwnerObservation(
          attempt.dispatchId,
          paths,
          now,
        );
        if (pending.status === 'settled') {
          reconciled.push(attempt.admissionId);
          continue;
        }
      }
      const applying = readOwnerApplyingSubmission(attempt.id, paths);
      if (applying) {
        if (hasAutopilotSubmissionProcessLease(attempt.id)) continue;
        if (
          applying.createdAt <= ownerApplyingBefore &&
          expireStaleOwnerApplyingSubmission(
            attempt.id,
            attempt.ownerId,
            ownerApplyingBefore,
            paths,
            now,
          ) &&
          (await markStaleAutopilotAttemptForManualReview(
            attempt.id,
            'owner-submission-lease-expired',
            'The owner fix submission lease expired after its worktree mutation lock was released or lost.',
            paths,
            now,
          ))
        ) {
          reconciled.push(attempt.admissionId);
        }
        continue;
      }
      if (
        !attempt.dispatchId &&
        attempt.startedAt &&
        attempt.startedAt <= reservationBefore
      ) {
        if (
          await markStaleAutopilotAttemptForManualReview(
            attempt.id,
            'owner-dispatch-unattached',
            'The owner turn has no durable Flue dispatch id.',
            paths,
            now,
          )
        ) {
          reconciled.push(attempt.admissionId);
        }
        continue;
      }
      if (attempt.startedAt && attempt.startedAt <= ownerStageBefore) {
        if (
          await markStaleAutopilotAttemptForManualReview(
            attempt.id,
            'owner-turn-timeout',
            'The attached owner dispatch produced no terminal observation before the owner stage timeout.',
            paths,
            now,
          )
        ) {
          reconciled.push(attempt.admissionId);
        }
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
           WHERE (key LIKE 'autopilot.stage.terminal:%'
                  OR (key LIKE 'autopilot.owner.terminal:%'
                      AND NOT EXISTS (
                        SELECT 1 FROM autopilot_stage_attempts AS attempts
                        WHERE attempts.status = 'running'
                          AND attempts.stage = 'owner-turn'
                          AND key = 'autopilot.owner.terminal:' || attempts.dispatch_id
                      )))
             AND updated_at <= ?;`,
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

function readOwnerApplyingSubmission(attemptId: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT created_at FROM autopilot_owner_fix_submissions
         WHERE attempt_id = ? AND status = 'applying';`,
      )
      .get(attemptId) as { created_at?: unknown } | undefined;
    return typeof row?.created_at === 'string'
      ? { createdAt: row.created_at }
      : null;
  } finally {
    database.close();
  }
}

function expireStaleOwnerApplyingSubmission(
  attemptId: string,
  ownerId: string,
  applyingBefore: string,
  paths: RuntimePaths,
  now: Date,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return (
      database
        .prepare(
          `UPDATE autopilot_owner_fix_submissions
           SET status = 'failed', error = ?, finished_at = ?
           WHERE attempt_id = ? AND status = 'applying' AND created_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM worktree_locks AS locks
               INNER JOIN autopilot_pr_owners AS owners
                 ON owners.worktree_id = locks.worktree_id
               WHERE owners.id = ? AND locks.released_at IS NULL
                 AND locks.expires_at > ?
             );`,
        )
        .run(
          'Owner fix submission lease expired during restart reconciliation.',
          now.toISOString(),
          attemptId,
          applyingBefore,
          ownerId,
          now.toISOString(),
        ).changes === 1
    );
  } finally {
    database.close();
  }
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
