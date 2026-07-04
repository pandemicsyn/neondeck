import { type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../../lib/action-result';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { checkAutopilotPolicy } from '../../../autopilot-policy';
import { openDb } from '../../../lib/sqlite';
import { type RuntimePaths } from '../../../runtime-home';
import {
  stateRowSchema,
  taskRowSchema,
  type KiloPromotionStatus,
  type KiloResultActionResult,
  type KiloResultClassification,
  type KiloResultState,
  type KiloVerificationStatus,
} from './schemas';

export function listStateRows(
  input: { taskId?: string; limit?: number },
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    return input.taskId
      ? database
          .prepare('SELECT * FROM kilo_result_state WHERE task_id = ?;')
          .all(input.taskId)
      : database
          .prepare(
            `
            SELECT *
            FROM kilo_result_state
            ORDER BY updated_at DESC
            LIMIT ?;
          `,
          )
          .all(input.limit ?? 50);
  } finally {
    database.close();
  }
}
export function readKiloTask(taskId: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT id, title, repo_id, repo_full_name, worktree_id, cwd, status
        FROM kilo_tasks
        WHERE id = ?;
      `,
      )
      .get(taskId);
    if (!row) return null;
    const parsed = v.parse(taskRowSchema, row);
    return {
      id: parsed.id,
      title: parsed.title,
      repoId: parsed.repo_id,
      repoFullName: parsed.repo_full_name,
      worktreeId: parsed.worktree_id,
      cwd: parsed.cwd,
      status: parsed.status,
    };
  } finally {
    database.close();
  }
}

export function readKiloResultState(taskId: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM kilo_result_state WHERE task_id = ?;')
      .get(taskId);
    return row ? readStateRow(row) : null;
  } finally {
    database.close();
  }
}

export function readPreparedDiffByWorktree(
  worktreeId: string,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT id, push_approval_status
        FROM prepared_diffs
        WHERE worktree_id = ?;
      `,
      )
      .get(worktreeId) as
      { id: string; push_approval_status: string } | undefined;
    return row
      ? {
          id: row.id,
          pushApprovalStatus: row.push_approval_status,
        }
      : null;
  } finally {
    database.close();
  }
}

