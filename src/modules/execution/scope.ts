import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
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
const executionScopeContextObjectSchema = v.looseObject({
  neondeckExecutionScope: v.optional(v.unknown()),
});
const executionScopeContextSchema = v.pipe(
  v.unknown(),
  v.check(
    (value) =>
      !Array.isArray(value) && v.is(executionScopeContextObjectSchema, value),
    'Execution request context must be a non-array object.',
  ),
  v.transform((value) => v.parse(executionScopeContextObjectSchema, value)),
);

export async function authorizeExecutionScope<TContext>(
  userContext: TContext,
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

function mergeExecutionScope<TContext>(
  userContext: TContext,
  scope: ExecutionScope | null,
): JsonValue | undefined {
  const context =
    userContext === undefined ? undefined : sanitizeRequestContext(userContext);
  if (!scope) return context;
  const parsed = v.safeParse(executionScopeContextSchema, context);
  if (parsed.success) {
    return asJsonValue({ ...parsed.output, neondeckExecutionScope: scope });
  }
  if (context === undefined) return { neondeckExecutionScope: scope };
  return { requestContext: context, neondeckExecutionScope: scope };
}

function sanitizeRequestContext<TContext>(userContext: TContext): JsonValue {
  const context = asJsonValue(userContext);
  const parsed = v.safeParse(executionScopeContextSchema, context);
  if (!parsed.success) {
    return context;
  }
  const { neondeckExecutionScope: _reserved, ...rest } = parsed.output;
  return asJsonValue(rest);
}

export function executionScopeKey(scope: ExecutionScope | JsonValue | null) {
  if (!scope) return null;
  return JSON.stringify(scope);
}

export function approvalExecutionScopeKey(approval: ExecutionApprovalRecord) {
  const context = approval.requestContext;
  const parsed = v.safeParse(executionScopeContextSchema, context);
  return parsed.success && parsed.output.neondeckExecutionScope !== undefined
    ? executionScopeKey(asJsonValue(parsed.output.neondeckExecutionScope))
    : null;
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
