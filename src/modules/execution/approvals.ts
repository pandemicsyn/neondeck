import { asJsonValue } from '../../lib/action-result';
import { openDb } from '../../lib/sqlite';
import { updateExecutionPolicy } from '../config';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { checkExecutionPolicy } from './policy';
import { failedResult, hasShellOperator } from './utils';
import { authorizeExecutionScope, approvalExecutionScopeKey } from './scope';
import {
  insertApproval,
  readApproval,
  readExecutionApprovalRow,
} from './store';
import {
  requestApprovalInputSchema,
  resolveApprovalInputSchema,
  type ExecutionApprovalRecord,
  type ExecutionApprovalStatus,
} from './schemas';
import * as v from 'valibot';

export async function listExecutionApprovals(
  paths = runtimePaths(),
  options: { includeResolved?: boolean } = {},
) {
  await ensureRuntimeHome(paths);
  const database = openDb(paths.neondeckDatabase, { readOnly: true });

  try {
    return {
      ok: true,
      action: 'execution_approvals_list',
      changed: false,
      approvals: database
        .prepare(
          `
          SELECT *
          FROM execution_approvals
          ${options.includeResolved ? '' : "WHERE status = 'pending'"}
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 100;
        `,
        )
        .all()
        .map(readExecutionApprovalRow),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    database.close();
  }
}

export async function requestExecutionApproval(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(requestApprovalInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult(
      'execution_request_approval',
      `Invalid execution approval request: ${v.summarize(parsed.issues)}`,
      ['command'],
    );
  }

  const input = parsed.output;
  const policyCheck = await checkExecutionPolicy(
    {
      command: input.command,
      backend: input.backend,
      context: input.context ?? 'interactive',
    },
    paths,
  );
  const requestContextResult = await authorizeExecutionScope(
    input.requestContext,
    input,
    policyCheck,
    paths,
  );
  if (!requestContextResult.ok) return requestContextResult.result;

  if (policyCheck.decision === 'deny') {
    const record = insertApproval(paths, {
      command: policyCheck.command,
      backend: policyCheck.backend,
      cwd: input.cwd,
      context: policyCheck.context,
      risk: policyCheck.risk,
      policyDecision: policyCheck.decision,
      status: 'blocked',
      sessionId: input.sessionId,
      requestContext: requestContextResult.requestContext,
      error: policyCheck.reason,
    });
    return {
      ok: false,
      action: 'execution_request_approval',
      changed: true,
      message: policyCheck.reason,
      requires: policyCheck.requires ?? [],
      policyCheck,
      approval: record,
    };
  }

  if (policyCheck.decision === 'allow') {
    return {
      ok: true,
      action: 'execution_request_approval',
      changed: false,
      message:
        'Command is already preapproved by execution policy; no pending approval was created.',
      policyCheck,
    };
  }

  const record = insertApproval(paths, {
    command: policyCheck.command,
    backend: policyCheck.backend,
    cwd: input.cwd,
    context: policyCheck.context,
    risk: policyCheck.risk,
    policyDecision: policyCheck.decision,
    status: 'pending',
    sessionId: input.sessionId,
    requestContext: requestContextResult.requestContext,
  });
  return {
    ok: true,
    action: 'execution_request_approval',
    changed: true,
    message: `Created pending approval for ${record.backend} command.`,
    policyCheck,
    approval: record,
  };
}

export async function resolveExecutionApproval(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(resolveApprovalInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult(
      'execution_resolve_approval',
      `Invalid approval resolution: ${v.summarize(parsed.issues)}`,
      ['id', 'decision'],
    );
  }

  const input = parsed.output;
  const existing = readApproval(paths, input.id);
  if (!existing) {
    return failedResult(
      'execution_resolve_approval',
      `Execution approval "${input.id}" was not found.`,
      ['id'],
    );
  }

  if (existing.status !== 'pending') {
    return {
      ok: false,
      action: 'execution_resolve_approval',
      changed: false,
      message: `Execution approval "${input.id}" is already ${existing.status}.`,
      approval: existing,
    };
  }

  if (input.decision === 'allow-always') {
    const preapproval = await addAlwaysPreapproval(existing, paths);
    if (!preapproval.ok) return preapproval;
  }

  const now = new Date().toISOString();
  const nextStatus: ExecutionApprovalStatus =
    input.decision === 'deny' ? 'denied' : 'approved';
  const result =
    input.note === undefined ? existing.result : { note: input.note };
  const database = openDb(paths.neondeckDatabase);

  try {
    database
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
        WHERE id = ?;
      `,
      )
      .run(
        nextStatus,
        input.decision,
        input.approverSurface ?? 'api',
        result === null ? null : JSON.stringify(asJsonValue(result)),
        now,
        now,
        existing.id,
      );
  } finally {
    database.close();
  }

  const approval = readApproval(paths, existing.id);
  return {
    ok: true,
    action: 'execution_resolve_approval',
    changed: true,
    message:
      input.decision === 'deny'
        ? 'Denied execution approval.'
        : `Approved execution ${input.decision.replace('-', ' ')}.`,
    approval,
  };
}

async function addAlwaysPreapproval(
  approval: ExecutionApprovalRecord,
  paths: RuntimePaths,
) {
  if (approvalExecutionScopeKey(approval) !== null) {
    return failedResult(
      'execution_resolve_approval',
      'Scoped exe.dev repo/worktree execution approvals cannot be promoted into global command preapprovals. Update execution policy explicitly if that broader trust boundary is intended.',
      ['preapprovedCommands'],
    );
  }

  if (hasShellOperator(approval.command)) {
    return failedResult(
      'execution_resolve_approval',
      'Commands with shell operators cannot be added to preapproved policy.',
      ['singleCommand'],
    );
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const existing = config.execution?.preapprovedCommands ?? [];
  if (
    existing.some(
      (item) =>
        item.command === approval.command &&
        (item.backends ?? ['local']).includes(approval.backend),
    )
  ) {
    return { ok: true as const };
  }

  const id = `approved-${approval.backend.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}`;
  const result = await updateExecutionPolicy(
    {
      preapprovedCommands: [
        ...existing,
        {
          id,
          command: approval.command,
          match: 'exact',
          backends: [approval.backend],
          description: `Approved from execution request ${approval.id}.`,
        },
      ],
    },
    paths,
  );
  if (!result.ok) {
    return {
      ok: false as const,
      action: 'execution_resolve_approval',
      changed: false,
      message: result.message,
      requires: result.requires ?? ['preapprovedCommands'],
      errors: result.errors,
    };
  }

  return { ok: true as const };
}
