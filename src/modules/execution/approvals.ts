import { openDb } from '../../lib/sqlite';
import { updateExecutionPolicy } from '../config';
import { randomUUID } from 'node:crypto';
import { currentFlueExecutionContext } from '../flue/execution-context';
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
  claimPendingApprovalResolution,
  completePendingApprovalResolution,
  insertApproval,
  readExecutionApprovalRow,
  releasePendingApprovalResolution,
} from './store';
import { createApprovalResolutionNudge } from '../sessions';
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

  const input = {
    ...parsed.output,
    sessionId:
      nonEmpty(parsed.output.sessionId) ??
      currentFlueExecutionContext()?.instanceId,
  };
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
  const claim = claimPendingApprovalResolution(paths, input.id, randomUUID());
  const existing = claim.approval;
  if (!existing) {
    return failedResult(
      'execution_resolve_approval',
      `Execution approval "${input.id}" was not found.`,
      ['id'],
    );
  }

  if (!claim.claimed) {
    return {
      ok: false,
      action: 'execution_resolve_approval',
      changed: false,
      message:
        existing.status === 'pending'
          ? `Execution approval "${input.id}" is already being resolved.`
          : `Execution approval "${input.id}" is already ${existing.status}.`,
      approval: existing,
    };
  }

  try {
    if (input.decision === 'allow-always') {
      const preapproval = await addAlwaysPreapproval(existing, paths);
      if (!preapproval.ok) return preapproval;
    }

    const now = new Date().toISOString();
    const nextStatus: ExecutionApprovalStatus =
      input.decision === 'deny' ? 'denied' : 'approved';
    const result =
      input.note === undefined ? existing.result : { note: input.note };
    const completed = completePendingApprovalResolution(paths, {
      id: existing.id,
      claimedSurface: claim.claimedSurface,
      status: nextStatus,
      decision: input.decision,
      approverSurface: input.approverSurface ?? 'api',
      result,
      resolvedAt: now,
    });
    if (!completed.changed || !completed.approval) {
      return {
        ok: false,
        action: 'execution_resolve_approval',
        changed: false,
        message: `Execution approval "${input.id}" changed while it was being resolved.`,
        approval: completed.approval ?? existing,
      };
    }

    const approval = completed.approval;
    let nudgeErrors: string[] = [];
    const nudge = await createApprovalResolutionNudge(
      {
        family: 'execution',
        sessionId: approval.sessionId,
        approvalId: approval.id,
        decision: nextStatus === 'approved' ? 'approved' : 'denied',
        subject: approval.command,
        retryInstruction: `Retry the command with approvalId ${approval.id}.`,
      },
      paths,
    );
    if (!nudge.ok) nudgeErrors = nudge.errors;
    return {
      ok: true,
      action: 'execution_resolve_approval',
      changed: true,
      message:
        input.decision === 'deny'
          ? 'Denied execution approval.'
          : `Approved execution ${input.decision.replace('-', ' ')}.`,
      approval,
      ...(nudgeErrors.length > 0
        ? { requires: ['approvalNudge'], errors: nudgeErrors }
        : {}),
    };
  } finally {
    releasePendingApprovalResolution(paths, existing.id, claim.claimedSurface);
  }
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
