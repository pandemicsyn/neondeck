import { asJsonValue } from '../../lib/action-result';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
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

const executionApprovalRowSchema = v.object({
  id: v.string(),
  command: v.string(),
  backend: v.picklist(['local', 'exe.dev']),
  cwd: v.nullable(v.string()),
  context: v.picklist(['interactive', 'unattended']),
  risk: v.picklist([
    'read-only',
    'safe-mutation',
    'destructive-mutation',
    'hardline',
  ]),
  policy_decision: v.picklist(['allow', 'ask', 'deny']),
  status: v.picklist([
    'pending',
    'approved',
    'denied',
    'executed',
    'failed',
    'blocked',
  ]),
  approval_decision: v.nullable(
    v.picklist([
      'preapproved',
      'allow-once',
      'allow-session',
      'allow-always',
      'deny',
    ]),
  ),
  approver_surface: v.nullable(v.string()),
  session_id: v.nullable(v.string()),
  request_context_json: v.nullable(v.string()),
  result_json: v.nullable(v.string()),
  exit_code: v.nullable(v.number()),
  stdout_preview: v.nullable(v.string()),
  stderr_preview: v.nullable(v.string()),
  error: v.nullable(v.string()),
  created_at: v.string(),
  resolved_at: v.nullable(v.string()),
  used_at: v.nullable(v.string()),
  executed_at: v.nullable(v.string()),
  updated_at: v.string(),
});

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

const resolutionClaimPrefix = 'neondeck:resolving:';
const staleResolutionClaimMs = 5 * 60_000;

export function claimPendingApprovalResolution(
  paths: RuntimePaths,
  id: string,
  claimId: string,
  now = new Date(),
) {
  const claimedSurface = `${resolutionClaimPrefix}${claimId}`;
  const nowIso = now.toISOString();
  const staleBefore = new Date(
    now.getTime() - staleResolutionClaimMs,
  ).toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      database
        .prepare(
          `
          UPDATE execution_approvals
          SET approver_surface = NULL, updated_at = ?
          WHERE id = ?
            AND status = 'pending'
            AND approver_surface LIKE ?
            AND updated_at <= ?;
        `,
        )
        .run(nowIso, id, `${resolutionClaimPrefix}%`, staleBefore);
      const claimed = database
        .prepare(
          `
          UPDATE execution_approvals
          SET approver_surface = ?, updated_at = ?
          WHERE id = ?
            AND status = 'pending'
            AND approver_surface IS NULL;
        `,
        )
        .run(claimedSurface, nowIso, id);
      const row = database
        .prepare('SELECT * FROM execution_approvals WHERE id = ?;')
        .get(id);
      const approval = row ? readExecutionApprovalRow(row) : undefined;
      return {
        claimed: claimed.changes === 1,
        claimedSurface,
        approval: approval ? { ...approval, approverSurface: null } : undefined,
      };
    });
  } finally {
    database.close();
  }
}

export function completePendingApprovalResolution(
  paths: RuntimePaths,
  input: {
    id: string;
    claimedSurface: string;
    status: ExecutionApprovalStatus;
    decision: ExecutionApprovalDecision;
    approverSurface: string;
    result: unknown;
    resolvedAt: string;
  },
) {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () => {
      const update = database
        .prepare(
          `
          UPDATE execution_approvals
          SET
            status = ?,
            approval_decision = ?,
            approver_surface = ?,
            result_json = ?,
            resolved_at = ?,
            updated_at = ?
          WHERE id = ?
            AND status = 'pending'
            AND approver_surface = ?;
        `,
        )
        .run(
          input.status,
          input.decision,
          input.approverSurface,
          input.result === null
            ? null
            : JSON.stringify(asJsonValue(input.result)),
          input.resolvedAt,
          input.resolvedAt,
          input.id,
          input.claimedSurface,
        );
      const row = database
        .prepare('SELECT * FROM execution_approvals WHERE id = ?;')
        .get(input.id);
      return {
        changed: update.changes === 1,
        approval: row ? readExecutionApprovalRow(row) : undefined,
      };
    });
  } finally {
    database.close();
  }
}

export function releasePendingApprovalResolution(
  paths: RuntimePaths,
  id: string,
  claimedSurface: string,
) {
  const now = new Date().toISOString();
  const database = openDb(paths.neondeckDatabase);
  try {
    database
      .prepare(
        `
        UPDATE execution_approvals
        SET approver_surface = NULL, updated_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND approver_surface = ?;
      `,
      )
      .run(now, id, claimedSurface);
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

export function readExecutionApprovalRow<TRow>(
  row: TRow,
): ExecutionApprovalRecord {
  const record = v.parse(executionApprovalRowSchema, row);
  return {
    id: record.id,
    command: record.command,
    backend: record.backend,
    cwd: record.cwd,
    context: record.context,
    risk: record.risk,
    policyDecision: record.policy_decision,
    status: record.status,
    approvalDecision: record.approval_decision,
    approverSurface: record.approver_surface,
    sessionId: record.session_id ? (nonEmpty(record.session_id) ?? null) : null,
    requestContext:
      record.request_context_json !== null
        ? asJsonValue(JSON.parse(record.request_context_json))
        : null,
    result:
      record.result_json !== null
        ? asJsonValue(JSON.parse(record.result_json))
        : null,
    exitCode: record.exit_code,
    stdoutPreview: record.stdout_preview,
    stderrPreview: record.stderr_preview,
    error: record.error,
    createdAt: record.created_at,
    resolvedAt: record.resolved_at,
    usedAt: record.used_at,
    executedAt: record.executed_at,
    updatedAt: record.updated_at,
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

function nonEmpty(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
