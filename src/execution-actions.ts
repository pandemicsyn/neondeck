import { defineAction, type JsonValue } from '@flue/runtime';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { updateExecutionPolicy } from './config-actions';
import {
  checkExecutionPolicy,
  type ExecutionContext,
  type ExecutionDecision,
  type ExecutionPolicyCheck,
  type ExecutionRisk,
} from './execution-policy';
import {
  resolveExeDevCheckoutTarget,
  resolveExeDevForwardedEnv,
  type ExeDevEnvSourceAudit,
  type ExeDevForwardedEnv,
  type ExeDevCheckoutTarget,
  exedevTargetInputSchema,
} from './exedev-context';
import {
  ensureRuntimeHome,
  type ExecutionBackend,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
  type RuntimePaths,
} from './runtime-home';
import { disposeExeDevSessionEnv, exedev } from './sandboxes/exedev';

export type ExecutionApprovalStatus =
  'pending' | 'approved' | 'denied' | 'executed' | 'failed' | 'blocked';
export type ExecutionApprovalDecision =
  'preapproved' | 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

export type ExecutionApprovalRecord = {
  id: string;
  command: string;
  backend: ExecutionBackend;
  cwd: string | null;
  context: ExecutionContext;
  risk: ExecutionRisk;
  policyDecision: ExecutionDecision;
  status: ExecutionApprovalStatus;
  approvalDecision: ExecutionApprovalDecision | null;
  approverSurface: string | null;
  sessionId: string | null;
  requestContext: JsonValue | null;
  result: JsonValue | null;
  exitCode: number | null;
  stdoutPreview: string | null;
  stderrPreview: string | null;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
  executedAt: string | null;
  updatedAt: string;
};

const execFileAsync = promisify(execFile);
const maxCommandLength = 4096;
const defaultTimeoutMs = 30_000;
const maxTimeoutMs = 10 * 60_000;
const defaultOutputBytes = 64 * 1024;
const maxOutputBytes = 256 * 1024;
const safeEnvKeys = [
  'PATH',
  'HOME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'NEONDECK_HOME',
];

const backendSchema = v.picklist(['local', 'exe.dev']);
const contextSchema = v.picklist(['interactive', 'unattended']);
const approvalDecisionSchema = v.picklist([
  'allow-once',
  'allow-session',
  'allow-always',
  'deny',
]);
const executionCommandSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(maxCommandLength),
);
const requestApprovalInputSchema = v.object({
  command: executionCommandSchema,
  backend: v.optional(backendSchema),
  cwd: v.optional(v.string()),
  ...exedevTargetInputSchema(),
  forwardEnv: v.optional(v.boolean()),
  context: v.optional(contextSchema),
  sessionId: v.optional(v.string()),
  requestContext: v.optional(
    v.pipe(v.unknown(), v.check(isJsonValue, 'Context must be JSON-safe.')),
  ),
});
const resolveApprovalInputSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  decision: approvalDecisionSchema,
  approverSurface: v.optional(v.pipe(v.string(), v.minLength(1))),
  note: v.optional(v.string()),
});
const runExecutionInputSchema = v.object({
  command: executionCommandSchema,
  backend: v.optional(backendSchema),
  cwd: v.optional(v.string()),
  ...exedevTargetInputSchema(),
  forwardEnv: v.optional(v.boolean()),
  context: v.optional(contextSchema),
  approvalId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxOutputBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  requestContext: v.optional(
    v.pipe(v.unknown(), v.check(isJsonValue, 'Context must be JSON-safe.')),
  ),
});
const executionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});

export const executionRequestApprovalAction = defineAction({
  name: 'neondeck_execution_request_approval',
  description:
    'Create a pending approval request for a non-preapproved local or exe.dev command without running it.',
  input: requestApprovalInputSchema,
  output: executionOutputSchema,
  async run({ input }) {
    return requestExecutionApproval(input);
  },
});

export const executionRunAction = defineAction({
  name: 'neondeck_execution_run',
  description:
    'Run one approved local or exe.dev command through the Neondeck execution approval policy and audit log.',
  input: runExecutionInputSchema,
  output: executionOutputSchema,
  async run({ input }) {
    return runApprovedExecution(input);
  },
});

export const neondeckExecutionActions = [
  executionRequestApprovalAction,
  executionRunAction,
];

