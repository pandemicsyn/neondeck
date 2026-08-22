import { execFile } from 'node:child_process';
import { sshCommandUncertainty } from '../../sandboxes/exedev';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { currentFlueExecutionContext } from '../flue/execution-context';
import {
  physicalRemoteResourceKey,
  workspaceProviderFromSnapshot,
  isWorkspaceOperationUncertainError,
  WorkspaceOperationUncertainError,
  type WorkspaceConnection,
} from '../workspace-providers';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { lockWorktree, releaseWorktreeLock } from '../worktrees';
import {
  acquirePhysicalWorkspaceLease,
  acquireWorkspaceProviderCoordinator,
  quarantinePhysicalWorkspace,
  releasePhysicalWorkspaceLease,
  releaseWorkspaceProviderCoordinator,
  superviseWorkspaceProviderCoordinator,
} from '../scheduled-tasks/workspace-store';
import { checkExecutionPolicy, type ExecutionPolicyCheck } from './policy';
import {
  resolveExeDevCheckoutTarget,
  resolveExeDevForwardedEnv,
  type ExeDevCheckoutTarget,
  type ExeDevForwardedEnv,
} from './exedev/context';
import { requestExecutionApproval } from './approvals';
import {
  approvalExecutionScopeKey,
  approvedExecutionTargetIdentity,
  authorizeExecutionScope,
  envSourceAuditMetadata,
  executionScopeKey,
  resolveExecutionTarget,
} from './scope';
import {
  approvalMatches,
  findSessionApproval,
  insertApproval,
  markApprovalUsed,
  readApproval,
  recordApprovalTransportCloseError,
  updateApprovalResult,
} from './store';
import {
  commandError,
  executionResult,
  failedResult,
  hasShellOperator,
  safeExecutionEnv,
  sanitizeExecutionText,
  splitCommand,
} from './utils';
import {
  defaultOutputBytes,
  defaultTimeoutMs,
  maxOutputBytes,
  maxTimeoutMs,
  runExecutionInputSchema,
  type ExecutionApprovalRecord,
} from './schemas';

const execFileAsync = promisify(execFile);

export async function runApprovedExecution(
  rawInput: unknown,
  paths = runtimePaths(),
) {
  await ensureRuntimeHome(paths);
  const parsed = v.safeParse(runExecutionInputSchema, rawInput);
  if (!parsed.success) {
    return failedResult(
      'execution_run',
      `Invalid execution request: ${v.summarize(parsed.issues)}`,
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

  if (policyCheck.decision === 'deny') {
    const approval = insertApproval(paths, {
      command: policyCheck.command,
      backend: policyCheck.backend,
      cwd: input.cwd,
      context: policyCheck.context,
      risk: policyCheck.risk,
      policyDecision: policyCheck.decision,
      status: 'blocked',
      sessionId: input.sessionId,
      requestContext: input.requestContext,
      error: policyCheck.reason,
    });
    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message: policyCheck.reason,
      requires: policyCheck.requires ?? [],
      policyCheck,
      approval,
    };
  }

  const authorization = await authorizeExecution(input, policyCheck, paths);
  if (!authorization.ok) return authorization;

  if (policyCheck.backend !== 'local') {
    return runWorkspaceProviderExecution({
      input,
      policyCheck,
      approvalId: authorization.approval.id,
      paths,
    });
  }

  if (hasShellOperator(policyCheck.command)) {
    const approval = updateApprovalResult(paths, authorization.approval.id, {
      status: 'blocked',
      error:
        'Local executor only runs single commands through execFile; shell operators are not supported.',
      result: { policyCheck },
    });
    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message:
        'Local executor refused a command with shell operators. Run a single command or add a safer typed action.',
      requires: ['singleCommand'],
      policyCheck,
      approval,
    };
  }

  const command = splitCommand(policyCheck.command);
  if (!command.ok) {
    const approval = updateApprovalResult(paths, authorization.approval.id, {
      status: 'blocked',
      error: command.message,
      result: { policyCheck },
    });
    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message: command.message,
      requires: ['singleCommand'],
      policyCheck,
      approval,
    };
  }

  const cwd = input.cwd || process.cwd();
  if (!existsSync(cwd)) {
    const approval = updateApprovalResult(paths, authorization.approval.id, {
      status: 'blocked',
      error: `Working directory "${cwd}" does not exist.`,
      result: { policyCheck },
    });
    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message: `Working directory "${cwd}" does not exist.`,
      requires: ['cwd'],
      policyCheck,
      approval,
    };
  }

  const outputLimit = Math.min(
    input.maxOutputBytes ?? defaultOutputBytes,
    maxOutputBytes,
  );
  const timeoutMs = Math.min(input.timeoutMs ?? defaultTimeoutMs, maxTimeoutMs);
  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync(command.file, command.args, {
      cwd,
      env: safeExecutionEnv(),
      timeout: timeoutMs,
      maxBuffer: outputLimit * 2,
    });
    const result = executionResult({
      stdout,
      stderr,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      outputLimit,
    });
    const approval = updateApprovalResult(paths, authorization.approval.id, {
      status: 'executed',
      exitCode: 0,
      stdoutPreview: result.stdout,
      stderrPreview: result.stderr,
      result,
      executedAt: new Date().toISOString(),
    });

    return {
      ok: true,
      action: 'execution_run',
      changed: true,
      message: `Executed ${policyCheck.backend} command.`,
      policyCheck,
      approval,
      result,
    };
  } catch (error) {
    const details = commandError(error);
    const result = executionResult({
      stdout: details.stdout,
      stderr: details.stderr,
      exitCode: details.exitCode,
      durationMs: Date.now() - startedAt,
      outputLimit,
    });
    const approval = updateApprovalResult(paths, authorization.approval.id, {
      status: 'failed',
      exitCode: details.exitCode,
      stdoutPreview: result.stdout,
      stderrPreview: result.stderr,
      error: details.message,
      result,
      executedAt: new Date().toISOString(),
    });

    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message: details.message,
      policyCheck,
      approval,
      result,
    };
  }
}

