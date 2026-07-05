import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { disposeExeDevSessionEnv, exedev } from '../../sandboxes/exedev';
import {
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import { checkExecutionPolicy, type ExecutionPolicyCheck } from './policy';
import {
  resolveExeDevCheckoutTarget,
  resolveExeDevForwardedEnv,
  type ExeDevCheckoutTarget,
  type ExeDevForwardedEnv,
} from './exedev/context';
import { requestExecutionApproval } from './approvals';
import { authorizeExecutionScope, envSourceAuditMetadata } from './scope';
import {
  approvalMatches,
  findSessionApproval,
  insertApproval,
  markApprovalUsed,
  readApproval,
  updateApprovalResult,
} from './store';
import {
  commandError,
  executionResult,
  failedResult,
  hasShellOperator,
  safeExecutionEnv,
  splitCommand,
} from './utils';
import {
  defaultOutputBytes,
  defaultTimeoutMs,
  maxOutputBytes,
  maxTimeoutMs,
  runExecutionInputSchema,
  type ExecutionApprovalRecord,
  type ExecutionApprovalStatus,
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

  const input = parsed.output;
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

  if (policyCheck.backend === 'exe.dev') {
    return runExeDevExecution({
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

async function runExeDevExecution(input: {
  input: v.InferOutput<typeof runExecutionInputSchema>;
  policyCheck: ExecutionPolicyCheck;
  approvalId: string;
  paths: RuntimePaths;
}) {
  const config = await readRuntimeJson(input.paths.config, parseAppConfig);
  const exeDevConfig = config.execution?.exeDev ?? {};
  const lifecycle = exeDevConfig.lifecycle ?? 'existing-vm';
  if (lifecycle !== 'existing-vm') {
    const approval = updateApprovalResult(input.paths, input.approvalId, {
      status: 'failed',
      error: `exe.dev lifecycle "${lifecycle}" is configured but only existing-vm execution is implemented.`,
      executedAt: new Date().toISOString(),
      result: {
        backend: 'exe.dev',
        lifecycle,
        policyCheck: input.policyCheck,
      },
    });
    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message:
        'exe.dev execution is approved, but this lifecycle mode is not implemented yet. Configure execution.exeDev.lifecycle to existing-vm.',
      requires: ['execution.exeDev.lifecycle'],
      policyCheck: input.policyCheck,
      approval,
    };
  }

  const vmHostEnv = exeDevConfig.vmHostEnv ?? 'EXE_VM_HOST';
  const sshKeyEnv = exeDevConfig.sshKeyEnv ?? 'EXE_SSH_KEY';
  const host = process.env[vmHostEnv];
  if (!host) {
    const approval = updateApprovalResult(input.paths, input.approvalId, {
      status: 'failed',
      error: `exe.dev VM host environment variable ${vmHostEnv} is not set.`,
      executedAt: new Date().toISOString(),
      result: {
        backend: 'exe.dev',
        configured: false,
        vmHostEnv,
        policyCheck: input.policyCheck,
      },
    });
    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message: `exe.dev execution requires ${vmHostEnv} to point at an existing exe.dev VM host.`,
      requires: [vmHostEnv],
      policyCheck: input.policyCheck,
      approval,
    };
  }

  const privateKeyPath = process.env[sshKeyEnv];
  const outputLimit = Math.min(
    input.input.maxOutputBytes ?? defaultOutputBytes,
    maxOutputBytes,
  );
  const timeoutMs = Math.min(
    input.input.timeoutMs ?? defaultTimeoutMs,
    maxTimeoutMs,
  );
  const startedAt = Date.now();
  let dispose: (() => void) | undefined;
  let checkoutTarget: ExeDevCheckoutTarget | null = null;
  let forwardedEnv: ExeDevForwardedEnv = { env: {}, sources: [] };

  try {
    checkoutTarget = await resolveExeDevCheckoutTarget(
      {
        repoId: input.input.repoId,
        worktreeId: input.input.worktreeId,
      },
      input.paths,
    );
    if (input.input.forwardEnv !== false) {
      forwardedEnv = await resolveExeDevForwardedEnv(
        {
          repoId: input.input.repoId,
          worktreeId: input.input.worktreeId,
        },
        input.paths,
      );
    }
    const sandbox = exedev(host, {
      ...(privateKeyPath ? { privateKeyPath } : {}),
      ...(!privateKeyPath && process.env.SSH_AUTH_SOCK
        ? { agent: process.env.SSH_AUTH_SOCK }
        : {}),
      maxOutputBytes: outputLimit * 2,
    });
    const env = await sandbox.createSessionEnv({
      id: input.input.sessionId ?? input.approvalId,
    });
    dispose = () => disposeExeDevSessionEnv(env);
    const remoteResult = await env.exec(input.policyCheck.command, {
      cwd: input.input.cwd ?? checkoutTarget?.remotePath,
      env: forwardedEnv.env,
      timeoutMs,
    });
    const result = executionResult({
      stdout: remoteResult.stdout,
      stderr: remoteResult.stderr,
      exitCode: remoteResult.exitCode,
      durationMs: Date.now() - startedAt,
      outputLimit,
    });
    const status: ExecutionApprovalStatus =
      remoteResult.exitCode === 0 ? 'executed' : 'failed';
    const approval = updateApprovalResult(input.paths, input.approvalId, {
      status,
      exitCode: remoteResult.exitCode,
      stdoutPreview: result.stdout,
      stderrPreview: result.stderr,
      error:
        remoteResult.exitCode === 0
          ? null
          : `exe.dev command exited with code ${remoteResult.exitCode}.`,
      result: {
        ...result,
        backend: 'exe.dev',
        vmHostEnv,
        lifecycle,
        checkout: checkoutAuditMetadata(checkoutTarget),
        envSources: envSourceAuditMetadata(forwardedEnv.sources),
      },
      executedAt: new Date().toISOString(),
    });

    return {
      ok: remoteResult.exitCode === 0,
      action: 'execution_run',
      changed: true,
      message:
        remoteResult.exitCode === 0
          ? 'Executed exe.dev command.'
          : `exe.dev command exited with code ${remoteResult.exitCode}.`,
      policyCheck: input.policyCheck,
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
    const approval = updateApprovalResult(input.paths, input.approvalId, {
      status: 'failed',
      exitCode: details.exitCode,
      stdoutPreview: result.stdout,
      stderrPreview: result.stderr,
      error: details.message,
      result: {
        ...result,
        backend: 'exe.dev',
        vmHostEnv,
        lifecycle,
        checkout: checkoutAuditMetadata(checkoutTarget),
        envSources: envSourceAuditMetadata(forwardedEnv.sources),
      },
      executedAt: new Date().toISOString(),
    });

    return {
      ok: false,
      action: 'execution_run',
      changed: true,
      message: details.message,
      policyCheck: input.policyCheck,
      approval,
      result,
    };
  } finally {
    dispose?.();
  }
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
