import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, withImmediateTransaction } from '../../../lib/sqlite';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../../runtime-home';
import { readRepoRegistrySnapshot } from '../../repos';
import { listPrWatchRecords } from '../../watches';
import {
  repoAutopilotPolicyForWatch,
  type AutopilotConcurrencyPolicy,
  type AutopilotMode,
} from '../../autopilot-policy';
import { repoGuardrails } from '../../repo-guardrails';
import { ensureAutopilotPrOwnerInDatabase } from '../owners';
import { initialAutopilotAdmissionAuthority } from '../owner/policy';
import {
  hasAutopilotSubmissionProcessLease,
  waitForAutopilotSubmissionProcessLease,
} from '../owner/submission-lease';
import { autopilotRetryBackoffMs, maxAutopilotStageAttempts } from './retry';
import {
  readAutopilotAdmission,
  readAutopilotPrOwner,
  readAutopilotStageAttempt,
  type AutopilotAdmission,
  type AutopilotAdmissionState,
  type AutopilotStage,
  type AutopilotStageAttempt,
  type AutopilotStageOutcome,
} from './schemas';
import {
  autopilotStageRegistry,
  isLegalAutopilotTransition,
} from './transitions';

export type AdmitAutopilotEventInput = {
  watchId: string;
  eventFingerprint: string;
  repoId: string;
  prNumber: number;
  mode: AutopilotMode;
  input: Record<string, unknown>;
  limits: AutopilotConcurrencyPolicy;
  requiredPendingIntake?: {
    eventId: string;
    eventGenerationId: string;
  };
};

export class AutopilotPendingIntakeLeaseLostError extends Error {
  override readonly name = 'AutopilotPendingIntakeLeaseLostError';
}

export type AutopilotReservation = {
  admission: AutopilotAdmission;
  attempt: AutopilotStageAttempt;
};