export async function listExecutionApprovals(
  paths = runtimePaths(),
  options: { includeResolved?: boolean } = {},
) {
  await ensureRuntimeHome(paths);
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

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
  const requestContextResult = await scopedRequestContext(
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
  const database = new DatabaseSync(paths.neondeckDatabase);

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

function envSourceAuditMetadata(sources: ExeDevEnvSourceAudit[]) {
  return sources.map((source) => ({
    kind: source.kind,
    scope: source.scope,
    id: source.id,
    keys: source.keys,
    missing: source.missing ?? false,
  }));
}

type ScopedExecutionInput = {
  repoId?: string;
  worktreeId?: string;
  forwardEnv?: boolean;
};

type ExecutionScope = {
  backend: 'exe.dev';
  repoId: string;
  repoFullName: string;
  worktreeId: string | null;
  remotePath: string;
  forwardEnv: boolean;
  envSources: ReturnType<typeof envSourceAuditMetadata>;
};

async function scopedRequestContext(
  userContext: unknown,
  input: ScopedExecutionInput,
  policyCheck: ExecutionPolicyCheck,
  paths: RuntimePaths,
  action = 'execution_request_context',
): Promise<
  | {
      ok: true;
      requestContext: JsonValue | undefined;
      scope: ExecutionScope | null;
    }
  | { ok: false; result: ReturnType<typeof failedResult> }
> {
  try {
    const scope = await resolveExecutionScope(input, policyCheck, paths);
    return {
      ok: true,
      requestContext: mergeExecutionScope(userContext, scope),
      scope,
    };
  } catch (error) {
    return {
      ok: false,
      result: failedResult(
        action,
        error instanceof Error ? error.message : String(error),
        ['repoId', 'worktreeId'],
      ),
    };
  }
}

async function resolveExecutionScope(
  input: ScopedExecutionInput,
  policyCheck: ExecutionPolicyCheck,
  paths: RuntimePaths,
): Promise<ExecutionScope | null> {
  if (policyCheck.backend !== 'exe.dev') return null;
  if (!input.repoId && !input.worktreeId) return null;
  const target = await resolveExeDevCheckoutTarget(input, paths);
  if (!target) return null;
  const forwardEnv = input.forwardEnv !== false;
  const envSources = forwardEnv
    ? envSourceAuditMetadata(
        (await resolveExeDevForwardedEnv(input, paths)).sources,
      )
    : [];

  return {
    backend: 'exe.dev',
    repoId: target.repo.id,
    repoFullName: target.repoFullName,
    worktreeId: target.worktree?.id ?? null,
    remotePath: target.remotePath,
    forwardEnv,
    envSources,
  };
}

function mergeExecutionScope(
  userContext: unknown,
  scope: ExecutionScope | null,
): JsonValue | undefined {
  const context =
    userContext === undefined ? undefined : sanitizeRequestContext(userContext);
  if (!scope) return context;
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    return { ...context, neondeckExecutionScope: scope };
  }
  if (context === undefined) return { neondeckExecutionScope: scope };
  return { requestContext: context, neondeckExecutionScope: scope };
}

function sanitizeRequestContext(userContext: unknown): JsonValue {
  const context = asJsonValue(userContext);
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return context;
  }
  const { neondeckExecutionScope: _reserved, ...rest } = context as Record<
    string,
    JsonValue
  >;
  return rest;
}

function executionScopeKey(scope: ExecutionScope | JsonValue | null) {
  if (!scope) return null;
  return JSON.stringify(scope);
}

function approvalExecutionScopeKey(approval: ExecutionApprovalRecord) {
  const context = approval.requestContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }
  const scope = (context as Record<string, JsonValue>).neondeckExecutionScope;
  return scope === undefined ? null : executionScopeKey(scope);
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
  const requestContextResult = await scopedRequestContext(
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

    return { ok: true, approval: approved };
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

function insertApproval(
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
  const database = new DatabaseSync(paths.neondeckDatabase);

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

function readApproval(paths: RuntimePaths, id: string) {
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

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

function findSessionApproval(
  paths: RuntimePaths,
  policyCheck: ExecutionPolicyCheck,
  input: v.InferOutput<typeof runExecutionInputSchema>,
  expectedScope: ExecutionScope | null,
) {
  if (!input.sessionId) return undefined;
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

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

function updateApprovalResult(
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
  const database = new DatabaseSync(paths.neondeckDatabase);

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

function readExecutionApprovalRow(row: unknown): ExecutionApprovalRecord {
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
    executedAt:
      typeof record.executed_at === 'string' ? record.executed_at : null,
    updatedAt: String(record.updated_at),
  };
}

function approvalMatches(
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

function splitCommand(
  input: string,
): { ok: true; file: string; args: string[] } | { ok: false; message: string } {
  const parts = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const parsed = parts.map((part) =>
    (part.startsWith('"') && part.endsWith('"')) ||
    (part.startsWith("'") && part.endsWith("'"))
      ? part.slice(1, -1)
      : part,
  );
  const [file, ...args] = parsed;
  if (!file) return { ok: false, message: 'A command executable is required.' };
  return { ok: true, file, args };
}

function hasShellOperator(value: string) {
  return /(?:\n|&&|\|\||[;&|<>`]|\$\()/.test(value);
}

function safeExecutionEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of safeEnvKeys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function executionResult(input: {
  stdout: unknown;
  stderr: unknown;
  exitCode: number | null;
  durationMs: number;
  outputLimit: number;
}) {
  const stdout = truncateOutput(String(input.stdout ?? ''), input.outputLimit);
  const stderr = truncateOutput(String(input.stderr ?? ''), input.outputLimit);
  return {
    exitCode: input.exitCode,
    stdout,
    stderr,
    stdoutTruncated: stdout.length < String(input.stdout ?? '').length,
    stderrTruncated: stderr.length < String(input.stderr ?? '').length,
    durationMs: input.durationMs,
  };
}

function truncateOutput(value: string, limit: number) {
  if (value.length <= limit) return redactOutput(value);
  return redactOutput(value.slice(0, limit));
}

function redactOutput(value: string) {
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[redacted-github-token]')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[redacted-api-key]')
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted-token]');
}

function commandError(error: unknown) {
  const record =
    error && typeof error === 'object'
      ? (error as Record<string, unknown>)
      : {};
  const code = record.code;
  const signal = record.signal;
  const exitCode = typeof code === 'number' ? code : null;
  const message =
    error instanceof Error
      ? error.message
      : `Command failed${signal ? ` with signal ${String(signal)}` : ''}.`;
  return {
    message,
    exitCode,
    stdout: record.stdout ?? '',
    stderr: record.stderr ?? '',
  };
}

function failedResult(action: string, message: string, requires: string[]) {
  return {
    ok: false,
    action,
    changed: false,
    message,
    requires,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
