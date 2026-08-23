import { type JsonValue } from '@flue/runtime';
import { asJsonValue } from '../../lib/action-result';
import type { RuntimePaths } from '../../runtime-home';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  captureWorkspaceProviderSnapshot,
  physicalRemoteResourceKey,
  workspaceProviderFromSnapshot,
  workspaceProviderSnapshotFingerprint,
  type WorkspaceProviderSnapshot,
  type WorkspaceResource,
} from '../workspace-providers';
import {
  resolveExeDevCheckoutTarget,
  resolveExeDevForwardedEnv,
  type ExeDevEnvSourceAudit,
} from './exedev/context';
import type { ExecutionPolicyCheck } from './policy';
import { failedResult } from './utils';
import type { ExecutionApprovalRecord } from './schemas';

export type ScopedExecutionInput = {
  cwd?: string;
  repoId?: string;
  worktreeId?: string;
  forwardEnv?: boolean;
};

export type ExecutionScope = {
  backend: string;
  providerDriver: 'exe.dev' | 'ssh';
  providerSnapshotFingerprint: string;
  providerConnectionFingerprint: string;
  physicalResourceKey: string;
  resourceRoot: string;
  repoId: string | null;
  repoFullName: string | null;
  worktreeId: string | null;
  remotePath: string | null;
  forwardEnv: boolean;
  envSources: ReturnType<typeof envSourceAuditMetadata>;
  forwardedEnvironmentFingerprint: string | null;
};

export type ResolvedExecutionTarget = {
  scope: ExecutionScope;
  providerSnapshot: Exclude<WorkspaceProviderSnapshot, { driver: 'local' }>;
  resource: WorkspaceResource;
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
    const requires =
      error instanceof ExecutionScopeResolutionError
        ? error.requires
        : ['repoId', 'worktreeId'];
    return {
      ok: false,
      result: failedResult(
        action,
        error instanceof Error ? error.message : String(error),
        requires,
      ),
    };
  }
}

export async function resolveExecutionTarget(
  input: ScopedExecutionInput,
  policyCheck: ExecutionPolicyCheck,
  paths: RuntimePaths,
): Promise<ResolvedExecutionTarget | null> {
  if (policyCheck.backend === 'local') return null;
  const providerSnapshot = captureWorkspaceProviderSnapshot(
    policyCheck.backend,
    paths,
  );
  if (providerSnapshot.driver === 'local') return null;
  const provider = workspaceProviderFromSnapshot(providerSnapshot, paths);
  const readiness = await provider.readiness({ lifecycle: 'existing' });
  if (!readiness.ready) {
    throw new ExecutionScopeResolutionError(
      readiness.message,
      readiness.missingEnvironment,
    );
  }
  const target =
    providerSnapshot.driver === 'exe.dev' && (input.repoId || input.worktreeId)
      ? await resolveExeDevCheckoutTarget(input, paths, {
          remoteRoot:
            providerSnapshot.config.remoteRoot ??
            '/home/user/neondeck/checkouts',
          useConfiguredRemotePath: false,
        })
      : null;
  const forwardEnv = input.forwardEnv !== false;
  const forwardedEnvironment =
    forwardEnv && target
      ? await resolveExeDevForwardedEnv(input, paths, {
          remoteRoot: target.remoteRoot,
          useConfiguredRemotePath: false,
        })
      : null;
  const envSources = envSourceAuditMetadata(
    forwardedEnvironment?.sources ?? [],
  );
  const selectedRoot = input.cwd ?? target?.remotePath ?? null;
  const homeIdentity = approvedExecutionTargetIdentity(
    providerSnapshot.providerId,
    selectedRoot,
  );
  const resource = await provider.attach({
    externalId: 'configured',
    ...(selectedRoot ? { root: selectedRoot } : {}),
    allowProviderRoot: selectedRoot === null,
    privateHomeIdentity: homeIdentity,
  });
  const scope: ExecutionScope = {
    backend: policyCheck.backend,
    providerDriver: providerSnapshot.driver,
    providerSnapshotFingerprint:
      workspaceProviderSnapshotFingerprint(providerSnapshot),
    providerConnectionFingerprint:
      await workspaceProviderConnectionFingerprint(providerSnapshot),
    physicalResourceKey: physicalRemoteResourceKey(resource),
    resourceRoot: resource.root,
    repoId: target?.repo.id ?? null,
    repoFullName: target?.repoFullName ?? null,
    worktreeId: target?.worktree?.id ?? null,
    remotePath: target?.remotePath ?? null,
    forwardEnv,
    envSources,
    forwardedEnvironmentFingerprint: forwardedEnvironment
      ? createHash('sha256')
          .update(
            JSON.stringify(
              Object.entries(forwardedEnvironment.env).sort(([left], [right]) =>
                left.localeCompare(right),
              ),
            ),
          )
          .digest('hex')
      : null,
  };
  return { scope, providerSnapshot, resource };
}

class ExecutionScopeResolutionError extends Error {
  constructor(
    message: string,
    readonly requires: string[],
  ) {
    super(message);
  }
}

async function workspaceProviderConnectionFingerprint(
  snapshot: Exclude<WorkspaceProviderSnapshot, { driver: 'local' }>,
) {
  const hostEnv =
    snapshot.driver === 'exe.dev'
      ? (snapshot.config.vmHostEnv ?? 'EXE_VM_HOST')
      : snapshot.config.hostEnv;
  const privateKeyEnv =
    snapshot.driver === 'exe.dev'
      ? (snapshot.config.sshKeyEnv ?? 'EXE_SSH_KEY')
      : snapshot.config.privateKeyEnv;
  const privateKeyPath = process.env[privateKeyEnv];
  if (!privateKeyPath) {
    throw new Error(
      `Workspace provider "${snapshot.providerId}" is missing ${privateKeyEnv}.`,
    );
  }
  const privateKeyDigest = createHash('sha256')
    .update(await readFile(privateKeyPath))
    .digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        driver: snapshot.driver,
        hostEnv,
        host: process.env[hostEnv] ?? '',
        privateKeyEnv,
        privateKeyPath,
        privateKeyDigest,
        username: snapshot.config.username ?? 'user',
        port: snapshot.driver === 'ssh' ? (snapshot.config.port ?? 22) : 22,
      }),
    )
    .digest('hex');
}

async function resolveExecutionScope(
  input: ScopedExecutionInput,
  policyCheck: ExecutionPolicyCheck,
  paths: RuntimePaths,
) {
  return (
    (await resolveExecutionTarget(input, policyCheck, paths))?.scope ?? null
  );
}

export function approvedExecutionTargetIdentity(
  providerId: string,
  selectedRoot: string | null,
) {
  return `approved-${createHash('sha256')
    .update(JSON.stringify([providerId, selectedRoot ?? 'provider-root']))
    .digest('hex')
    .slice(0, 24)}`;
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