export async function admitAutopilotEvent(
  input: AdmitAutopilotEventInput,
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const authorityBaseline = await readAdmissionAuthorityBaseline(input, paths);
  const nowIso = now.toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      if (input.requiredPendingIntake) {
        if (input.requiredPendingIntake.eventId !== input.eventFingerprint) {
          throw new AutopilotPendingIntakeLeaseLostError(
            'The required PR event intake does not match the admitted event fingerprint.',
          );
        }
        const pending = database
          .prepare(
            `SELECT intake.event_id
             FROM pr_watch_event_intakes AS intake
             INNER JOIN pr_watches AS watch ON watch.id = intake.watch_id
             WHERE intake.watch_id = ?
               AND intake.event_id = ?
               AND intake.status = 'pending'
               AND intake.event_generation_id = watch.event_generation_id
               AND watch.event_generation_id = ?;`,
          )
          .get(
            input.watchId,
            input.requiredPendingIntake.eventId,
            input.requiredPendingIntake.eventGenerationId,
          );
        if (!pending) {
          throw new AutopilotPendingIntakeLeaseLostError(
            `PR event intake ${input.requiredPendingIntake.eventId} is no longer pending for the current watch generation.`,
          );
        }
      }
      const existing = readAutopilotAdmission(
        database
          .prepare(
            'SELECT * FROM autopilot_admissions WHERE watch_id = ? AND event_fingerprint = ?;',
          )
          .get(input.watchId, input.eventFingerprint),
      );
      if (existing) {
        return {
          claimed: false,
          admission: existing,
          attempt: readCurrentAttempt(database, existing),
          reason: 'duplicate' as const,
        };
      }

      const owner = ensureAutopilotPrOwnerInDatabase(
        database,
        {
          watchId: input.watchId,
          repoId: input.repoId,
          prNumber: input.prNumber,
        },
        nowIso,
      );
      const ownerAcceptsWork =
        owner.status === 'awaiting-event' || owner.status === 'active';
      const eventSequence = nextOwnerEventSequence(database, owner.id);
      const limited =
        ownerAcceptsWork &&
        input.mode !== 'notify-only' &&
        admissionUsageExceedsLimits(
          readAdmissionUsage(database, input.repoId, owner.id),
          input.limits,
        );
      const state: AutopilotAdmissionState = !ownerAcceptsWork
        ? 'stopped'
        : input.mode === 'notify-only'
          ? 'completed'
          : limited
            ? 'blocked'
            : 'triage-admitted';
      const admissionId = `autopilot-admission:${randomUUID()}`;
      const attemptId =
        state === 'triage-admitted'
          ? `autopilot-attempt:${randomUUID()}`
          : null;
      const limitedOutcome: AutopilotStageOutcome | null = !ownerAcceptsWork
        ? {
            stage: 'triage',
            result: 'cancelled',
            errorCode: 'owner-not-accepting-work',
            message: `Autopilot owner is ${owner.status} and cannot accept another event.`,
          }
        : limited
          ? {
              stage: 'triage',
              result: 'blocked',
              retryClass: 'transient',
              concurrencyWaitCount: 1,
              retryStage: 'triage',
              resumeState: 'triage-admitted',
              errorCode: 'concurrency-limited',
              message: 'Autopilot admission limit reached.',
            }
          : null;
      const completedAt =
        state === 'completed' || state === 'stopped' ? nowIso : null;
      const nextAttemptAt = limited
        ? concurrencyWaitNextAttemptAt(1, now)
        : null;
      database
        .prepare(
          `INSERT INTO autopilot_admissions (
             id, owner_id, watch_id, event_fingerprint, event_sequence, repo_id,
             pr_number, mode, authority_mode, policy_config_history_id,
             authority_policy_json,
             mutation_epoch, input_json, state, priority, current_workflow,
             current_stage_attempt_id, worktree_id, version, attempt_count, next_attempt_at,
             last_error, last_outcome_json, completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     0, ?, ?, 0, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?);`,
        )
        .run(
          admissionId,
          owner.id,
          input.watchId,
          input.eventFingerprint,
          eventSequence,
          input.repoId,
          input.prNumber,
          input.mode,
          input.mode,
          authorityBaseline.configHistoryId,
          JSON.stringify(authorityBaseline.authority),
          JSON.stringify(input.input),
          state,
          state === 'triage-admitted' ? 'triage-pr-event' : null,
          attemptId,
          owner.worktreeId,
          attemptId ? 1 : 0,
          nextAttemptAt,
          limitedOutcome?.message ?? null,
          limitedOutcome ? JSON.stringify(limitedOutcome) : null,
          completedAt,
          nowIso,
          nowIso,
        );
      if (attemptId) {
        insertStageAttempt(database, {
          id: attemptId,
          admissionId,
          ownerId: owner.id,
          stage: 'triage',
          attemptNumber: 1,
          workflow: 'triage-pr-event',
          eventSequence,
          inputFingerprint: stageInputFingerprint(input.input),
          now: nowIso,
        });
      }
      insertAutopilotAdmissionEvent(database, {
        admissionId,
        fromState: null,
        toState: state,
        reason:
          state === 'stopped'
            ? 'owner-not-accepting-work'
            : state === 'completed'
              ? 'notify-only-event-recorded'
              : limited
                ? 'concurrency-limited'
                : 'event-admitted',
        workflow: attemptId ? 'triage-pr-event' : null,
        data: { ownerId: owner.id, eventSequence },
        now: nowIso,
      });
      database
        .prepare(
          `UPDATE autopilot_pr_owners
           SET last_event_at = ?, updated_at = ?
           WHERE id = ?;`,
        )
        .run(nowIso, nowIso, owner.id);
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(admissionId),
      );
      if (!admission) throw new Error('Created admission could not be read.');
      return {
        claimed: Boolean(attemptId),
        admission,
        attempt: attemptId
          ? readAutopilotStageAttempt(
              database
                .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
                .get(attemptId),
            )
          : undefined,
        reason: !ownerAcceptsWork
          ? ('owner-inactive' as const)
          : limited
            ? ('limited' as const)
            : input.mode === 'notify-only'
              ? ('notify-only' as const)
              : null,
      };
    });
  } finally {
    database.close();
  }
}

async function readAdmissionAuthorityBaseline(
  input: AdmitAutopilotEventInput,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let configHistoryId: number;
  try {
    const row = database
      .prepare('SELECT COALESCE(MAX(id), 0) AS id FROM config_history;')
      .get() as { id?: unknown } | undefined;
    configHistoryId = Number(row?.id ?? 0);
  } finally {
    database.close();
  }
  const [registry, appConfig] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === input.repoId,
  );
  if (!repo) {
    throw new Error(
      `Repository "${input.repoId}" is not configured for Autopilot admission.`,
    );
  }
  return {
    configHistoryId,
    authority: initialAutopilotAdmissionAuthority(
      repoGuardrails(repo, appConfig),
      {
        configHistoryId,
        mode: input.mode,
        repoId: input.repoId,
        watchId: input.watchId,
      },
    ),
  };
}

