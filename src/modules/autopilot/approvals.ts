import * as v from 'valibot';
import { createHash, randomUUID } from 'node:crypto';
import { gitCurrentSha } from '../../repo-edit/git';
import {
  approvePreparedDiffPush,
  approvePushInputSchema,
  readPreparedDiff,
  type PreparedDiffActionResult,
  type PreparedDiffApprovalRecord,
} from '../prepared-diffs';
import { checkAutopilotPolicy } from '../autopilot-policy';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import { readPreparedDiffRecord } from '../prepared-diffs';
import { readAutopilotAdmission } from './coordination/schemas';
import { insertAutopilotAdmissionEvent } from './coordination/advance';

export async function createPendingPushApprovalForAdmission(
  admissionId: string,
  paths: RuntimePaths = runtimePaths(),
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  let admission;
  try {
    admission = readAutopilotAdmission(
      database
        .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
        .get(admissionId),
    );
  } finally {
    database.close();
  }
  if (
    !admission ||
    (admission.state !== 'verified' &&
      admission.state !== 'approval-pending') ||
    !admission.preparedDiffId
  )
    return { status: 'not-ready' as const };
  const prepared = readPreparedDiffRecord(admission.preparedDiffId, paths);
  if (!prepared) return { status: 'missing-prepared-diff' as const };
  const targetSha = await gitCurrentSha(prepared.sourceWorktreePath).catch(
    () => null,
  );
  if (!targetSha) return { status: 'missing-head' as const };
  const policy = await checkAutopilotPolicy(
    {
      worktreeId: prepared.worktreeId,
      diffBaseRef: prepared.headSha ?? prepared.baseRef,
      pushDestination: 'pull-request-head',
    },
    paths,
  );
  if (!policy.ok || policy.blocked)
    return { status: 'policy-blocked' as const, policy };
  const policyHash = admissionPolicyHash(policy.policyHash, policy.mode);
  const writable = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(writable, () => {
      const current = readAutopilotAdmission(
        writable
          .prepare('SELECT * FROM autopilot_admissions WHERE id = ?;')
          .get(admissionId),
      );
      if (
        !current ||
        (current.state !== 'verified' && current.state !== 'approval-pending')
      )
        return { status: 'stale' as const };
      if (current.preparedDiffId !== prepared.id) {
        return { status: 'stale' as const };
      }
      const owner = writable
        .prepare('SELECT generation FROM autopilot_pr_owners WHERE id = ?;')
        .get(current.ownerId) as { generation?: number } | undefined;
      const verificationAttempt = writable
        .prepare(
          `SELECT id FROM autopilot_stage_attempts
           WHERE admission_id = ? AND stage = 'verify' AND status = 'completed'
           ORDER BY attempt_number DESC LIMIT 1;`,
        )
        .get(current.id) as { id?: string } | undefined;
      if (!owner || !verificationAttempt?.id) {
        return { status: 'stale' as const };
      }
      const verificationAttemptId = verificationAttempt.id;
      const authorityAllowsPush =
        current.authorityMode === 'autofix-with-approval' ||
        current.authorityMode === 'autofix-push-when-safe';
      const policyAllowsPush =
        policy.mode === 'autofix-with-approval' ||
        policy.mode === 'autofix-push-when-safe';
      if (!authorityAllowsPush || !policyAllowsPush) {
        return { status: 'policy-not-push-capable' as const, policy };
      }
      const now = new Date().toISOString();
      const requiresHumanApproval =
        current.authorityMode === 'autofix-with-approval' ||
        policy.mode === 'autofix-with-approval' ||
        policy.decision === 'require-approval';
      const status = requiresHumanApproval ? 'pending' : 'approved';
      // A new verification, policy evaluation, or owner generation supersedes every
      // prior authorization for this admission before a replacement can be admitted.
      const supersedeMismatched = writable.prepare(
        `UPDATE prepared_diff_approvals
           SET status = 'superseded',
               reason = 'superseded by current admission verification binding',
               resolved_at = COALESCE(resolved_at, ?), updated_at = ?
           WHERE admission_id = ? AND approval_type = 'push'
             AND status IN ('pending', 'approved')
             AND (prepared_diff_id IS NOT ? OR target_sha IS NOT ? OR policy_hash IS NOT ?
                  OR owner_generation IS NOT ? OR stage_attempt_id IS NOT ?);`,
      );
      (supersedeMismatched.run as (...values: unknown[]) => unknown)(
        now,
        now,
        current.id,
        prepared.id,
        targetSha,
        policyHash,
        owner.generation,
        verificationAttemptId,
      );
      const existingStatement = writable.prepare(
        `SELECT id, status FROM prepared_diff_approvals
           WHERE admission_id = ? AND prepared_diff_id = ? AND approval_type = 'push'
             AND status IN ('pending', 'approved')
             AND owner_generation = ? AND stage_attempt_id = ?
             AND target_sha = ? AND policy_hash = ?
           ORDER BY requested_at DESC LIMIT 1;`,
      );
      const existing = (
        existingStatement.get as (...values: unknown[]) => unknown
      )(
        current.id,
        prepared.id,
        owner.generation,
        verificationAttemptId,
        targetSha,
        policyHash,
      ) as { id: string; status: string } | undefined;
      const approvalId = existing?.id ?? randomUUID();
      const recordedBinding = current.lastOutcome?.artifact;
      const existingBindingRecorded =
        recordedBinding?.approvalTargetSha === targetSha &&
        recordedBinding?.approvalPolicyHash === policyHash;
      if (
        existing &&
        current.state === 'approval-pending' &&
        existingBindingRecorded
      ) {
        return {
          status:
            existing.status === 'approved'
              ? ('approved' as const)
              : ('pending' as const),
          approvalId,
        };
      }
      if (!existing) {
        const insertApproval = writable.prepare(
          `INSERT INTO prepared_diff_approvals (
              id, prepared_diff_id, worktree_id, approval_type, status,
              admission_id, owner_generation, stage_attempt_id,
              target_sha, policy_hash, policy_decision, reason,
              approver_surface, requested_at, resolved_at, updated_at
            ) VALUES (?, ?, ?, 'push', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        );
        (insertApproval.run as (...values: unknown[]) => unknown)(
          approvalId,
          prepared.id,
          prepared.worktreeId,
          status,
          current.id,
          owner.generation,
          verificationAttemptId,
          targetSha,
          policyHash,
          policy.decision,
          requiresHumanApproval
            ? 'Verification passed; approval is required before push.'
            : 'Safe-push policy allowed verified push.',
          requiresHumanApproval ? null : 'autopilot-policy',
          now,
          requiresHumanApproval ? null : now,
          now,
        );
      }
      const update = writable
        .prepare(
          `UPDATE autopilot_admissions SET state = 'approval-pending', last_outcome_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND state IN ('verified', 'approval-pending');`,
        )
        .run(
          JSON.stringify({
            stage: 'verify',
            result: 'completed',
            preparedDiffId: prepared.id,
            artifact: {
              approvalTargetSha: targetSha,
              approvalPolicyHash: policyHash,
              verificationAttemptId,
            },
            message: requiresHumanApproval
              ? 'Verified diff awaits SHA- and policy-bound push approval.'
              : 'Verified diff has a policy-authorized safe push.',
          }),
          now,
          current.id,
          current.version,
        );
      if (update.changes !== 1) return { status: 'stale' as const };
      insertAutopilotAdmissionEvent(writable, {
        admissionId: current.id,
        fromState: current.state,
        toState: 'approval-pending',
        reason: 'sha-policy-bound-approval-created',
        data: {
          approvalId,
          targetSha,
          policyHash,
          ownerGeneration: owner.generation,
          verificationAttemptId,
        },
        now,
      });
      return {
        status:
          status === 'approved' ? ('approved' as const) : ('pending' as const),
        approvalId,
      };
    });
  } finally {
    writable.close();
  }
}

function admissionPolicyHash(policyHash: string, mode: string) {
  return createHash('sha256').update(`${policyHash}:${mode}`).digest('hex');
}

function safeJsonRecord(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (!value || typeof value !== 'string') return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {} as Record<string, unknown>;
  }
}

export async function approvePreparedDiffPushWithPolicy(
  input: unknown,
  paths: RuntimePaths = runtimePaths(),
): Promise<PreparedDiffActionResult> {
  const parsed = v.safeParse(approvePushInputSchema, input);
  const unavailableBinding = {
    targetSha: '',
    policyHash: '',
    policyDecision: 'allow' as const,
  };
  if (!parsed.success) {
    return approvePreparedDiffPush(input, paths, unavailableBinding);
  }
  const preparedDiff = readPreparedDiff(parsed.output.preparedDiffId, paths);
  if (!preparedDiff) {
    return approvePreparedDiffPush(input, paths, unavailableBinding);
  }
  const targetSha = await gitCurrentSha(preparedDiff.sourceWorktreePath).catch(
    () => null,
  );
  if (!targetSha) {
    return approvePreparedDiffPush(input, paths, unavailableBinding);
  }
  const policy = await checkAutopilotPolicy(
    {
      worktreeId: preparedDiff.worktreeId,
      diffBaseRef: preparedDiff.headSha ?? preparedDiff.baseRef,
      pushDestination: 'pull-request-head',
    },
    paths,
  );
  if (policy.decision === 'deny') {
    return {
      ok: false,
      action: 'prepared_diff_approve_push',
      changed: false,
      message:
        'Prepared diff policy denies push-back; approval cannot override it.',
      errors: policy.reasons,
      requires: policy.requires,
    };
  }
  const policyHash = admissionPolicyHash(policy.policyHash, policy.mode);
  const admissionResolution = resolveAdmissionBoundPushApproval(
    parsed.output,
    preparedDiff,
    targetSha,
    policyHash,
    policy.decision,
    paths,
  );
  if (admissionResolution) return admissionResolution;
  return approvePreparedDiffPush(input, paths, {
    targetSha,
    policyHash: policy.policyHash,
    policyDecision: policy.decision,
  });
}

export function rejectAdmissionBoundPushApproval(
  approvalId: string,
  input: { reason?: string; approverSurface?: string } = {},
  paths: RuntimePaths = runtimePaths(),
): PreparedDiffActionResult {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const row = database
        .prepare(
          `SELECT approval.id, approval.prepared_diff_id, approval.status,
                  approval.owner_generation, approval.stage_attempt_id,
                  approval.target_sha, approval.policy_hash,
                  admission.id AS admission_id, admission.state AS admission_state,
                  admission.version AS admission_version,
                  admission.prepared_diff_id AS admission_prepared_diff_id,
                  admission.last_outcome_json,
                  owner.generation AS current_owner_generation,
                  (SELECT id FROM autopilot_stage_attempts
                   WHERE admission_id = admission.id
                     AND stage = 'verify' AND status = 'completed'
                   ORDER BY attempt_number DESC LIMIT 1) AS verification_attempt_id
           FROM prepared_diff_approvals AS approval
           INNER JOIN autopilot_admissions AS admission
             ON admission.id = approval.admission_id
           INNER JOIN autopilot_pr_owners AS owner ON owner.id = admission.owner_id
           WHERE approval.id = ? AND approval.approval_type = 'push'
             AND approval.admission_id IS NOT NULL;`,
        )
        .get(approvalId) as
        | {
            id: string;
            prepared_diff_id: string;
            status: string;
            owner_generation: number | null;
            stage_attempt_id: string | null;
            target_sha: string | null;
            policy_hash: string | null;
            admission_id: string;
            admission_state: string;
            admission_version: number;
            admission_prepared_diff_id: string | null;
            last_outcome_json: string | null;
            current_owner_generation: number;
            verification_attempt_id: string | null;
          }
        | undefined;
      if (!row) {
        return {
          ok: false,
          action: 'prepared_diff_reject_push',
          changed: false,
          message: `Admission-bound push approval ${approvalId} was not found.`,
          errors: ['approval not found'],
        };
      }
      if (row.status !== 'pending') {
        return {
          ok: false,
          action: 'prepared_diff_reject_push',
          changed: false,
          message: `Push approval ${approvalId} is already ${row.status}.`,
          requires: ['pendingApproval'],
        };
      }
      const outcome = safeJsonRecord(row.last_outcome_json);
      const artifact = safeJsonRecord(outcome.artifact);
      const bindingCurrent =
        row.admission_state === 'approval-pending' &&
        row.admission_prepared_diff_id === row.prepared_diff_id &&
        row.owner_generation === row.current_owner_generation &&
        row.stage_attempt_id === row.verification_attempt_id &&
        row.target_sha === artifact.approvalTargetSha &&
        row.policy_hash === artifact.approvalPolicyHash;
      const now = new Date().toISOString();
      if (!bindingCurrent) {
        database
          .prepare(
            `UPDATE prepared_diff_approvals
             SET status = 'superseded',
                 reason = 'approval binding changed before operator rejection',
                 resolved_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending';`,
          )
          .run(now, now, row.id);
        insertAutopilotAdmissionEvent(database, {
          admissionId: row.admission_id,
          fromState: row.admission_state as 'approval-pending',
          toState: row.admission_state as 'approval-pending',
          reason: 'admission-bound-push-approval-rejection-superseded',
          data: { approvalId: row.id },
          now,
        });
        return {
          ok: false,
          action: 'prepared_diff_reject_push',
          changed: true,
          message:
            'The approval binding changed and was superseded; the coordinator will create a current replacement if one is still needed.',
          requires: ['fresh-approval'],
        };
      }
      const rejected = database
        .prepare(
          `UPDATE prepared_diff_approvals
           SET status = 'rejected', reason = COALESCE(?, reason),
               approver_surface = COALESCE(?, approver_surface),
               resolved_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending';`,
        )
        .run(
          input.reason ?? 'Push rejected by operator.',
          input.approverSurface ?? null,
          now,
          now,
          row.id,
        );
      if (rejected.changes !== 1) {
        return {
          ok: false,
          action: 'prepared_diff_reject_push',
          changed: false,
          message: 'The push approval changed before it could be rejected.',
          requires: ['fresh-approval'],
        };
      }
      const admission = database
        .prepare(
          `UPDATE autopilot_admissions
           SET state = 'manual-review', current_workflow = NULL,
               current_run_id = NULL, current_stage_attempt_id = NULL,
               next_attempt_at = NULL, last_error = ?, last_outcome_json = ?,
               completed_at = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ? AND state = 'approval-pending';`,
        )
        .run(
          'Push approval rejected by operator.',
          JSON.stringify({
            stage: 'push',
            result: 'blocked',
            retryClass: 'permanent',
            errorCode: 'push-approval-rejected',
            message: 'Push approval rejected by operator.',
          }),
          now,
          now,
          row.admission_id,
          row.admission_version,
        );
      if (admission.changes !== 1) {
        throw new Error('Admission changed while rejecting its push approval.');
      }
      database
        .prepare(
          `UPDATE prepared_diffs
           SET status = 'push-blocked', push_approval_status = 'rejected',
               updated_at = ? WHERE id = ?;`,
        )
        .run(now, row.prepared_diff_id);
      insertAutopilotAdmissionEvent(database, {
        admissionId: row.admission_id,
        fromState: 'approval-pending',
        toState: 'manual-review',
        reason: 'admission-bound-push-approval-rejected',
        data: { approvalId: row.id },
        now,
      });
      return {
        ok: true,
        action: 'prepared_diff_reject_push',
        changed: true,
        message:
          'Rejected the admission-bound push approval and moved the admission to manual review.',
      };
    });
  } finally {
    database.close();
  }
}

