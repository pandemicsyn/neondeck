/* eslint-disable no-unused-vars */
import { defineAction, defineTool, type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import { randomUUID } from 'node:crypto';
import * as v from 'valibot';
import { addNotification } from '../app-state';
import { buildPreparedDiffAuditSummary } from '../autonomous-audit';
import { openDb } from '../../lib/sqlite';
import { gitCurrentSha, gitDiff, type RepoDiffFile } from '../../repo-edit/git';
import {
  type RuntimePaths,
  ensureRuntimeHome,
  runtimePaths,
} from '../../runtime-home';
import {
  approvalRowSchema,
  listInputSchema,
  preparedDiffRecordSchema,
  preparedDiffRowSchema,
  worktreeRowSchema,
  type PreparedDiffActionResult,
  type PreparedDiffApprovalRecord,
  type PreparedDiffRecord,
  type PreparedDiffStatus,
  type WorktreeRecordLike,
} from './schemas';

export function listPreparedDiffRecords(
  input: v.InferOutput<typeof listInputSchema>,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (input.status) {
      clauses.push('status = ?');
      args.push(input.status);
    } else if (!input.includeTerminal) {
      clauses.push("status NOT IN ('abandoned', 'pushed')");
    }
    if (input.repoId) {
      clauses.push('repo_id = ?');
      args.push(input.repoId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return database
      .prepare(
        `
        SELECT *
        FROM prepared_diffs
        ${where}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 100;
      `,
      )
      .all(...args)
      .map(readPreparedDiffRow);
  } finally {
    database.close();
  }
}

export function readPreparedDiffRecord(id: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM prepared_diffs WHERE id = ?;')
      .get(id);
    return row ? readPreparedDiffRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function readPreparedDiffByWorktreeId(
  worktreeId: string,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM prepared_diffs WHERE worktree_id = ?;')
      .get(worktreeId);
    return row ? readPreparedDiffRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function upsertPreparedDiff(
  record: PreparedDiffRecord,
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO prepared_diffs (
          id, worktree_id, repo_id, repo_full_name, pr_number, title,
          source_worktree_path, base_ref, head_ref, head_sha, status,
          push_approval_status, verification_status, summary_json, created_by,
          created_at, updated_at, abandoned_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_id) DO UPDATE SET
          repo_id = excluded.repo_id,
          repo_full_name = excluded.repo_full_name,
          pr_number = excluded.pr_number,
          title = excluded.title,
          source_worktree_path = excluded.source_worktree_path,
          base_ref = excluded.base_ref,
          head_ref = excluded.head_ref,
          head_sha = excluded.head_sha,
          status = excluded.status,
          push_approval_status = excluded.push_approval_status,
          verification_status = excluded.verification_status,
          summary_json = excluded.summary_json,
          updated_at = excluded.updated_at,
          abandoned_at = excluded.abandoned_at;
      `,
      )
      .run(
        record.id,
        record.worktreeId,
        record.repoId,
        record.repoFullName,
        record.prNumber,
        record.title,
        record.sourceWorktreePath,
        record.baseRef,
        record.headRef,
        record.headSha,
        record.status,
        record.pushApprovalStatus,
        record.verificationStatus,
        record.summary === null ? null : JSON.stringify(record.summary),
        record.createdBy,
        record.createdAt,
        record.updatedAt,
        record.abandonedAt,
      );
  } finally {
    database.close();
  }
}

export function updatePreparedDiffState(
  id: string,
  input: Partial<
    Pick<
      PreparedDiffRecord,
      | 'status'
      | 'pushApprovalStatus'
      | 'verificationStatus'
      | 'summary'
      | 'abandonedAt'
    >
  >,
  paths: RuntimePaths,
) {
  const current = readPreparedDiffRecord(id, paths);
  if (!current) {
    throw new Error(`Prepared diff ${id} was not found.`);
  }
  const updated: PreparedDiffRecord = {
    ...current,
    ...input,
    updatedAt: new Date().toISOString(),
  };
  upsertPreparedDiff(updated, paths);
  return updated;
}

export function updatePreparedDiffVerificationWithLease(
  id: string,
  input: {
    lockId: string;
    status: 'passed' | 'failed';
    verification: Record<string, unknown>;
  },
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase);
  let committed = false;
  try {
    database.exec('BEGIN IMMEDIATE;');
    const now = new Date().toISOString();
    const lease = database
      .prepare(
        `
        SELECT id
        FROM worktree_locks
        WHERE id = ?
          AND released_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ?;
      `,
      )
      .get(input.lockId, now);
    if (!lease) {
      throw Object.assign(
        new Error(
          `Worktree lock ${input.lockId} is no longer active; verification was not recorded.`,
        ),
        { code: 'WORKTREE_LOCKED' },
      );
    }
    const row = database
      .prepare('SELECT * FROM prepared_diffs WHERE id = ?;')
      .get(id);
    if (!row) throw new Error(`Prepared diff ${id} was not found.`);
    const current = readPreparedDiffRow(row);
    const updated: PreparedDiffRecord = {
      ...current,
      verificationStatus: input.status,
      summary: mergeSummary(current.summary, {
        verification: input.verification,
      }),
      updatedAt: now,
    };
    database
      .prepare(
        `
        UPDATE prepared_diffs
        SET verification_status = ?, summary_json = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        updated.verificationStatus,
        updated.summary === null ? null : JSON.stringify(updated.summary),
        updated.updatedAt,
        updated.id,
      );
    database.exec('COMMIT;');
    committed = true;
    return updated;
  } catch (error) {
    if (!committed) database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
}

export function assertTransition(
  record: PreparedDiffRecord,
  action: string,
  transition: string,
  allowedFrom: PreparedDiffStatus[],
):
  | { ok: true }
  | {
      ok: false;
      result: PreparedDiffActionResult;
    } {
  if (allowedFrom.includes(record.status)) return { ok: true };
  return {
    ok: false,
    result: failure(
      action,
      `Cannot ${transition} prepared diff ${record.id} from status ${record.status}.`,
      'INVALID_TRANSITION',
    ),
  };
}

export function ensurePendingApproval(
  record: PreparedDiffRecord,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  reason: string,
  paths: RuntimePaths,
) {
  const existing = pendingApproval(record.id, approvalType, paths);
  if (existing) return existing;
  return insertApproval(
    record,
    approvalType,
    'pending',
    reason,
    undefined,
    {},
    paths,
  );
}

export function supersedeApprovals(
  preparedDiffId: string,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  reason: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE prepared_diff_approvals
        SET status = 'superseded',
            reason = ?,
            resolved_at = COALESCE(resolved_at, ?),
            updated_at = ?
        WHERE prepared_diff_id = ?
          AND approval_type = ?
          AND status IN ('pending', 'approved', 'rejected');
      `,
      )
      .run(reason, now, now, preparedDiffId, approvalType);
  } finally {
    database.close();
  }
}

export function resolvePendingApprovals(
  record: PreparedDiffRecord,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  status: 'approved' | 'rejected' | 'superseded',
  reason: string | undefined,
  approverSurface: string | undefined,
  binding: {
    targetSha?: string | null;
    policyHash?: string | null;
    policyDecision?: 'deny' | 'require-approval' | 'allow' | null;
  } = {},
  paths: RuntimePaths,
) {
  const pending = pendingApproval(record.id, approvalType, paths);
  if (!pending) {
    return insertApproval(
      record,
      approvalType,
      status,
      reason,
      approverSurface,
      binding,
      paths,
    );
  }

  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE prepared_diff_approvals
        SET
          status = ?,
          reason = COALESCE(?, reason),
          approver_surface = COALESCE(?, approver_surface),
          target_sha = COALESCE(?, target_sha),
          policy_hash = COALESCE(?, policy_hash),
          policy_decision = COALESCE(?, policy_decision),
          resolved_at = ?,
          updated_at = ?
        WHERE prepared_diff_id = ?
          AND approval_type = ?
          AND status = 'pending';
      `,
      )
      .run(
        status,
        reason ?? null,
        approverSurface ?? null,
        binding.targetSha ?? null,
        binding.policyHash ?? null,
        binding.policyDecision ?? null,
        now,
        now,
        record.id,
        approvalType,
      );
  } finally {
    database.close();
  }

  return (
    readApprovalRecord(pending.id, paths) ??
    insertApproval(
      record,
      approvalType,
      status,
      reason,
      approverSurface,
      binding,
      paths,
    )
  );
}

export function pendingApproval(
  preparedDiffId: string,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  paths: RuntimePaths,
) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM prepared_diff_approvals
        WHERE prepared_diff_id = ?
          AND approval_type = ?
          AND status = 'pending'
        ORDER BY requested_at DESC
        LIMIT 1;
      `,
      )
      .get(preparedDiffId, approvalType);
    return row ? readApprovalRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function readApprovalRecord(id: string, paths: RuntimePaths) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const row = database
      .prepare('SELECT * FROM prepared_diff_approvals WHERE id = ?;')
      .get(id);
    return row ? readApprovalRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function insertApproval(
  record: PreparedDiffRecord,
  approvalType: PreparedDiffApprovalRecord['approvalType'],
  status: PreparedDiffApprovalRecord['status'],
  reason: string | undefined,
  approverSurface: string | undefined,
  binding: {
    targetSha?: string | null;
    policyHash?: string | null;
    policyDecision?: 'deny' | 'require-approval' | 'allow' | null;
  } = {},
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const approval: PreparedDiffApprovalRecord = {
    id: randomUUID(),
    preparedDiffId: record.id,
    worktreeId: record.worktreeId,
    approvalType,
    status,
    targetSha: binding.targetSha ?? null,
    policyHash: binding.policyHash ?? null,
    policyDecision: binding.policyDecision ?? null,
    reason: reason ?? null,
    approverSurface: approverSurface ?? null,
    requestedAt: now,
    resolvedAt: status === 'pending' ? null : now,
    updatedAt: now,
  };
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        INSERT INTO prepared_diff_approvals (
          id, prepared_diff_id, worktree_id, approval_type, status, target_sha,
          policy_hash, policy_decision, reason,
          approver_surface, requested_at, resolved_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        approval.id,
        approval.preparedDiffId,
        approval.worktreeId,
        approval.approvalType,
        approval.status,
        approval.targetSha,
        approval.policyHash,
        approval.policyDecision,
        approval.reason,
        approval.approverSurface,
        approval.requestedAt,
        approval.resolvedAt,
        approval.updatedAt,
      );
  } finally {
    database.close();
  }
  return approval;
}

export function listApprovalRecords(
  input: { status?: string; preparedDiffIds?: string[] },
  paths: RuntimePaths,
) {
  if (input.preparedDiffIds && input.preparedDiffIds.length === 0) {
    return [];
  }
  const database = openDb(paths.neondeckDatabase, { readOnly: true });
  try {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (input.status) {
      clauses.push('status = ?');
      args.push(input.status);
    }
    if (input.preparedDiffIds?.length) {
      clauses.push(
        `prepared_diff_id IN (${input.preparedDiffIds.map(() => '?').join(', ')})`,
      );
      args.push(...input.preparedDiffIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return database
      .prepare(
        `
        SELECT *
        FROM prepared_diff_approvals
        ${where}
        ORDER BY updated_at DESC
        LIMIT 100;
      `,
      )
      .all(...args)
      .map(readApprovalRow);
  } finally {
    database.close();
  }
}

export function updateWorktreeLifecycle(
  worktreeId: string,
  status: string,
  paths: RuntimePaths,
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    const row = database
      .prepare('SELECT * FROM worktrees WHERE id = ?;')
      .get(worktreeId);
    const worktree = row ? readWorktreeRow(row) : undefined;
    database
      .prepare(
        `
        UPDATE worktrees
        SET lifecycle_status = ?, updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(status, now, worktreeId);
    if (worktree) {
      database
        .prepare(
          `
          INSERT INTO worktree_events (
            id, worktree_id, repo_id, event_type, status, message, data_json, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?);
        `,
        )
        .run(
          randomUUID(),
          worktree.id,
          worktree.repoId,
          'prepared_diff_abandoned',
          status,
          'Prepared diff was abandoned; worktree retained for cleanup policy.',
          null,
          now,
        );
    }
  } finally {
    database.close();
  }
}