export async function advanceAutopilotAdmission(
  input: {
    admissionId: string;
    allowOwnerTurnReservation?: boolean;
    approvalRevalidated?: boolean;
    limits?: AutopilotConcurrencyPolicy;
    now?: Date;
  },
  paths: RuntimePaths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const limits =
    input.limits ??
    (await readAdmissionConcurrencyPolicy(input.admissionId, paths));
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const admission = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(input.admissionId),
      );
      if (!admission) return { status: 'missing' as const };
      const owner = readAutopilotPrOwner(
        database
          .prepare('SELECT * FROM autopilot_pr_owners WHERE id = ?;')
          .get(admission.ownerId),
      );
      if (
        !owner ||
        (owner.status !== 'awaiting-event' &&
          owner.status !== 'active' &&
          !(
            owner.status === 'draining' &&
            (admission.state === 'stopped' ||
              admission.state === 'superseded' ||
              admission.state === 'cleanup-pending' ||
              (admission.state === 'failed' &&
                admission.lastOutcome?.retryStage === 'cleanup'))
          ))
      ) {
        return { status: 'owner-inactive' as const, admission, owner };
      }
      const activeAttempt = readCurrentAttempt(database, admission);
      if (
        activeAttempt &&
        (activeAttempt.status === 'reserved' ||
          activeAttempt.status === 'running')
      ) {
        return {
          status: 'already-reserved' as const,
          admission,
          attempt: activeAttempt,
        };
      }
      if (
        admission.stopRequestedAt &&
        admission.state !== 'cleanup-pending' &&
        !(
          admission.state === 'failed' &&
          admission.lastOutcome?.retryStage === 'cleanup'
        )
      ) {
        return { status: 'stopped' as const, admission };
      }
      if (
        admission.state === 'cleanup-pending' &&
        admission.nextAttemptAt &&
        Date.parse(admission.nextAttemptAt) > now.getTime()
      ) {
        return { status: 'idle' as const, admission };
      }
      if (
        admission.state === 'verified' &&
        (admission.authorityMode === 'autofix-with-approval' ||
          admission.authorityMode === 'autofix-push-when-safe')
      ) {
        return { status: 'approval-resolution-required' as const, admission };
      }
      if (
        admission.state === 'approval-pending' &&
        !input.approvalRevalidated
      ) {
        return { status: 'approval-resolution-required' as const, admission };
      }

      const selection =
        admission.state === 'approval-pending' &&
        hasApprovedPushApproval(
          database,
          admission.id,
          admission.preparedDiffId,
        )
          ? {
              kind: 'stage' as const,
              stage: 'push' as const,
              admittedState: 'push-admitted' as const,
              reason: 'sha-policy-approval-resolved',
            }
          : selectNextStage(admission, now);
      if (!selection) return { status: 'idle' as const, admission };
      if (
        selection.kind === 'stage' &&
        selection.stage === 'cleanup' &&
        ownerHasActiveSubmissionLease(database, admission.ownerId)
      ) {
        // A terminal transition can cancel the database attempt before a
        // same-process owner submission has observed its cancellation fence.
        // Every coordinator observes this gate, so no duplicate can delete
        // the worktree until that process lease is released.
        return { status: 'idle' as const, admission };
      }
      if (selection.kind === 'complete') {
        const updated = transitionWithoutAttempt(
          database,
          admission,
          'completed',
          selection.reason,
          nowIso,
        );
        return updated
          ? { status: 'completed' as const, admission: updated }
          : { status: 'cas-lost' as const, admission };
      }
      if (
        selection.stage === 'owner-turn' &&
        input.allowOwnerTurnReservation === false
      ) {
        return {
          status: 'deferred' as const,
          reason: 'owner-dispatch-disabled' as const,
          admission,
        };
      }

      const attempts = countStageAttempts(
        database,
        admission.id,
        selection.stage,
      );
      if (
        selection.stage !== 'cleanup' &&
        attempts >= maxAutopilotStageAttempts
      ) {
        const updated = transitionWithoutAttempt(
          database,
          admission,
          'manual-review',
          'retry-cap-reached',
          nowIso,
          {
            stage: selection.stage,
            result: 'blocked',
            retryClass: 'permanent',
            errorCode: 'retry-cap-reached',
            message: `Automatic retry cap reached for ${selection.stage}.`,
          },
        );
        return updated
          ? { status: 'retry-cap' as const, admission: updated }
          : { status: 'cas-lost' as const, admission };
      }
      if (
        selection.stage !== 'cleanup' &&
        (!limits ||
          admissionUsageExceedsLimits(
            readAdmissionUsage(database, admission.repoId, admission.ownerId),
            limits,
          ))
      ) {
        if (admission.state === 'blocked') {
          const concurrencyWaitCount = nextConcurrencyWaitCount(admission);
          const updated = rearmConcurrencyBlockedAdmission(
            database,
            admission,
            selection.stage,
            selection.admittedState,
            concurrencyWaitCount,
            concurrencyWaitNextAttemptAt(concurrencyWaitCount, now),
            nowIso,
          );
          return updated
            ? { status: 'limited' as const, admission: updated }
            : { status: 'cas-lost' as const, admission };
        }
        const concurrencyWaitCount = nextConcurrencyWaitCount(admission);
        const updated = transitionWithoutAttempt(
          database,
          admission,
          'blocked',
          'concurrency-limited',
          nowIso,
          concurrencyLimitedOutcome(
            selection.stage,
            selection.admittedState,
            concurrencyWaitCount,
          ),
          concurrencyWaitNextAttemptAt(concurrencyWaitCount, now),
        );
        return updated
          ? { status: 'limited' as const, admission: updated }
          : { status: 'cas-lost' as const, admission };
      }

      if (
        !isLegalAutopilotTransition(admission.state, selection.admittedState)
      ) {
        throw new Error(
          `Illegal autopilot transition ${admission.state} -> ${selection.admittedState}.`,
        );
      }
      const attemptId = `autopilot-attempt:${randomUUID()}`;
      const workflow = autopilotStageRegistry[selection.stage].workflow;
      const update = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = ?, current_workflow = ?, current_run_id = NULL,
               current_stage_attempt_id = ?, attempt_count = attempt_count + 1,
               next_attempt_at = NULL, last_error = NULL, version = version + 1,
               updated_at = ?
           WHERE id = ? AND version = ? AND state = ?
             AND current_stage_attempt_id IS NULL;`,
        )
        .run(
          selection.admittedState,
          workflow,
          attemptId,
          nowIso,
          admission.id,
          admission.version,
          admission.state,
        );
      if (update.changes !== 1) {
        return { status: 'cas-lost' as const, admission };
      }
      insertStageAttempt(database, {
        id: attemptId,
        admissionId: admission.id,
        ownerId: admission.ownerId,
        stage: selection.stage,
        attemptNumber: attempts + 1,
        workflow,
        eventSequence: admission.eventSequence,
        inputFingerprint: stageInputFingerprint({
          admissionId: admission.id,
          stage: selection.stage,
          input: admission.input,
        }),
        now: nowIso,
      });
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: selection.admittedState,
        reason: selection.reason,
        workflow,
        data: { attemptId, attemptNumber: attempts + 1 },
        now: nowIso,
      });
      const updated = readAutopilotAdmission(
        database
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(admission.id),
      );
      const attempt = readAutopilotStageAttempt(
        database
          .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
          .get(attemptId),
      );
      if (!updated || !attempt) {
        throw new Error('Reserved autopilot stage could not be read.');
      }
      return {
        status: 'reserved' as const,
        admission: updated,
        attempt,
      };
    });
  } finally {
    database.close();
  }
}

export async function listAutopilotAdmissionsNeedingAdvance(
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT * FROM autopilot_admissions
         WHERE current_stage_attempt_id IS NULL
           AND (
             stop_requested_at IS NULL
             OR state = 'cleanup-pending'
             OR (
               state = 'failed'
               AND json_extract(last_outcome_json, '$.retryStage') = 'cleanup'
             )
           )
           AND (
             state = 'triaged'
             OR state = 'prepared'
             OR state = 'fix-prepared'
             OR state = 'verified'
             OR state = 'approval-pending'
             OR state = 'pushed'
             OR (state = 'cleanup-pending' AND next_attempt_at <= ?)
             OR state IN ('stopped', 'superseded')
             OR (state IN ('blocked', 'failed') AND next_attempt_at <= ?)
           )
         ORDER BY priority DESC, updated_at ASC;`,
      )
      .all(now.toISOString(), now.toISOString())
      .map(readAutopilotAdmission)
      .filter((admission): admission is AutopilotAdmission =>
        Boolean(admission),
      );
  } finally {
    database.close();
  }
}

