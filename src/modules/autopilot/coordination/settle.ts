import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import { insertAutopilotAdmissionEvent } from './advance';
import {
  autopilotRetryDecision,
  classifyAutopilotRetry,
  type AutopilotRetryClassification,
} from './retry';
import {
  autopilotTerminalObservationSchema,
  readAutopilotAdmission,
  readAutopilotStageAttempt,
  type AutopilotAdmissionState,
  type AutopilotStage,
  type AutopilotStageOutcome,
  type AutopilotTerminalObservation,
} from './schemas';
import {
  autopilotStageRegistry,
  isLegalAutopilotTransition,
} from './transitions';

const terminalObservationPrefix = 'autopilot.stage.terminal:';

export async function recordAutopilotStageTerminalObservation(
  input: { runId: string; observation: AutopilotTerminalObservation },
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
        terminalObservationKey(input.runId),
        JSON.stringify(input.observation),
        now.toISOString(),
      );
  } finally {
    database.close();
  }
  return settlePendingAutopilotStageObservation(input.runId, paths, now);
}

export async function settlePendingAutopilotStageObservation(
  runId: string,
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let observation: AutopilotTerminalObservation | undefined;
  try {
    observation = readTerminalObservation(
      database
        .prepare('SELECT value FROM app_metadata WHERE key = ?;')
        .get(terminalObservationKey(runId)),
    );
  } finally {
    database.close();
  }
  if (!observation) return { status: 'pending' as const };
  return settleAutopilotStageObservation({ runId, observation }, paths, now);
}

