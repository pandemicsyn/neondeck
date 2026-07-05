import { type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { randomUUID } from 'node:crypto';
import type { ExecutionBackend, RuntimePaths } from '../../runtime-home';
import type {
  ExecutionContext,
  ExecutionDecision,
  ExecutionPolicyCheck,
  ExecutionRisk,
} from './policy';
import {
  approvalExecutionScopeKey,
  executionScopeKey,
  type ExecutionScope,
} from './scope';
import type {
  ExecutionApprovalDecision,
  ExecutionApprovalRecord,
  ExecutionApprovalStatus,
} from './schemas';
import * as v from 'valibot';
import { runExecutionInputSchema } from './schemas';

export function insertApproval(
  paths: RuntimePaths,
  input: {
    command: string;
    backend: ExecutionBackend;
    cwd?: string;
    context: ExecutionContext;
    risk: ExecutionRisk;
    policyDecision: ExecutionDecision;
    status: ExecutionApprovalStatus;
    approvalDecision?: ExecutionApprovalDecision;
    approverSurface?: string;
    sessionId?: string;
    requestContext?: unknown;
    result?: unknown;
    error?: string;
  },
) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const database = openDb(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        INSERT INTO execution_approvals (
          id,
          command,
          backend,
          cwd,
          context,
          risk,
          policy_decision,
          status,
          approval_decision,
          approver_surface,
          session_id,
          request_context_json,
          result_json,
          error,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        id,
        input.command,
        input.backend,
        input.cwd ?? null,
        input.context,
        input.risk,
        input.policyDecision,
        input.status,
        input.approvalDecision ?? null,
        input.approverSurface ?? null,
        input.sessionId ?? null,
        input.requestContext === undefined
          ? null
          : JSON.stringify(asJsonValue(input.requestContext)),
        input.result === undefined
          ? null
          : JSON.stringify(asJsonValue(input.result)),
        input.error ?? null,
        now,
        now,
      );
  } finally {
    database.close();
  }

  const record = readApproval(paths, id);
  if (!record) throw new Error(`Execution approval ${id} was not persisted.`);
  return record;
}

export function readApproval(paths: RuntimePaths, id: string) {
  const database = openDb(paths.neondeckDatabase, { readOnly: true });

  try {
    const row = database
      .prepare(
        `
        SELECT *
        FROM execution_approvals
        WHERE id = ?;
      `,
      )
      .get(id);
    return row ? readExecutionApprovalRow(row) : undefined;
  } finally {
    database.close();
  }
}

export function findSessionApproval(
  paths: RuntimePaths,
  policyCheck: ExecutionPolicyCheck,
  input: v.InferOutput<typeof runExecutionInputSchema>,
  expectedScope: ExecutionScope | null,
) {
  if (!input.sessionId) return undefined;
  const database = openDb(paths.neondeckDatabase, { readOnly: true });

  try {
    const rows = database
      .prepare(
        `
        SELECT *
        FROM execution_approvals
        WHERE command = ?
          AND backend = ?
          AND context = ?
          AND COALESCE(cwd, '') = ?
          AND session_id = ?
          AND status = 'approved'
          AND approval_decision = 'allow-session'
        ORDER BY resolved_at DESC, updated_at DESC
        LIMIT 25;
      `,
      )
      .all(
        policyCheck.command,
        policyCheck.backend,
        policyCheck.context,
        input.cwd ?? '',
        input.sessionId,
      );
    return rows
      .map(readExecutionApprovalRow)
      .find((approval) =>
        approvalMatches(approval, policyCheck, input.cwd, expectedScope),
      );
  } finally {
    database.close();
  }
}

export function updateApprovalResult(
  paths: RuntimePaths,
  id: string,
  input: {
    status: ExecutionApprovalStatus;
    exitCode?: number | null;
    stdoutPreview?: string | null;
    stderrPreview?: string | null;
    error?: string | null;
    result?: unknown;
    executedAt?: string | null;
  },
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        UPDATE execution_approvals
        SET
          status = ?,
          exit_code = ?,
          stdout_preview = ?,
          stderr_preview = ?,
          error = ?,
          result_json = ?,
          executed_at = ?,
          updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(
        input.status,
        input.exitCode ?? null,
        input.stdoutPreview ?? null,
        input.stderrPreview ?? null,
        input.error ?? null,
        input.result === undefined
          ? null
          : JSON.stringify(asJsonValue(input.result)),
        input.executedAt ?? null,
        now,
        id,
      );
  } finally {
    database.close();
  }

  const record = readApproval(paths, id);
  if (!record) throw new Error(`Execution approval ${id} was not found.`);
  return record;
}

export function markApprovalUsed(
  paths: RuntimePaths,
  id: string,
  options: { allowAlreadyUsed?: boolean } = {},
) {
  const now = new Date().toISOString();
  const allowAlreadyUsed = options.allowAlreadyUsed ?? true;
  const database = openDb(paths.neondeckDatabase);
  let changes = 0;

  try {
    const result = database
      .prepare(
        `
        UPDATE execution_approvals
        SET used_at = COALESCE(used_at, ?),
            updated_at = ?
        WHERE id = ?
          AND (? = 1 OR used_at IS NULL);
      `,
      )
      .run(now, now, id, allowAlreadyUsed ? 1 : 0);
    changes = Number(result.changes);
  } finally {
    database.close();
  }

  const record = readApproval(paths, id);
  if (!record) throw new Error(`Execution approval ${id} was not found.`);
  if (changes !== 1) return undefined;
  return record;
}

export function readExecutionApprovalRow(
  row: unknown,
): ExecutionApprovalRecord {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    command: String(record.command),
    backend: String(record.backend) as ExecutionBackend,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    context: String(record.context) as ExecutionContext,
    risk: String(record.risk) as ExecutionRisk,
    policyDecision: String(record.policy_decision) as ExecutionDecision,
    status: String(record.status) as ExecutionApprovalStatus,
    approvalDecision:
      typeof record.approval_decision === 'string'
        ? (record.approval_decision as ExecutionApprovalDecision)
        : null,
    approverSurface:
      typeof record.approver_surface === 'string'
        ? record.approver_surface
        : null,
    sessionId: typeof record.session_id === 'string' ? record.session_id : null,
    requestContext:
      typeof record.request_context_json === 'string'
        ? (JSON.parse(record.request_context_json) as JsonValue)
        : null,
    result:
      typeof record.result_json === 'string'
        ? (JSON.parse(record.result_json) as JsonValue)
        : null,
    exitCode: typeof record.exit_code === 'number' ? record.exit_code : null,
    stdoutPreview:
      typeof record.stdout_preview === 'string' ? record.stdout_preview : null,
    stderrPreview:
      typeof record.stderr_preview === 'string' ? record.stderr_preview : null,
    error: typeof record.error === 'string' ? record.error : null,
    createdAt: String(record.created_at),
    resolvedAt:
      typeof record.resolved_at === 'string' ? record.resolved_at : null,
    usedAt: typeof record.used_at === 'string' ? record.used_at : null,
    executedAt:
      typeof record.executed_at === 'string' ? record.executed_at : null,
    updatedAt: String(record.updated_at),
  };
}

export function approvalMatches(
  approval: ExecutionApprovalRecord,
  policyCheck: ExecutionPolicyCheck,
  cwd: string | undefined,
  expectedScope: ExecutionScope | null,
) {
  return (
    approval.command === policyCheck.command &&
    approval.backend === policyCheck.backend &&
    approval.context === policyCheck.context &&
    (approval.cwd ?? undefined) === cwd &&
    approvalExecutionScopeKey(approval) === executionScopeKey(expectedScope)
  );
}
