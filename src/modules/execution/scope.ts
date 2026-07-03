import { type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import type { RuntimePaths } from '../../runtime-home';
import {
  resolveExeDevCheckoutTarget,
  resolveExeDevForwardedEnv,
  type ExeDevEnvSourceAudit,
} from './exedev/context';
import type { ExecutionPolicyCheck } from './policy';
import { failedResult } from './utils';
import type { ExecutionApprovalRecord } from './schemas';

export type ScopedExecutionInput = {
  repoId?: string;
  worktreeId?: string;
  forwardEnv?: boolean;
};

export type ExecutionScope = {
  backend: 'exe.dev';
  repoId: string;
  repoFullName: string;
  worktreeId: string | null;
  remotePath: string;
  forwardEnv: boolean;
  envSources: ReturnType<typeof envSourceAuditMetadata>;
};

export async function authorizeExecutionScope(
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

export function executionScopeKey(scope: ExecutionScope | JsonValue | null) {
  if (!scope) return null;
  return JSON.stringify(scope);
}

export function approvalExecutionScopeKey(approval: ExecutionApprovalRecord) {
  const context = approval.requestContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return null;
  }
  const scope = (context as Record<string, JsonValue>).neondeckExecutionScope;
  return scope === undefined ? null : executionScopeKey(scope);
}

export function envSourceAuditMetadata(sources: ExeDevEnvSourceAudit[]) {
  return sources.map((source) => ({
    kind: source.kind,
    scope: source.scope,
    id: source.id,
    keys: source.keys,
    missing: source.missing ?? false,
  }));
}