export async function settleAutopilotStageObservation(
  input: { runId: string; observation: AutopilotTerminalObservation },
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
          .prepare('SELECT * FROM autopilot_stage_attempts WHERE run_id = ?;')
          .get(input.runId),
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
        admission.currentStageAttemptId !== attempt.id ||
        admission.currentRunId !== input.runId
      ) {
        database
          .prepare('DELETE FROM app_metadata WHERE key = ?;')
          .run(terminalObservationKey(input.runId));
        return { status: 'stale-or-duplicate' as const, attempt, admission };
      }
      const expectedWorkflow = autopilotStageRegistry[attempt.stage].workflow;
      if (expectedWorkflow !== input.observation.workflow) {
        return { status: 'workflow-mismatch' as const, attempt, admission };
      }

      const settlement = terminalSettlement(
        admission.state,
        attempt.stage,
        attempt.attemptNumber,
        input.observation,
        now,
      );
      if (!isLegalAutopilotTransition(admission.state, settlement.state)) {
        throw new Error(
          `Illegal autopilot settlement ${admission.state} -> ${settlement.state}.`,
        );
      }
      const attemptUpdate = database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = ?, artifact_json = ?, error = ?, finished_at = ?
           WHERE id = ? AND status = 'running' AND run_id = ?;`,
        )
        .run(
          settlement.attemptStatus,
          JSON.stringify(settlement.outcome.artifact ?? {}),
          'message' in settlement.outcome
            ? (settlement.outcome.message ?? null)
            : null,
          nowIso,
          attempt.id,
          input.runId,
        );
      if (attemptUpdate.changes !== 1) {
        return { status: 'cas-lost' as const, attempt, admission };
      }
      const admissionUpdate = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = ?, current_workflow = NULL, current_run_id = NULL,
               current_stage_attempt_id = NULL, worktree_id = COALESCE(?, worktree_id),
               prepared_diff_id = COALESCE(?, prepared_diff_id),
               pushed_commit_sha = COALESCE(?, pushed_commit_sha),
               next_attempt_at = ?, last_error = ?, last_outcome_json = ?,
               completed_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = ?
             AND current_stage_attempt_id = ? AND current_run_id = ?;`,
        )
        .run(
          settlement.state,
          'worktreeId' in settlement.outcome
            ? (settlement.outcome.worktreeId ?? null)
            : null,
          settlement.outcome.preparedDiffId ?? null,
          typeof settlement.outcome.artifact?.pushedCommitSha === 'string'
            ? settlement.outcome.artifact.pushedCommitSha
            : null,
          settlement.nextAttemptAt,
          'message' in settlement.outcome
            ? (settlement.outcome.message ?? null)
            : null,
          JSON.stringify(settlement.outcome),
          settlement.completedAt,
          nowIso,
          admission.id,
          admission.version,
          admission.state,
          attempt.id,
          input.runId,
        );
      if (admissionUpdate.changes !== 1) {
        throw new Error(
          'Autopilot terminal settlement lost its admission CAS.',
        );
      }
      database
        .prepare(
          `UPDATE autopilot_pr_owners
           SET worktree_id = COALESCE(?, worktree_id),
               last_settled_sequence = MAX(last_settled_sequence, ?),
               status = CASE WHEN ? = 'archived' THEN 'archived' ELSE status END,
               archived_at = CASE WHEN ? = 'archived' THEN COALESCE(archived_at, ?) ELSE archived_at END,
               updated_at = ?
           WHERE id = ?;`,
        )
        .run(
          'worktreeId' in settlement.outcome
            ? (settlement.outcome.worktreeId ?? null)
            : null,
          admission.eventSequence,
          settlement.state,
          settlement.state,
          nowIso,
          nowIso,
          admission.ownerId,
        );
      if (settlement.state === 'archived') {
        database
          .prepare(
            `UPDATE autopilot_owner_generations
             SET status = 'archived', archived_at = COALESCE(archived_at, ?)
             WHERE owner_id = ? AND status = 'active';`,
          )
          .run(nowIso, admission.ownerId);
        database
          .prepare(
            `UPDATE scheduled_tasks
             SET enabled = 0, updated_at = ?
             WHERE id = ?;`,
          )
          .run(nowIso, `watch:${admission.watchId}`);
        database
          .prepare(
            `UPDATE chat_sessions
             SET archived_at = COALESCE(archived_at, ?), updated_at = ?
             WHERE id = (
               SELECT chat_session_id FROM autopilot_pr_owners WHERE id = ?
             );`,
          )
          .run(nowIso, nowIso, admission.ownerId);
      }
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: settlement.state,
        reason: settlement.reason,
        workflow: attempt.workflow,
        runId: input.runId,
        data: {
          attemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          outcome: settlement.outcome,
        },
        now: nowIso,
      });
      database
        .prepare('DELETE FROM app_metadata WHERE key = ?;')
        .run(terminalObservationKey(input.runId));
      const updated = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(admission.id),
      );
      return {
        status: 'settled' as const,
        admission: updated,
        attemptId: attempt.id,
      };
    });
  } finally {
    database.close();
  }
}