async function runWorkspaceProviderExecution(input: {
  input: v.InferOutput<typeof runExecutionInputSchema>;
  policyCheck: ExecutionPolicyCheck;
  approvalId: string;
  paths: RuntimePaths;
}) {
  const outputLimit = Math.min(
    input.input.maxOutputBytes ?? defaultOutputBytes,
    maxOutputBytes,
  );
  const timeoutMs = Math.min(
    input.input.timeoutMs ?? defaultTimeoutMs,
    maxTimeoutMs,
  );
  const startedAt = Date.now();
  const leaseOwner = `approved-execution:${input.approvalId}`;
  const coordinatorOwner = `approved-provider:${input.approvalId}`;
  let connection: WorkspaceConnection | undefined;
  let physicalResourceKey: string | undefined;
  let physicalResourceQuarantined = false;
  let physicalLeaseMayRelease = true;
  let worktreeLockId: string | undefined;
  let coordinatorHeld = false;
  let coordinatorLease:
    ReturnType<typeof superviseWorkspaceProviderCoordinator> | undefined;
  let checkoutTarget: ExeDevCheckoutTarget | null = null;
  let forwardedEnv: ExeDevForwardedEnv = { env: {}, sources: [] };
  let missingEnvironment: string[] = [];
  try {
    coordinatorHeld = await acquireWorkspaceProviderCoordinator(
      coordinatorOwner,
      input.paths,
    );
    if (!coordinatorHeld) {
      throw new Error(
        'Workspace provider configuration is being updated. Retry execution shortly.',
      );
    }
    coordinatorLease = superviseWorkspaceProviderCoordinator(
      coordinatorOwner,
      input.paths,
    );
    coordinatorLease.assertLease();
    const resolvedTarget = await resolveExecutionTarget(
      input.input,
      input.policyCheck,
      input.paths,
    );
    if (!resolvedTarget) {
      throw new Error(
        'Remote approved execution did not resolve a workspace target.',
      );
    }
    coordinatorLease.assertLease();
    const providerSnapshot = resolvedTarget.providerSnapshot;
    const provider = workspaceProviderFromSnapshot(
      providerSnapshot,
      input.paths,
    );
    const currentApproval = readApproval(input.paths, input.approvalId);
    if (
      !currentApproval ||
      approvalExecutionScopeKey(currentApproval) !==
        executionScopeKey(resolvedTarget.scope)
    ) {
      throw new Error(
        'The approved provider configuration or physical workspace target changed. Request a new approval.',
      );
    }
    const readiness = await provider.readiness({ lifecycle: 'existing' });
    missingEnvironment = readiness.missingEnvironment;
    if (!readiness.ready) {
      throw new Error(readiness.message);
    }
    if (providerSnapshot.driver === 'exe.dev') {
      const remoteRoot =
        providerSnapshot.config.remoteRoot ?? '/home/user/neondeck/checkouts';
      checkoutTarget = await resolveExeDevCheckoutTarget(
        {
          repoId: input.input.repoId,
          worktreeId: input.input.worktreeId,
        },
        input.paths,
        { remoteRoot, useConfiguredRemotePath: false },
      );
      if (input.input.forwardEnv !== false) {
        forwardedEnv = await resolveExeDevForwardedEnv(
          {
            repoId: input.input.repoId,
            worktreeId: input.input.worktreeId,
          },
          input.paths,
          { remoteRoot, useConfiguredRemotePath: false },
        );
      }
    }
    if (checkoutTarget?.worktree) {
      const locked = await lockWorktree(
        {
          worktreeId: checkoutTarget.worktree.id,
          owner: leaseOwner,
          workflowRunId: input.approvalId,
          ttlSeconds: Math.ceil((timeoutMs + 60_000) / 1_000),
        },
        input.paths,
      );
      if (!locked.ok || !('lock' in locked)) {
        throw new Error(locked.message);
      }
      worktreeLockId = locked.lock.id;
    }
    const resource = resolvedTarget.resource;
    physicalResourceKey = physicalRemoteResourceKey(resource);
    if (
      !(await acquirePhysicalWorkspaceLease(
        {
          physicalResourceKey,
          providerId: providerSnapshot.providerId,
          owner: leaseOwner,
          ttlMs: timeoutMs + 60_000,
        },
        input.paths,
      ))
    ) {
      throw new Error(
        'The selected physical workspace is already active in another scheduled, approved, or Autopilot operation.',
      );
    }
    await releaseWorkspaceProviderCoordinator(coordinatorOwner, input.paths);
    coordinatorHeld = false;
    coordinatorLease.stop();
    coordinatorLease = undefined;
    connection = await provider.connect(resource);
    const shell = await connection.env.exec(input.policyCheck.command, {
      cwd: input.input.cwd ?? checkoutTarget?.remotePath ?? resource.root,
      timeoutMs,
      ...(providerSnapshot.driver === 'exe.dev'
        ? { env: forwardedEnv.env }
        : input.input.forwardEnv
          ? { env: definedEnvironment(safeExecutionEnv()) }
          : {}),
    });
    const uncertainty = sshCommandUncertainty(shell);
    if (uncertainty) {
      physicalLeaseMayRelease = false;
      try {
        await quarantinePhysicalWorkspace(
          {
            physicalResourceKey,
            providerId: providerSnapshot.providerId,
            source: 'approved-execution',
            sourceId: input.approvalId,
            reason: uncertainty.message,
          },
          input.paths,
        );
      } catch (quarantineError) {
        throw new AggregateError(
          [
            new WorkspaceOperationUncertainError(
              {
                kind: uncertainty.kind,
                operation: 'exec',
                message: uncertainty.message,
              },
              providerSnapshot.providerId,
            ),
            quarantineError,
          ],
          'Remote command outcome was uncertain and its durable quarantine could not be recorded; the physical lease was preserved for recovery.',
        );
      }
      physicalResourceQuarantined = true;
      physicalLeaseMayRelease = true;
    }
    const result = executionResult({
      stdout: shell.stdout,
      stderr: shell.stderr,
      exitCode: shell.exitCode,
      durationMs: Date.now() - startedAt,
      outputLimit,
    });
    const status = shell.exitCode === 0 && !uncertainty ? 'executed' : 'failed';
    const approval = updateApprovalResult(input.paths, input.approvalId, {
      status,
      exitCode: shell.exitCode,
      stdoutPreview: result.stdout,
      stderrPreview: result.stderr,
      ...(shell.exitCode === 0 && !uncertainty
        ? {}
        : {
            error: uncertainty
              ? `Remote command outcome is uncertain: ${uncertainty.message}`
              : `Command exited ${shell.exitCode}.`,
          }),
      result: {
        ...result,
        providerId: providerSnapshot.providerId,
        providerDriver: providerSnapshot.driver,
        physicalResourceKey,
        quarantined: Boolean(uncertainty),
        checkout: checkoutAuditMetadata(checkoutTarget),
        envSources: envSourceAuditMetadata(forwardedEnv.sources),
      },
      executedAt: new Date().toISOString(),
    });
    return {
      ok: shell.exitCode === 0 && !uncertainty,
      action: 'execution_run',
      changed: true,
      message:
        shell.exitCode === 0 && !uncertainty
          ? `Executed ${input.policyCheck.backend} command.`
          : uncertainty
            ? 'Remote command outcome is uncertain; the physical workspace is quarantined until operator clearance.'
            : `Command exited ${shell.exitCode}.`,
      policyCheck: input.policyCheck,
      approval,
      result,
    };
  } catch (error) {
    if (
      physicalResourceKey &&
      (isWorkspaceOperationUncertainError(error) ||
        (error instanceof DOMException && error.name === 'AbortError'))
    ) {
      physicalLeaseMayRelease = false;
      try {
        await quarantinePhysicalWorkspace(
          {
            physicalResourceKey,
            providerId: input.policyCheck.backend,
            source: 'approved-execution',
            sourceId: input.approvalId,
            reason:
              error instanceof Error
                ? error.message
                : 'Remote provider operation ended without confirmed settlement.',
          },
          input.paths,
        );
        physicalResourceQuarantined = true;
        physicalLeaseMayRelease = true;
      } catch (quarantineError) {
        throw new AggregateError(
          [error, quarantineError],
          'Remote operation was uncertain and its durable quarantine could not be recorded.',
        );
      }
    }
    const rawMessage =
      error instanceof Error
        ? error.message
        : 'Workspace provider execution failed.';
    const message = sanitizeExecutionText(rawMessage, 16 * 1024).content;
    const approval = updateApprovalResult(input.paths, input.approvalId, {
      status: 'failed',
      error: message,
      executedAt: new Date().toISOString(),
      result: {
        providerId: input.policyCheck.backend,
        physicalResourceKey: physicalResourceKey ?? null,
        quarantined: physicalResourceQuarantined,
        checkout: checkoutAuditMetadata(checkoutTarget),
        envSources: envSourceAuditMetadata(forwardedEnv.sources),
      },
    });
    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message,
      ...(missingEnvironment.length > 0
        ? { requires: missingEnvironment }
        : {}),
      policyCheck: input.policyCheck,
      approval,
    };
  } finally {
    if (connection)
      await closeWorkspaceExecutionConnection(
        connection,
        input.paths,
        input.approvalId,
      );
    if (physicalResourceKey && physicalLeaseMayRelease) {
      try {
        await releasePhysicalWorkspaceLease(
          { physicalResourceKey, owner: leaseOwner },
          input.paths,
        );
      } catch (error) {
        await recordExecutionCleanupError(
          input.paths,
          input.approvalId,
          'physical workspace lease release',
          error,
        );
      }
    }
    if (worktreeLockId) {
      try {
        const released = await releaseWorktreeLock(
          { lockId: worktreeLockId, owner: leaseOwner, finalStatus: 'ready' },
          input.paths,
        );
        if (!released.ok) {
          await recordExecutionCleanupError(
            input.paths,
            input.approvalId,
            'local worktree lock release',
            new Error(released.message),
          );
        }
      } catch (error) {
        await recordExecutionCleanupError(
          input.paths,
          input.approvalId,
          'local worktree lock release',
          error,
        );
      }
    }
    if (coordinatorHeld) {
      coordinatorLease?.stop();
      try {
        await releaseWorkspaceProviderCoordinator(
          coordinatorOwner,
          input.paths,
        );
      } catch (error) {
        await recordExecutionCleanupError(
          input.paths,
          input.approvalId,
          'provider coordinator release',
          error,
        );
      }
    }
  }
}