function resolveAdmissionBoundPushApproval(
  input: v.InferOutput<typeof approvePushInputSchema>,
  preparedDiff: NonNullable<ReturnType<typeof readPreparedDiff>>,
  targetSha: string,
  policyHash: string,
  policyDecision: 'require-approval' | 'allow',
  paths: RuntimePaths,
): PreparedDiffActionResult | undefined {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const rows = database
        .prepare(
          `SELECT * FROM prepared_diff_approvals
           WHERE prepared_diff_id = ? AND approval_type = 'push'
             AND admission_id IS NOT NULL AND status IN ('pending', 'approved')
           ORDER BY requested_at DESC;`,
        )
        .all(preparedDiff.id) as Array<{
        id: string;
        prepared_diff_id: string;
        status: string;
        admission_id: string;
        owner_generation: number | null;
        stage_attempt_id: string | null;
        target_sha: string | null;
        policy_hash: string | null;
        worktree_id: string;
        requested_at: string;
      }>;
      if (rows.length === 0) return undefined;
      const row = input.approvalId
        ? rows.find((candidate) => candidate.id === input.approvalId)
        : rows.length === 1
          ? rows[0]
          : undefined;
      if (!row) {
        return {
          ok: false,
          action: 'prepared_diff_approve_push',
          changed: false,
          message:
            'More than one admission-bound push approval is pending; select the exact approval id.',
          requires: ['approvalId'],
          errors: ['Approval resolution is scoped to one durable admission.'],
        };
      }
      if (!row) return undefined;
      const binding = database
        .prepare(
          `SELECT admission.id, admission.prepared_diff_id,
                  owner.generation AS owner_generation,
                  (SELECT id FROM autopilot_stage_attempts
                   WHERE admission_id = admission.id
                     AND stage = 'verify' AND status = 'completed'
                   ORDER BY attempt_number DESC LIMIT 1) AS verification_attempt_id
           FROM autopilot_admissions AS admission
           INNER JOIN autopilot_pr_owners AS owner ON owner.id = admission.owner_id
           WHERE admission.id = ? AND admission.state = 'approval-pending';`,
        )
        .get(row.admission_id) as
        | {
            id: string;
            prepared_diff_id: string | null;
            owner_generation: number;
            verification_attempt_id: string | null;
          }
        | undefined;
      const current =
        binding &&
        binding.prepared_diff_id === row.prepared_diff_id &&
        row.owner_generation === binding.owner_generation &&
        row.stage_attempt_id === binding.verification_attempt_id &&
        row.target_sha === targetSha &&
        row.policy_hash === policyHash;
      const now = new Date().toISOString();
      if (!current) {
        database
          .prepare(
            `UPDATE prepared_diff_approvals
             SET status = 'superseded',
                 reason = 'approval binding changed before operator resolution',
                 resolved_at = ?, updated_at = ?
             WHERE id = ? AND status IN ('pending', 'approved');`,
          )
          .run(now, now, row.id);
        return {
          ok: false,
          action: 'prepared_diff_approve_push',
          changed: true,
          message:
            'The approval was superseded because the current SHA, policy, owner generation, or verification attempt changed.',
          requires: ['fresh-approval'],
          errors: [
            'The coordinator will create a new admission-bound approval.',
          ],
        };
      }
      if (row.status === 'approved') {
        return {
          ok: true,
          action: 'prepared_diff_approve_push',
          changed: false,
          message:
            'The current admission-bound push approval was already resolved.',
          preparedDiff,
          approvals: [
            {
              id: row.id,
              preparedDiffId: preparedDiff.id,
              worktreeId: row.worktree_id,
              admissionId: row.admission_id,
              ownerGeneration: row.owner_generation,
              stageAttemptId: row.stage_attempt_id,
              approvalType: 'push',
              status: 'approved',
              targetSha,
              policyHash,
              policyDecision,
              reason: null,
              approverSurface: null,
              requestedAt: row.requested_at,
              resolvedAt: null,
              updatedAt: now,
            },
          ],
        };
      }
      if (input.confirm !== true) {
        return {
          ok: false,
          action: 'prepared_diff_approve_push',
          changed: false,
          message: 'Approving prepared diff push-back requires confirm=true.',
          requires: ['confirm'],
          errors: ['confirm=true is required.'],
        };
      }
      const summary =
        preparedDiff.summary &&
        typeof preparedDiff.summary === 'object' &&
        !Array.isArray(preparedDiff.summary)
          ? preparedDiff.summary
          : {};
      database
        .prepare(
          `UPDATE prepared_diff_approvals
           SET status = 'approved', reason = COALESCE(?, reason),
               approver_surface = COALESCE(?, approver_surface),
               policy_decision = ?, resolved_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending';`,
        )
        .run(
          input.reason ?? null,
          input.approverSurface ?? null,
          policyDecision,
          now,
          now,
          row.id,
        );
      database
        .prepare(
          `UPDATE prepared_diffs
           SET status = 'push-approved', push_approval_status = 'approved',
               summary_json = ?, updated_at = ?
           WHERE id = ?;`,
        )
        .run(
          JSON.stringify({
            ...summary,
            pushApproval: {
              approvedCommitSha: targetSha,
              approvedAt: now,
              reason: input.reason ?? null,
            },
          }),
          now,
          preparedDiff.id,
        );
      insertAutopilotAdmissionEvent(database, {
        admissionId: row.admission_id,
        fromState: 'approval-pending',
        toState: 'approval-pending',
        reason: 'admission-bound-push-approval-resolved',
        data: { approvalId: row.id, targetSha, policyHash },
        now,
      });
      const approval: PreparedDiffApprovalRecord = {
        id: row.id,
        preparedDiffId: preparedDiff.id,
        worktreeId: row.worktree_id,
        admissionId: row.admission_id,
        ownerGeneration: row.owner_generation,
        stageAttemptId: row.stage_attempt_id,
        approvalType: 'push',
        status: 'approved',
        targetSha,
        policyHash,
        policyDecision,
        reason: input.reason ?? null,
        approverSurface: input.approverSurface ?? null,
        requestedAt: row.requested_at,
        resolvedAt: now,
        updatedAt: now,
      };
      return {
        ok: true,
        action: 'prepared_diff_approve_push',
        changed: true,
        message:
          'Recorded the admission-bound push approval. The coordinator will dispatch the push workflow.',
        preparedDiff: {
          ...preparedDiff,
          status: 'push-approved',
          pushApprovalStatus: 'approved',
          updatedAt: now,
        },
        approvals: [approval],
      };
    });
  } finally {
    database.close();
  }
}