export async function settleAutopilotDispatchFailure(
  input: {
    attemptId: string;
    classification: AutopilotRetryClassification;
    error: string;
  },
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
          .get(input.attemptId),
      );
      if (!attempt) return { status: 'missing' as const };
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(attempt.admissionId),
      );
      if (
        !admission ||
        attempt.status !== 'running' ||
        attempt.runId !== null ||
        admission.currentStageAttemptId !== attempt.id
      ) {
        return { status: 'stale-or-duplicate' as const, attempt, admission };
      }
      const retry = autopilotRetryDecision(
        attempt.attemptNumber,
        input.classification,
        now,
      );
      const state: AutopilotAdmissionState = retry.exhausted
        ? 'manual-review'
        : input.classification.kind === 'permanent'
          ? 'blocked'
          : input.classification.kind === 'uncertain'
            ? 'manual-review'
            : 'failed';
      const outcome: AutopilotStageOutcome = {
        stage: attempt.stage,
        result: state === 'blocked' ? 'blocked' : 'failed',
        retryClass: input.classification.kind,
        retryStage: retry.automatic ? attempt.stage : undefined,
        resumeState: autopilotStageRegistry[attempt.stage].admittedState,
        errorCode: input.classification.code,
        message: input.error,
      };
      if (!isLegalAutopilotTransition(admission.state, state)) {
        throw new Error(
          `Illegal autopilot dispatch failure ${admission.state} -> ${state}.`,
        );
      }
      database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = ?, error = ?, finished_at = ?
           WHERE id = ? AND status = 'running' AND run_id IS NULL;`,
        )
        .run(
          state === 'blocked' ? 'blocked' : 'failed',
          input.error,
          nowIso,
          attempt.id,
        );
      const update = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = ?, current_workflow = NULL, current_stage_attempt_id = NULL,
               next_attempt_at = ?, last_error = ?, last_outcome_json = ?,
               completed_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = ?
             AND current_stage_attempt_id = ?;`,
        )
        .run(
          state,
          retry.nextAttemptAt,
          input.error,
          JSON.stringify(outcome),
          state === 'manual-review' ? nowIso : null,
          nowIso,
          admission.id,
          admission.version,
          admission.state,
          attempt.id,
        );
      if (update.changes !== 1) {
        throw new Error('Autopilot dispatch failure lost its admission CAS.');
      }
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: state,
        reason: retry.exhausted
          ? 'retry-cap-reached'
          : `dispatch-${input.classification.kind}-failure`,
        workflow: attempt.workflow,
        data: { attemptId: attempt.id, outcome },
        now: nowIso,
      });
      return {
        status: 'settled' as const,
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

function terminalSettlement(
  state: AutopilotAdmissionState,
  stage: AutopilotStage,
  attemptNumber: number,
  observation: AutopilotTerminalObservation,
  now: Date,
) {
  const nowIso = now.toISOString();
  if (observation.failed) {
    const classification = classifyAutopilotRetry({
      code:
        stage === 'comment-result' &&
        observation.errorCode === 'delivery-lease-active'
          ? 'network-error'
          : observation.errorCode,
      error: observation.error,
      effectMayHaveCompleted:
        stage === 'comment-result' &&
        observation.errorCode === 'delivery-lease-active'
          ? false
          : stage !== 'triage' && stage !== 'cleanup',
      idempotent:
        stage === 'triage' ||
        stage === 'cleanup' ||
        (stage === 'comment-result' &&
          observation.errorCode === 'delivery-lease-active'),
    });
    const retry = autopilotRetryDecision(attemptNumber, classification, now);
    const target: AutopilotAdmissionState = retry.exhausted
      ? 'manual-review'
      : classification.kind === 'permanent'
        ? 'blocked'
        : classification.kind === 'uncertain'
          ? 'manual-review'
          : 'failed';
    return {
      state: target,
      attemptStatus: target === 'blocked' ? 'blocked' : 'failed',
      nextAttemptAt: retry.nextAttemptAt,
      completedAt: target === 'manual-review' ? nowIso : null,
      reason: retry.exhausted
        ? 'retry-cap-reached'
        : `stage-${classification.kind}-failure`,
      outcome: {
        stage,
        result: target === 'blocked' ? 'blocked' : 'failed',
        retryClass: classification.kind,
        retryStage: retry.automatic ? stage : undefined,
        resumeState: state,
        errorCode: classification.code,
        message:
          observation.error ??
          `${observation.workflow} ended without a successful result.`,
        artifact: observation.artifact,
      } as AutopilotStageOutcome,
    } as const;
  }
  if (stage === 'triage') {
    const shouldPrepare = observation.shouldPrepare === true;
    return {
      state: shouldPrepare ? 'triaged' : 'completed',
      attemptStatus: 'completed',
      nextAttemptAt: null,
      completedAt: shouldPrepare ? null : nowIso,
      reason: shouldPrepare ? 'triage-completed' : 'triage-no-further-action',
      outcome: {
        stage: 'triage',
        result: 'completed',
        shouldPrepare,
        artifact: observation.artifact,
      } as AutopilotStageOutcome,
    } as const;
  }
  if (stage === 'prepare-worktree' && observation.worktreeId) {
    return {
      state: 'prepared',
      attemptStatus: 'completed',
      nextAttemptAt: null,
      completedAt: null,
      reason: 'worktree-prepared',
      outcome: {
        stage: 'prepare-worktree',
        result: 'completed',
        worktreeId: observation.worktreeId,
        artifact: observation.artifact,
      } as AutopilotStageOutcome,
    } as const;
  }
  if (stage === 'verify') {
    if (!observation.artifact?.preparedDiffId)
      return missingTerminalArtifact(stage, observation, nowIso);
    return successfulSettlement(
      'verified',
      stage,
      observation,
      nowIso,
      'worktree-verified',
    );
  }
  if (stage === 'push') {
    if (!observation.artifact?.pushedCommitSha)
      return missingTerminalArtifact(stage, observation, nowIso);
    return successfulSettlement(
      'pushed',
      stage,
      observation,
      nowIso,
      'push-recorded',
    );
  }
  if (stage === 'comment-result') {
    if (observation.artifact?.commentDelivered !== true)
      return missingTerminalArtifact(stage, observation, nowIso);
    return successfulSettlement(
      'completed',
      stage,
      observation,
      nowIso,
      'result-delivered',
    );
  }
  if (stage === 'cleanup') {
    if (observation.artifact?.cleanupFailed === true) {
      return terminalSettlement(
        state,
        stage,
        attemptNumber,
        {
          ...observation,
          failed: true,
          errorCode: 'network-error',
          error:
            typeof observation.artifact.cleanupError === 'string'
              ? observation.artifact.cleanupError
              : 'Worktree cleanup failed before deletion.',
        },
        now,
      );
    }
    if (observation.artifact?.cleanupDeleted !== true) {
      return {
        state: 'cleanup-pending' as const,
        attemptStatus: 'completed' as const,
        nextAttemptAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        completedAt: null,
        reason: 'cleanup-retained-during-grace',
        outcome: {
          stage,
          result: 'completed',
          message:
            'Worktree remains retained until its cleanup policy permits deletion.',
          artifact: observation.artifact,
        } as AutopilotStageOutcome,
      };
    }
    return successfulSettlement(
      'archived',
      stage,
      observation,
      nowIso,
      'worktree-cleanup-settled',
    );
  }
  return missingTerminalArtifact(stage, observation, nowIso);
}

function missingTerminalArtifact(
  stage: AutopilotStage,
  observation: AutopilotTerminalObservation,
  nowIso: string,
) {
  const classification = classifyAutopilotRetry({
    code: 'missing-terminal-artifact',
    error: 'Workflow completed without the required durable artifact.',
    effectMayHaveCompleted: true,
    idempotent: false,
  });
  return {
    state: 'manual-review',
    attemptStatus: 'failed',
    nextAttemptAt: null,
    completedAt: nowIso,
    reason: 'terminal-artifact-missing',
    outcome: {
      stage,
      result: 'failed',
      retryClass: classification.kind,
      errorCode: classification.code,
      message: classification.reason,
      artifact: observation.artifact,
    } as AutopilotStageOutcome,
  } as const;
}

function successfulSettlement(
  state: AutopilotAdmissionState,
  stage: AutopilotStage,
  observation: AutopilotTerminalObservation,
  nowIso: string,
  reason: string,
) {
  const artifact = observation.artifact ?? {};
  return {
    state,
    attemptStatus: 'completed' as const,
    nextAttemptAt: null,
    completedAt: state === 'completed' || state === 'archived' ? nowIso : null,
    reason,
    outcome: {
      stage,
      result: 'completed' as const,
      preparedDiffId:
        typeof artifact.preparedDiffId === 'string'
          ? artifact.preparedDiffId
          : undefined,
      artifact,
    } satisfies AutopilotStageOutcome,
  };
}

function terminalObservationKey(runId: string) {
  return `${terminalObservationPrefix}${runId}`;
}

function readTerminalObservation(row: unknown) {
  if (!row || typeof row !== 'object') return undefined;
  const value = (row as { value?: unknown }).value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = v.safeParse(
      autopilotTerminalObservationSchema,
      JSON.parse(value),
    );
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}