export function readPreparedDiffRow(row: unknown): PreparedDiffRecord {
  const item = v.parse(preparedDiffRowSchema, row);
  return v.parse(preparedDiffRecordSchema, {
    id: item.id,
    worktreeId: item.worktree_id,
    repoId: item.repo_id,
    repoFullName: item.repo_full_name,
    prNumber: item.pr_number,
    title: item.title,
    sourceWorktreePath: item.source_worktree_path,
    baseRef: item.base_ref,
    headRef: item.head_ref,
    headSha: item.head_sha,
    status: item.status,
    pushApprovalStatus: item.push_approval_status,
    verificationStatus: item.verification_status,
    summary:
      item.summary_json === null
        ? null
        : (JSON.parse(item.summary_json) as JsonValue),
    sourceOfTruth: 'worktree',
    createdBy: item.created_by,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    abandonedAt: item.abandoned_at,
  }) as PreparedDiffRecord;
}

export function readApprovalRow(row: unknown): PreparedDiffApprovalRecord {
  const item = v.parse(approvalRowSchema, row);
  return {
    id: item.id,
    preparedDiffId: item.prepared_diff_id,
    worktreeId: item.worktree_id,
    approvalType:
      item.approval_type === 'revision' ||
      item.approval_type === 'abandon' ||
      item.approval_type === 'verification'
        ? item.approval_type
        : 'push',
    status:
      item.status === 'approved' ||
      item.status === 'rejected' ||
      item.status === 'superseded'
        ? item.status
        : 'pending',
    targetSha: item.target_sha,
    policyHash: item.policy_hash,
    policyDecision:
      item.policy_decision === 'deny' ||
      item.policy_decision === 'require-approval' ||
      item.policy_decision === 'allow'
        ? item.policy_decision
        : null,
    reason: item.reason,
    approverSurface: item.approver_surface,
    requestedAt: item.requested_at,
    resolvedAt: item.resolved_at,
    updatedAt: item.updated_at,
  };
}

export function readWorktreeRow(row: unknown): WorktreeRecordLike {
  const item = v.parse(worktreeRowSchema, row);
  return {
    id: item.id,
    repoId: item.repo_id,
    repoFullName: item.repo_full_name,
    prNumber: item.pr_number,
    localPath: item.local_path,
    baseRef: item.base_ref,
    headRef: item.head_ref,
    headSha: item.head_sha,
    lifecycleStatus: item.lifecycle_status,
  };
}

export function mergeSummary(
  current: JsonValue | null,
  next: Record<string, unknown>,
) {
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return asJsonValue({ ...base, ...next });
}

function failure(action: string, message: string, code: string) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    errors: [message],
    error: { code, message },
  };
}