export async function admitTerminalAutopilotOwnerCleanup(
  input: { watchId: string; reason: string },
  paths: RuntimePaths = runtimePaths(),
  now = new Date(),
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase);
  let revokedAttemptIds: string[] = [];
  let result:
    | { status: 'not-ready' }
    | { status: 'archived-without-worktree' }
    | { status: 'already-admitted'; admissionId: string }
    | { status: 'cas-lost' }
    | { status: 'admitted'; admissionId: string };
  try {
    result = withImmediateTransaction(database, () => {
      const owner = readAutopilotPrOwner(
        database
          .prepare('SELECT * FROM autopilot_pr_owners WHERE watch_id = ?;')
          .get(input.watchId),
      );
      if (!owner || owner.status === 'archived') {
        return { status: 'not-ready' as const };
      }
      const nowIso = now.toISOString();
      revokedAttemptIds = database
        .prepare(
          `SELECT id FROM autopilot_stage_attempts
           WHERE owner_id = ? AND stage = 'owner-turn'
             AND status IN ('reserved', 'running');`,
        )
        .all(owner.id)
        .map((row) => String((row as { id: string }).id));
      // A terminal PR revokes any still-active owner work before cleanup can be
      // admitted. Late workflow observations lose their stage CAS; the push
      // workflow also checks this fence immediately before its side effect.
      database
        .prepare(
          `UPDATE autopilot_admissions
           SET mutation_epoch = mutation_epoch + 1,
               stop_requested_at = COALESCE(stop_requested_at, ?), updated_at = ?
           WHERE owner_id = ? AND current_stage_attempt_id IN (
             SELECT id FROM autopilot_stage_attempts
             WHERE owner_id = ? AND stage = 'owner-turn'
               AND status IN ('reserved', 'running')
           );`,
        )
        .run(nowIso, nowIso, owner.id, owner.id);
      database
        .prepare(
          `UPDATE autopilot_owner_fix_submissions
           SET cancellation_requested_at = COALESCE(cancellation_requested_at, ?),
               error = COALESCE(error, 'pull-request-terminal-state')
           WHERE attempt_id IN (
             SELECT id FROM autopilot_stage_attempts
             WHERE owner_id = ? AND stage = 'owner-turn'
               AND status IN ('reserved', 'running')
           ) AND status = 'applying';`,
        )
        .run(nowIso, owner.id);
      database
        .prepare(
          `UPDATE autopilot_stage_attempts
           SET status = 'cancelled', error = 'pull-request-terminal-state',
               finished_at = ?
           WHERE owner_id = ? AND stage != 'cleanup'
             AND status IN ('reserved', 'running');`,
        )
        .run(nowIso, owner.id);
      database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = 'stopped', current_workflow = NULL, current_run_id = NULL,
               current_stage_attempt_id = NULL,
               stop_requested_at = COALESCE(stop_requested_at, ?),
               completed_at = COALESCE(completed_at, ?),
               version = version + 1, updated_at = ?
           WHERE owner_id = ?
             AND state NOT IN ('completed', 'stopped', 'superseded',
                             'cleanup-pending', 'archived');`,
        )
        .run(nowIso, nowIso, nowIso, owner.id);
      database
        .prepare(
          `UPDATE prepared_diff_approvals
           SET status = 'superseded',
               reason = COALESCE(reason, 'pull request reached terminal state'),
               resolved_at = COALESCE(resolved_at, ?), updated_at = ?
           WHERE admission_id IN (SELECT id FROM autopilot_admissions WHERE owner_id = ?)
             AND approval_type = 'push' AND status IN ('pending', 'approved');`,
        )
        .run(nowIso, nowIso, owner.id);
      if (!owner.worktreeId) {
        database
          .prepare(
            `UPDATE autopilot_pr_owners
             SET status = 'archived', archived_at = COALESCE(archived_at, ?),
                 updated_at = ? WHERE id = ? AND status != 'archived';`,
          )
          .run(nowIso, nowIso, owner.id);
        database
          .prepare(
            `UPDATE autopilot_owner_generations
             SET status = 'archived', archived_at = COALESCE(archived_at, ?)
             WHERE owner_id = ? AND status = 'active';`,
          )
          .run(nowIso, owner.id);
        database
          .prepare(
            `UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?;`,
          )
          .run(nowIso, `watch:${input.watchId}`);
        database
          .prepare(
            `UPDATE chat_sessions SET archived_at = COALESCE(archived_at, ?), updated_at = ?
             WHERE id = ?;`,
          )
          .run(nowIso, nowIso, owner.chatSessionId);
        return { status: 'archived-without-worktree' as const };
      }
      const admission = readAutopilotAdmission(
        database
          .prepare(
            `SELECT * FROM autopilot_admissions
             WHERE owner_id = ?
               AND state IN ('completed', 'stopped', 'superseded', 'cleanup-pending')
             ORDER BY updated_at DESC LIMIT 1;`,
          )
          .get(owner.id),
      );
      if (!admission) return { status: 'not-ready' as const };
      // A clean, managed owner worktree may never have produced a prepared
      // diff, so it remains `ready`. Terminal ownership is the narrow durable
      // transition that makes it eligible for the existing successful-grace
      // cleanup policy. Adopted worktrees remain protected by their explicit
      // confirmation guard and are never transitioned here.
      database
        .prepare(
          `UPDATE worktrees
           SET lifecycle_status = 'succeeded', updated_at = ?
           WHERE id = ? AND lifecycle_status = 'ready' AND adopted = 0;`,
        )
        .run(nowIso, owner.worktreeId);
      database
        .prepare(
          `UPDATE autopilot_pr_owners
           SET status = 'draining', updated_at = ?
           WHERE id = ? AND status != 'archived';`,
        )
        .run(nowIso, owner.id);
      if (admission.state === 'cleanup-pending') {
        return {
          status: 'already-admitted' as const,
          admissionId: admission.id,
        };
      }
      const update = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = 'cleanup-pending', next_attempt_at = ?,
               version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = ?;`,
        )
        .run(nowIso, nowIso, admission.id, admission.version, admission.state);
      if (update.changes !== 1) return { status: 'cas-lost' as const };
      insertAutopilotAdmissionEvent(database, {
        admissionId: admission.id,
        fromState: admission.state,
        toState: 'cleanup-pending',
        reason: input.reason,
        data: { ownerId: owner.id },
        now: nowIso,
      });
      return { status: 'admitted' as const, admissionId: admission.id };
    });
  } finally {
    database.close();
  }
  await Promise.all(
    revokedAttemptIds.map((attemptId) =>
      waitForAutopilotSubmissionProcessLease(attemptId),
    ),
  );
  return result;
}

