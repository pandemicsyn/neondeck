import {
  parseAppConfig,
  readRuntimeJsonSync,
  runtimePaths,
  type RuntimePaths,
  type WorkspaceProviderConfig,
  exeDevWorkspaceProviderConfigSchema,
  sshWorkspaceProviderConfigSchema,
} from '../../runtime-home';
import * as v from 'valibot';
import { createHash } from 'node:crypto';
import { localWorkspaceProvider } from './local';
import { WorkspaceProviderRegistry } from './registry';
import { remoteWorkspaceProvider } from './remote';

export * from './registry';
export * from './schemas';
export { localWorkspaceProvider } from './local';
export { remoteWorkspaceProvider } from './remote';
export { canonicalSshHost, physicalRemoteResourceKey } from './remote';

export const workspaceProviderSnapshotSchema = v.pipe(
  v.variant('driver', [
    v.strictObject({
      version: v.literal(1),
      providerId: v.literal('local'),
      driver: v.literal('local'),
    }),
    v.strictObject({
      version: v.literal(1),
      providerId: v.pipe(v.string(), v.minLength(1)),
      driver: v.literal('exe.dev'),
      config: exeDevWorkspaceProviderConfigSchema,
    }),
    v.strictObject({
      version: v.literal(1),
      providerId: v.pipe(v.string(), v.minLength(1)),
      driver: v.literal('ssh'),
      config: sshWorkspaceProviderConfigSchema,
    }),
  ]),
);

export function captureWorkspaceProviderSnapshot(
  providerId: string,
  paths: RuntimePaths = runtimePaths(),
): import('./schemas').WorkspaceProviderSnapshot {
  if (providerId === 'local') {
    return { version: 1, providerId: 'local', driver: 'local' };
  }
  const app = readRuntimeJsonSync(paths.config, parseAppConfig);
  const config =
    app.workspaces?.providers?.[providerId] ??
    (providerId === 'exe.dev'
      ? legacyExeDevWorkspaceConfig(app.execution)
      : undefined);
  if (!config) {
    throw new Error(`Workspace provider "${providerId}" is not configured.`);
  }
  return v.parse(workspaceProviderSnapshotSchema, {
    version: 1,
    providerId,
    driver: config.driver,
    config,
  });
}

export function workspaceProviderFromSnapshot(
  snapshot: import('./schemas').WorkspaceProviderSnapshot,
  paths: RuntimePaths = runtimePaths(),
) {
  const parsed = v.parse(workspaceProviderSnapshotSchema, snapshot);
  return parsed.driver === 'local'
    ? localWorkspaceProvider({
        privateHomeRoot: `${paths.home}/workspace-homes`,
      })
    : remoteWorkspaceProvider({ id: parsed.providerId, config: parsed.config });
}

export function workspaceProviderSnapshotFingerprint(
  snapshot: import('./schemas').WorkspaceProviderSnapshot,
) {
  const parsed = v.parse(workspaceProviderSnapshotSchema, snapshot);
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
}

export function createWorkspaceProviderRegistry(
  paths: RuntimePaths = runtimePaths(),
) {
  const config = readRuntimeJsonSync(paths.config, parseAppConfig);
  const registry = new WorkspaceProviderRegistry().register(
    localWorkspaceProvider({
      privateHomeRoot: `${paths.home}/workspace-homes`,
    }),
  );
  const configured = { ...config.workspaces?.providers };
  if (!configured['exe.dev']) {
    configured['exe.dev'] = legacyExeDevWorkspaceConfig(config.execution);
  }
  for (const [id, providerConfig] of Object.entries(configured)) {
    registry.register(remoteWorkspaceProvider({ id, config: providerConfig }));
  }
  return registry;
}

function legacyExeDevWorkspaceConfig(
  execution: ReturnType<typeof parseAppConfig>['execution'],
): WorkspaceProviderConfig {
  return {
    driver: 'exe.dev',
    apiTokenEnv: execution?.exeDev?.apiTokenEnv,
    sshKeyEnv: execution?.exeDev?.sshKeyEnv,
    vmHostEnv: execution?.exeDev?.vmHostEnv,
    remoteRoot: execution?.exeDev?.remoteRoot,
  };
}