export function approvedExecutionResourceIdentity(
  driver: 'exe.dev' | 'ssh',
  selectedRoot: string | undefined,
) {
  return approvedExecutionTargetIdentity(driver, selectedRoot ?? null).replace(
    /^approved-/,
    '',
  );
}

async function recordExecutionCleanupError(
  paths: RuntimePaths,
  approvalId: string,
  operation: string,
  error: unknown,
) {
  const message = sanitizeExecutionText(
    `${operation} failed after command settlement: ${
      error instanceof Error ? error.message : String(error)
    }`,
    16 * 1024,
  ).content;
  console.warn(`[neondeck] ${message}`);
  try {
    recordApprovalTransportCloseError(paths, approvalId, message);
  } catch (auditError) {
    console.warn(
      `[neondeck] failed to persist execution cleanup error: ${
        sanitizeExecutionText(
          auditError instanceof Error ? auditError.message : String(auditError),
          16 * 1024,
        ).content
      }`,
    );
  }
}

export async function closeWorkspaceExecutionConnection(
  connection: WorkspaceConnection,
  paths: RuntimePaths,
  approvalId: string,
) {
  try {
    await connection.close();
  } catch (error) {
    const message = sanitizeExecutionText(
      error instanceof Error
        ? error.message
        : 'Workspace provider transport close failed.',
      16 * 1024,
    ).content;
    console.warn(
      '[neondeck] completed provider execution but failed to close its transport',
      message,
    );
    try {
      recordApprovalTransportCloseError(paths, approvalId, message);
    } catch (auditError) {
      console.warn(
        `[neondeck] failed to persist provider transport close error: ${
          sanitizeExecutionText(
            auditError instanceof Error
              ? auditError.message
              : String(auditError),
            16 * 1024,
          ).content
        }`,
      );
    }
  }
}