export function insertAutopilotAdmissionEvent(
  database: DatabaseSync,
  input: {
    admissionId: string;
    fromState: AutopilotAdmissionState | null;
    toState: AutopilotAdmissionState;
    reason: string;
    workflow?: string | null;
    runId?: string | null;
    data?: Record<string, unknown>;
    now: string;
  },
) {
  database
    .prepare(
      `INSERT INTO autopilot_admission_events (
         admission_id, from_state, to_state, reason, workflow, run_id,
         data_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
    )
    .run(
      input.admissionId,
      input.fromState,
      input.toState,
      input.reason,
      input.workflow ?? null,
      input.runId ?? null,
      JSON.stringify(input.data ?? {}),
      input.now,
    );
}

function ownerHasActiveSubmissionLease(
  database: DatabaseSync,
  ownerId: string,
) {
  const attempts = database
    .prepare(
      `SELECT id FROM autopilot_stage_attempts
       WHERE owner_id = ? AND stage = 'owner-turn';`,
    )
    .all(ownerId)
    .map((row) => String((row as { id: string }).id));
  return attempts.some((attemptId) =>
    hasAutopilotSubmissionProcessLease(attemptId),
  );
}

function selectNextStage(admission: AutopilotAdmission, now: Date) {
  if (admission.state === 'triaged') {
    return admission.lastOutcome?.shouldPrepare
      ? ({
          kind: 'stage',
          stage: 'prepare-worktree',
          admittedState: 'prepare-admitted',
          reason: 'triage-requested-prepare',
        } as const)
      : ({ kind: 'complete', reason: 'triage-no-further-action' } as const);
  }
  if (admission.state === 'prepared') {
    return {
      kind: 'stage',
      stage: 'owner-turn',
      admittedState: 'owner-turn-admitted',
      reason: 'worktree-ready-for-owner',
    } as const;
  }
  if (admission.state === 'fix-prepared') {
    if (admission.authorityMode === 'prepare-only') {
      return {
        kind: 'complete',
        reason: 'prepare-only-diff-retained',
      } as const;
    }
    return {
      kind: 'stage',
      stage: 'verify',
      admittedState: 'verify-admitted',
      reason: 'fix-ready-for-current-head-verification',
    } as const;
  }
  if (admission.state === 'verified') {
    return {
      kind: 'stage',
      stage: 'push',
      admittedState: 'push-admitted',
      reason: 'verified-safe-push',
    } as const;
  }
  if (admission.state === 'pushed') {
    return {
      kind: 'stage',
      stage: 'comment-result',
      admittedState: 'comment-admitted',
      reason: 'push-recorded-deliver-result',
    } as const;
  }
  if (
    (admission.state === 'stopped' || admission.state === 'superseded') &&
    admission.worktreeId
  ) {
    return {
      kind: 'stage',
      stage: 'cleanup',
      admittedState: 'cleanup-pending',
      reason: 'terminal-owner-cleanup-admitted',
    } as const;
  }
  if (admission.state === 'cleanup-pending') {
    return {
      kind: 'stage',
      stage: 'cleanup',
      admittedState: 'cleanup-pending',
      reason: 'cleanup-grace-recheck',
    } as const;
  }
  if (admission.state !== 'blocked' && admission.state !== 'failed') {
    return undefined;
  }
  if (
    !admission.lastOutcome?.retryStage ||
    admission.lastOutcome.retryClass !== 'transient' ||
    !admission.nextAttemptAt ||
    Date.parse(admission.nextAttemptAt) > now.getTime()
  ) {
    return undefined;
  }
  const stage = admission.lastOutcome.retryStage;
  if (
    stage !== 'triage' &&
    stage !== 'prepare-worktree' &&
    stage !== 'owner-turn' &&
    stage !== 'verify' &&
    stage !== 'push' &&
    stage !== 'comment-result' &&
    stage !== 'cleanup'
  )
    return undefined;
  return {
    kind: 'stage',
    stage,
    admittedState: autopilotStageRegistry[stage].admittedState,
    reason: 'bounded-retry',
  } as const;
}

function hasApprovedPushApproval(
  database: DatabaseSync,
  admissionId: string,
  preparedDiffId: string | null,
) {
  if (!preparedDiffId) return false;
  return Boolean(
    database
      .prepare(
        `SELECT approval.id
         FROM prepared_diff_approvals AS approval
         INNER JOIN autopilot_admissions AS admission ON admission.id = approval.admission_id
         INNER JOIN autopilot_pr_owners AS owner ON owner.id = admission.owner_id
         WHERE approval.admission_id = ?
           AND approval.prepared_diff_id = ?
           AND approval.approval_type = 'push'
           AND approval.status = 'approved'
           AND approval.owner_generation = owner.generation
           AND approval.target_sha = json_extract(
             admission.last_outcome_json,
             '$.artifact.approvalTargetSha'
           )
           AND approval.policy_hash = json_extract(
             admission.last_outcome_json,
             '$.artifact.approvalPolicyHash'
           )
           AND approval.stage_attempt_id = (
             SELECT id FROM autopilot_stage_attempts
             WHERE admission_id = admission.id
               AND stage = 'verify' AND status = 'completed'
             ORDER BY attempt_number DESC LIMIT 1
           )
         LIMIT 1;`,
      )
      .get(admissionId, preparedDiffId),
  );
}

function transitionWithoutAttempt(
  database: DatabaseSync,
  admission: AutopilotAdmission,
  toState: AutopilotAdmissionState,
  reason: string,
  now: string,
  outcome: AutopilotStageOutcome | null = admission.lastOutcome,
  nextAttemptAt: string | null = null,
) {
  if (!isLegalAutopilotTransition(admission.state, toState)) {
    throw new Error(
      `Illegal autopilot transition ${admission.state} -> ${toState}.`,
    );
  }
  const completedAt =
    toState === 'completed' ||
    toState === 'manual-review' ||
    toState === 'stopped' ||
    toState === 'superseded'
      ? now
      : null;
  const update = database
    .prepare(
      `UPDATE autopilot_admissions
       SET state = ?, current_workflow = NULL, current_run_id = NULL,
           current_stage_attempt_id = NULL, next_attempt_at = ?,
           last_error = ?, last_outcome_json = ?, completed_at = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND state = ?
         AND current_stage_attempt_id IS NULL;`,
    )
    .run(
      toState,
      nextAttemptAt,
      outcome?.message ?? null,
      outcome ? JSON.stringify(outcome) : null,
      completedAt,
      now,
      admission.id,
      admission.version,
      admission.state,
    );
  if (update.changes !== 1) return undefined;
  insertAutopilotAdmissionEvent(database, {
    admissionId: admission.id,
    fromState: admission.state,
    toState,
    reason,
    data: outcome ? { outcome } : {},
    now,
  });
  return readAutopilotAdmission(
    database
      .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
      .get(admission.id),
  );
}

function rearmConcurrencyBlockedAdmission(
  database: DatabaseSync,
  admission: AutopilotAdmission,
  stage: AutopilotStage,
  resumeState: AutopilotAdmissionState,
  concurrencyWaitCount: number,
  nextAttemptAt: string,
  now: string,
) {
  const outcome = concurrencyLimitedOutcome(
    stage,
    resumeState,
    concurrencyWaitCount,
  );
  const update = database
    .prepare(
      `UPDATE autopilot_admissions
       SET next_attempt_at = ?, last_error = ?, last_outcome_json = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND state = 'blocked'
         AND current_stage_attempt_id IS NULL;`,
    )
    .run(
      nextAttemptAt,
      outcome.message ?? null,
      JSON.stringify(outcome),
      now,
      admission.id,
      admission.version,
    );
  if (update.changes !== 1) return undefined;
  insertAutopilotAdmissionEvent(database, {
    admissionId: admission.id,
    fromState: 'blocked',
    toState: 'blocked',
    reason: 'concurrency-wait-rearmed',
    data: { outcome },
    now,
  });
  return readAutopilotAdmission(
    database
      .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
      .get(admission.id),
  );
}

function nextConcurrencyWaitCount(admission: AutopilotAdmission) {
  return admission.lastOutcome?.errorCode === 'concurrency-limited'
    ? (admission.lastOutcome.concurrencyWaitCount ?? 1) + 1
    : 1;
}

function concurrencyWaitNextAttemptAt(waitCount: number, now: Date) {
  const delay =
    autopilotRetryBackoffMs[
      Math.min(waitCount - 1, autopilotRetryBackoffMs.length - 1)
    ];
  return new Date(now.getTime() + delay).toISOString();
}

function concurrencyLimitedOutcome(
  stage: AutopilotStage,
  resumeState: AutopilotAdmissionState,
  concurrencyWaitCount: number,
): AutopilotStageOutcome {
  return {
    stage,
    result: 'blocked',
    retryClass: 'transient',
    concurrencyWaitCount,
    retryStage: stage,
    resumeState,
    errorCode: 'concurrency-limited',
    message: 'Autopilot admission limit reached.',
  };
}

function insertStageAttempt(
  database: DatabaseSync,
  input: {
    id: string;
    admissionId: string;
    ownerId: string;
    stage: AutopilotStage;
    attemptNumber: number;
    workflow: string | null;
    eventSequence: number;
    inputFingerprint: string;
    now: string;
  },
) {
  database
    .prepare(
      `INSERT INTO autopilot_stage_attempts (
         id, admission_id, owner_id, stage, attempt_number, workflow,
         event_sequence, status, input_fingerprint, artifact_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, '{}', ?);`,
    )
    .run(
      input.id,
      input.admissionId,
      input.ownerId,
      input.stage,
      input.attemptNumber,
      input.workflow,
      input.eventSequence,
      input.inputFingerprint,
      input.now,
    );
}

function readCurrentAttempt(
  database: DatabaseSync,
  admission: AutopilotAdmission,
) {
  if (!admission.currentStageAttemptId) return undefined;
  return readAutopilotStageAttempt(
    database
      .prepare('SELECT * FROM autopilot_stage_attempts WHERE id = ?;')
      .get(admission.currentStageAttemptId),
  );
}

function countStageAttempts(
  database: DatabaseSync,
  admissionId: string,
  stage: AutopilotStage,
) {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM autopilot_stage_attempts
       WHERE admission_id = ? AND stage = ?;`,
    )
    .get(admissionId, stage) as { count?: unknown } | undefined;
  return Number(row?.count ?? 0);
}