export function resetPreparedDiffApproval(
  preparedDiffId: string,
  reason: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare(
        `
        SELECT id, worktree_id, status, push_approval_status, verification_status
        FROM prepared_diffs
        WHERE id = ?;
      `,
      )
      .get(preparedDiffId) as
      | {
          id: string;
          worktree_id: string;
          status: string;
          push_approval_status: string;
          verification_status: string;
        }
      | undefined;
    if (
      !row ||
      (row.push_approval_status === 'pending' &&
        row.status === 'prepared' &&
        row.verification_status === 'not-run')
    ) {
      return;
    }
    database
      .prepare(
        `
        UPDATE prepared_diffs
        SET push_approval_status = 'pending',
            verification_status = 'not-run',
            status = 'prepared',
            updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(now, preparedDiffId);
    database
      .prepare(
        `
        UPDATE prepared_diff_approvals
        SET status = 'superseded',
            reason = COALESCE(reason, ?),
            resolved_at = COALESCE(resolved_at, ?),
            updated_at = ?
        WHERE prepared_diff_id = ?
          AND status IN ('pending', 'approved');
      `,
      )
      .run(reason, now, now, preparedDiffId);
    database
      .prepare(
        `
        INSERT INTO prepared_diff_approvals (
          id, prepared_diff_id, worktree_id, approval_type, status, reason,
          approver_surface, requested_at, resolved_at, updated_at
        )
        VALUES (?, ?, ?, 'push', 'pending', ?, 'kilo_result_review', ?, NULL, ?);
      `,
      )
      .run(randomUUID(), preparedDiffId, row.worktree_id, reason, now, now);
  } finally {
    database.close();
  }
}

export function upsertKiloResultState(
  taskId: string,
  input: Partial<
    Pick<
      KiloResultState,
      | 'preparedDiffId'
      | 'classification'
      | 'verificationStatus'
      | 'promotionStatus'
      | 'diffFingerprint'
      | 'verifiedDiffFingerprint'
      | 'reviewSummary'
      | 'diffSummary'
      | 'policy'
      | 'verification'
      | 'promotion'
      | 'pendingApprovals'
      | 'reviewedAt'
      | 'verifiedAt'
      | 'promotedAt'
    >
  >,
  paths: RuntimePaths,
) {
  const current = readKiloResultState(taskId, paths);
  const now = new Date().toISOString();
  const state: KiloResultState = {
    taskId,
    preparedDiffId: input.preparedDiffId ?? current?.preparedDiffId ?? null,
    classification:
      input.classification ?? current?.classification ?? 'needs-review',
    verificationStatus:
      input.verificationStatus ?? current?.verificationStatus ?? 'not-run',
    promotionStatus:
      input.promotionStatus ?? current?.promotionStatus ?? 'not-requested',
    diffFingerprint: stateField(
      input,
      'diffFingerprint',
      current?.diffFingerprint ?? null,
    ),
    verifiedDiffFingerprint: stateField(
      input,
      'verifiedDiffFingerprint',
      current?.verifiedDiffFingerprint ?? null,
    ),
    reviewSummary: stateField(
      input,
      'reviewSummary',
      current?.reviewSummary ?? null,
    ),
    diffSummary: stateField(input, 'diffSummary', current?.diffSummary ?? null),
    policy: stateField(input, 'policy', current?.policy ?? null),
    verification: stateField(
      input,
      'verification',
      current?.verification ?? null,
    ),
    promotion: stateField(input, 'promotion', current?.promotion ?? null),
    pendingApprovals: input.pendingApprovals ?? current?.pendingApprovals ?? [],
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    reviewedAt: input.reviewedAt ?? current?.reviewedAt ?? null,
    verifiedAt: stateField(input, 'verifiedAt', current?.verifiedAt ?? null),
    promotedAt: stateField(input, 'promotedAt', current?.promotedAt ?? null),
  };
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO kilo_result_state (
          task_id, prepared_diff_id, classification, verification_status,
          promotion_status, diff_fingerprint, verified_diff_fingerprint,
          review_summary_json, diff_summary_json, policy_json,
          verification_json, promotion_json, pending_approvals_json,
          created_at, updated_at, reviewed_at, verified_at, promoted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          prepared_diff_id = excluded.prepared_diff_id,
          classification = excluded.classification,
          verification_status = excluded.verification_status,
          promotion_status = excluded.promotion_status,
          diff_fingerprint = excluded.diff_fingerprint,
          verified_diff_fingerprint = excluded.verified_diff_fingerprint,
          review_summary_json = excluded.review_summary_json,
          diff_summary_json = excluded.diff_summary_json,
          policy_json = excluded.policy_json,
          verification_json = excluded.verification_json,
          promotion_json = excluded.promotion_json,
          pending_approvals_json = excluded.pending_approvals_json,
          updated_at = excluded.updated_at,
          reviewed_at = excluded.reviewed_at,
          verified_at = excluded.verified_at,
          promoted_at = excluded.promoted_at;
      `,
      )
      .run(
        state.taskId,
        state.preparedDiffId,
        state.classification,
        state.verificationStatus,
        state.promotionStatus,
        state.diffFingerprint,
        state.verifiedDiffFingerprint,
        jsonOrNull(state.reviewSummary),
        jsonOrNull(state.diffSummary),
        jsonOrNull(state.policy),
        jsonOrNull(state.verification),
        jsonOrNull(state.promotion),
        JSON.stringify(state.pendingApprovals),
        state.createdAt,
        state.updatedAt,
        state.reviewedAt,
        state.verifiedAt,
        state.promotedAt,
      );
  } finally {
    database.close();
  }
  return state;
}

function stateField<TKey extends keyof KiloResultState>(
  input: Partial<KiloResultState>,
  key: TKey,
  fallback: KiloResultState[TKey],
): KiloResultState[TKey] {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? (input[key] as KiloResultState[TKey])
    : fallback;
}

export function updateKiloTaskStatus(
  taskId: string,
  status: string,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE kilo_tasks
        SET status = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(status, new Date().toISOString(), taskId);
  } finally {
    database.close();
  }
}