function definedEnvironment(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function checkoutAuditMetadata(target: ExeDevCheckoutTarget | null) {
  if (!target) return null;
  return {
    repoId: target.repo.id,
    repoFullName: target.repoFullName,
    worktreeId: target.worktree?.id ?? null,
    remotePath: target.remotePath,
    remoteRoot: target.remoteRoot,
    defaultRef: target.defaultRef,
  };
}

async function authorizeExecution(
  input: v.InferOutput<typeof runExecutionInputSchema>,
  policyCheck: ExecutionPolicyCheck,
  paths: RuntimePaths,
): Promise<
  | { ok: true; approval: ExecutionApprovalRecord }
  | {
      ok: false;
      action: 'execution_run';
      changed: boolean;
      message: string;
      requires: string[];
      policyCheck: ExecutionPolicyCheck;
      approval?: ExecutionApprovalRecord;
    }
> {
  const requestContextResult = await authorizeExecutionScope(
    input.requestContext,
    input,
    policyCheck,
    paths,
    'execution_run',
  );
  if (!requestContextResult.ok) {
    return {
      ok: false,
      action: 'execution_run',
      changed: false,
      message: requestContextResult.result.message,
      requires: requestContextResult.result.requires,
      policyCheck,
    };
  }
  const requestContext = requestContextResult.requestContext;
  const expectedScope = requestContextResult.scope;

  if (policyCheck.decision === 'allow') {
    return {
      ok: true,
      approval: insertApproval(paths, {
        command: policyCheck.command,
        backend: policyCheck.backend,
        cwd: input.cwd,
        context: policyCheck.context,
        risk: policyCheck.risk,
        policyDecision: policyCheck.decision,
        status: 'approved',
        approvalDecision: 'preapproved',
        approverSurface: 'policy',
        sessionId: input.sessionId,
        requestContext,
      }),
    };
  }

  const approved = input.approvalId
    ? readApproval(paths, input.approvalId)
    : findSessionApproval(paths, policyCheck, input, expectedScope);
  if (
    approved &&
    approvalMatches(approved, policyCheck, input.cwd, expectedScope)
  ) {
    if (approved.status !== 'approved') {
      return {
        ok: false,
        action: 'execution_run',
        changed: false,
        message: `Execution approval "${approved.id}" is ${approved.status}.`,
        requires: ['approval'],
        policyCheck,
        approval: approved,
      };
    }

    if (approved.approvalDecision === 'allow-session') {
      markApprovalUsed(paths, approved.id, { allowAlreadyUsed: true });
      return {
        ok: true,
        approval: insertApproval(paths, {
          command: policyCheck.command,
          backend: policyCheck.backend,
          cwd: input.cwd,
          context: policyCheck.context,
          risk: policyCheck.risk,
          policyDecision: policyCheck.decision,
          status: 'approved',
          approvalDecision: 'allow-session',
          approverSurface: `session:${approved.id}`,
          sessionId: input.sessionId,
          requestContext,
        }),
      };
    }

    const claimed = markApprovalUsed(paths, approved.id, {
      allowAlreadyUsed: false,
    });
    if (!claimed) {
      return {
        ok: false,
        action: 'execution_run',
        changed: false,
        message: `Execution approval "${approved.id}" was already used.`,
        requires: ['approval'],
        policyCheck,
        approval: approved,
      };
    }
    return { ok: true, approval: claimed };
  }
  if (input.approvalId && approved) {
    return {
      ok: false,
      action: 'execution_run',
      changed: false,
      message: `Execution approval "${approved.id}" does not match the requested command scope.`,
      requires: ['approval'],
      policyCheck,
      approval: approved,
    };
  }

  const request = await requestExecutionApproval(
    {
      command: policyCheck.command,
      backend: policyCheck.backend,
      cwd: input.cwd,
      context: policyCheck.context,
      sessionId: input.sessionId,
      repoId: input.repoId,
      worktreeId: input.worktreeId,
      forwardEnv: input.forwardEnv,
      requestContext,
    },
    paths,
  );
  return {
    ok: false,
    action: 'execution_run',
    changed: request.changed,
    message: 'Execution requires user approval before running.',
    requires: ['approval'],
    policyCheck,
    approval: 'approval' in request ? request.approval : undefined,
  };
}