function nextOwnerEventSequence(database: DatabaseSync, ownerId: string) {
  const row = database
    .prepare(
      `SELECT COALESCE(MAX(event_sequence), 0) + 1 AS sequence
       FROM autopilot_admissions WHERE owner_id = ?;`,
    )
    .get(ownerId) as { sequence?: unknown } | undefined;
  return Number(row?.sequence ?? 1);
}

function readAdmissionUsage(
  database: DatabaseSync,
  repoId: string,
  ownerId: string,
) {
  const workflowNames = Object.values(autopilotStageRegistry)
    .map((entry) => entry.workflow)
    .filter((workflow) => workflow !== null);
  const placeholders = workflowNames.map(() => '?').join(', ');
  return database
    .prepare(
      `WITH active_attempts AS (
         SELECT attempt.owner_id, admission.repo_id, attempt.run_id
         FROM autopilot_stage_attempts AS attempt
         JOIN autopilot_admissions AS admission ON admission.id = attempt.admission_id
         WHERE attempt.status IN ('reserved', 'running')
       ), manual_runs AS (
         SELECT run_id FROM workflow_run_observations
         WHERE status = 'active' AND workflow IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM active_attempts
             WHERE active_attempts.run_id = workflow_run_observations.run_id
           )
       ), manual_worktrees AS (
         SELECT repo_id, owning_workflow_run_id FROM worktrees
         WHERE lifecycle_status = 'busy'
           AND NOT EXISTS (
             SELECT 1 FROM active_attempts
             WHERE active_attempts.run_id = worktrees.owning_workflow_run_id
           )
       )
       SELECT
         (SELECT COUNT(*) FROM active_attempts) +
           (SELECT COUNT(*) FROM manual_runs) +
           (SELECT COUNT(*) FROM manual_worktrees
            WHERE owning_workflow_run_id IS NULL
              OR owning_workflow_run_id NOT IN (SELECT run_id FROM manual_runs))
           AS global_count,
         (SELECT COUNT(*) FROM active_attempts WHERE repo_id = ?) +
           (SELECT COUNT(*) FROM manual_worktrees WHERE repo_id = ?) AS repo_count,
         (SELECT COUNT(*) FROM active_attempts WHERE owner_id = ?) AS owner_count;`,
    )
    .get(...workflowNames, repoId, repoId, ownerId) as {
    global_count?: unknown;
    repo_count?: unknown;
    owner_count?: unknown;
  };
}