export function insertKiloResultEvent(
  taskId: string,
  eventType: string,
  summary: string,
  data: unknown,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO kilo_result_events (
          id, task_id, event_type, summary, data_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        randomUUID(),
        taskId,
        eventType,
        summary,
        data === null || data === undefined
          ? null
          : JSON.stringify(asJsonValue(data)),
        now,
      );
  } finally {
    database.close();
  }
}

export function readStateRow(row: unknown): KiloResultState {
  const parsed = v.parse(stateRowSchema, row);
  return {
    taskId: parsed.task_id,
    preparedDiffId: parsed.prepared_diff_id,
    classification: parseClassification(parsed.classification),
    verificationStatus: parseVerificationStatus(parsed.verification_status),
    promotionStatus: parsePromotionStatus(parsed.promotion_status),
    diffFingerprint: parsed.diff_fingerprint,
    verifiedDiffFingerprint: parsed.verified_diff_fingerprint,
    reviewSummary: parseJson(parsed.review_summary_json),
    diffSummary: parseJson(parsed.diff_summary_json),
    policy: parseJson(parsed.policy_json),
    verification: parseJson(parsed.verification_json),
    promotion: parseJson(parsed.promotion_json),
    pendingApprovals: parseJsonArray(parsed.pending_approvals_json),
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
    reviewedAt: parsed.reviewed_at,
    verifiedAt: parsed.verified_at,
    promotedAt: parsed.promoted_at,
  };
}

export function pendingApprovalsFor(
  preparedDiff: { id: string; pushApprovalStatus: string } | null,
  policy: Awaited<ReturnType<typeof checkAutopilotPolicy>> | null,
): JsonValue[] {
  const approvals: JsonValue[] = [];
  if (preparedDiff?.pushApprovalStatus === 'pending') {
    approvals.push({
      type: 'prepared-diff-push',
      status: 'pending',
      preparedDiffId: preparedDiff.id,
    });
  }
  if (policy?.approvalRequired) {
    approvals.push({
      type: 'autopilot-policy',
      status: 'required',
      requires: policy.requires,
    });
  }
  return approvals;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseClassification(value: string): KiloResultClassification {
  const parsed = v.safeParse(
    v.picklist(['discard', 'needs-review', 'ready-to-verify', 'ready-to-push']),
    value,
  );
  return parsed.success ? parsed.output : 'needs-review';
}

function parseVerificationStatus(value: string): KiloVerificationStatus {
  const parsed = v.safeParse(
    v.picklist(['not-run', 'running', 'passed', 'failed', 'blocked']),
    value,
  );
  return parsed.success ? parsed.output : 'not-run';
}

function parsePromotionStatus(value: string): KiloPromotionStatus {
  const parsed = v.safeParse(
    v.picklist(['not-requested', 'blocked', 'ready', 'deferred']),
    value,
  );
  return parsed.success ? parsed.output : 'not-requested';
}

export function parseInput<T>(
  schema: v.GenericSchema<unknown, T>,
  rawInput: unknown,
  action: string,
): { ok: true; input: T } | { ok: false; result: KiloResultActionResult } {
  const parsed = v.safeParse(schema, rawInput);
  if (parsed.success) return { ok: true, input: parsed.output };
  return {
    ok: false,
    result: {
      ok: false,
      action,
      changed: false,
      message: `Invalid Kilo result input: ${v.summarize(parsed.issues)}`,
      errors: parsed.issues.map((issue) => issue.message),
    },
  };
}

export function notFound(
  action: string,
  taskId: string,
): KiloResultActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: `Kilo task ${taskId} was not found.`,
    requires: ['taskId'],
  };
}

export function jsonBoolean(value: unknown, path: string[]) {
  let cursor = value;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || !(key in cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === 'boolean' ? cursor : null;
}

function jsonOrNull(value: unknown) {
  return value === null || value === undefined
    ? null
    : JSON.stringify(asJsonValue(value));
}

function parseJson(value: string | null): JsonValue | null {
  if (value === null) return null;
  try {
    return asJsonValue(JSON.parse(value));
  } catch {
    return null;
  }
}

function parseJsonArray(value: string): JsonValue[] {
  try {
    const parsed = v.safeParse(v.array(v.unknown()), JSON.parse(value));
    return parsed.success ? parsed.output.map(asJsonValue) : [];
  } catch {
    return [];
  }
}