function admissionUsageExceedsLimits(
  usage: {
    global_count?: unknown;
    repo_count?: unknown;
    owner_count?: unknown;
  },
  limits: AutopilotConcurrencyPolicy,
) {
  const globalCount = Number(usage.global_count ?? 0);
  const repoCount = Number(usage.repo_count ?? 0);
  const ownerCount = Number(usage.owner_count ?? 0);
  return (
    globalCount >= limits.maxAutonomousJobs ||
    globalCount >= limits.maxActiveWorkflowRuns ||
    repoCount >= limits.maxPerRepoAutonomousJobs ||
    ownerCount > 0
  );
}

async function readAdmissionConcurrencyPolicy(
  admissionId: string,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let admission: AutopilotAdmission | undefined;
  try {
    admission = readAutopilotAdmission(
      database
        .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
        .get(admissionId),
    );
  } finally {
    database.close();
  }
  if (!admission) return undefined;
  const [registry, appConfig, watches] = await Promise.all([
    readRepoRegistrySnapshot(paths),
    readRuntimeJson(paths.config, parseAppConfig),
    listPrWatchRecords(paths),
  ]);
  const repo = registry.repos.find(
    (candidate) => candidate.id === admission.repoId,
  );
  const watch = watches.find((candidate) => candidate.id === admission.watchId);
  if (!repo || !watch) return undefined;
  const policy = repoAutopilotPolicyForWatch(repo, appConfig, {
    id: watch.id,
    prNumber: watch.prNumber,
  });
  return 'concurrency' in policy ? policy.concurrency : undefined;
}

function stageInputFingerprint(input: unknown) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
