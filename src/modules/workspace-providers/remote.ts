import type { Sandbox, SandboxFactory } from '@flue/runtime';
import { createHash } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import {
  createSshSandbox,
  createExeVm,
  deleteExeVm,
  isSshOperationUncertainError,
  sshCommandUncertainty,
  type SshAdapterOptions,
  type ExeDevVm,
} from '../../sandboxes/exedev';
import type { WorkspaceProviderConfig } from '../../runtime-home';
import type {
  WorkspaceDestroyContext,
  WorkspaceProvider,
  WorkspaceResource,
  WorkspaceSandboxContext,
} from './schemas';
import {
  isWorkspaceOperationUncertainError,
  WorkspaceOperationUncertainError,
  WorkspaceProviderError,
} from './schemas';
import { sanitizeExecutionText } from '../execution/utils';

const shellSafeSegment = /^[A-Za-z0-9._-]+$/;

export function remoteWorkspaceProvider(input: {
  id: string;
  config: WorkspaceProviderConfig;
  legacyExeDev?: WorkspaceProviderConfig;
  connectSsh?: typeof createSshSandbox;
}): WorkspaceProvider {
  const config = input.config ?? input.legacyExeDev;
  if (!config) {
    throw new WorkspaceProviderError(
      'invalid-config',
      `Workspace provider "${input.id}" has no configuration.`,
      input.id,
    );
  }
  return config.driver === 'exe.dev'
    ? exeDevProvider(input.id, config, input.connectSsh ?? createSshSandbox)
    : sshProvider(input.id, config, input.connectSsh ?? createSshSandbox);
}

function exeDevProvider(
  id: string,
  config: Extract<WorkspaceProviderConfig, { driver: 'exe.dev' }>,
  connectSsh: typeof createSshSandbox,
): WorkspaceProvider {
  const descriptor = {
    id,
    label: id === 'exe.dev' ? 'exe.dev' : id,
    location: 'remote' as const,
    capabilities: {
      provision: true,
      attachExisting: true,
      persistentResources: true,
      snapshots: false,
      commandCancellation: 'orphan-possible' as const,
    },
  };
  const resolveExistingVm = () => {
    const hostEnv = config.vmHostEnv ?? 'EXE_VM_HOST';
    const host = process.env[hostEnv];
    if (!host) notReady(id, [hostEnv]);
    const canonicalHost = canonicalSshHost(host as string);
    return { host: canonicalHost, name: vmNameFromHost(canonicalHost) };
  };
  const sshKeyEnv = config.sshKeyEnv ?? 'EXE_SSH_KEY';
  const sshOptions = (): SshAdapterOptions => {
    const privateKeyPath = environmentValue(sshKeyEnv);
    if (!privateKeyPath) notReady(id, [sshKeyEnv]);
    return {
      username: config.username,
      privateKeyPath,
      allowAmbientAuth: false,
    };
  };
  const plannedResource = (resourceId: string) => {
    safeResourceId(resourceId);
    const vm = {
      name: resourceId,
      host: canonicalSshHost(`${resourceId}.exe.xyz`),
    };
    return resource(id, vm, remoteRoot(config.remoteRoot, resourceId), {
      managedInfrastructure: true,
      vmName: resourceId,
      host: vm.host,
      providerRoot: configuredRemoteRoot(config.remoteRoot),
      username: config.username ?? 'user',
      privateHome: remotePrivateHome(config.remoteRoot, resourceId),
      pathsCanonical: false,
    });
  };
  return {
    descriptor,
    validateConfig: () => ({ ok: true }),
    async readiness(context) {
      const hostEnv = config.vmHostEnv ?? 'EXE_VM_HOST';
      const apiTokenEnv = config.apiTokenEnv ?? 'EXE_API_TOKEN';
      const missing = [
        ...(context?.lifecycle === 'existing'
          ? missingEnvironment([hostEnv])
          : context?.lifecycle
            ? missingEnvironment([apiTokenEnv])
            : process.env[hostEnv] || process.env[apiTokenEnv]
              ? []
              : [hostEnv, apiTokenEnv]),
        ...missingEnvironment([sshKeyEnv]),
      ];
      const credentialError = missing.includes(sshKeyEnv)
        ? undefined
        : await sshKeyError(sshKeyEnv);
      const hostError =
        context?.lifecycle === 'existing' && !missing.includes(hostEnv)
          ? sshHostError(hostEnv)
          : undefined;
      return {
        ready: missing.length === 0 && !credentialError && !hostError,
        message:
          missing.length > 0
            ? `Missing exe.dev environment: ${missing.join(', ')}.`
            : (credentialError ??
              hostError ??
              (context?.lifecycle === 'existing'
                ? 'exe.dev existing-VM attachment is configured.'
                : context?.lifecycle
                  ? 'exe.dev managed VM provisioning is configured.'
                  : 'exe.dev has an existing-VM host or managed-VM API token.')),
        missingEnvironment: missing,
      };
    },
    planProvision({ resourceId }) {
      return plannedResource(resourceId);
    },
    async provision({ resourceId }) {
      safeResourceId(resourceId);
      const apiTokenEnv = config.apiTokenEnv ?? 'EXE_API_TOKEN';
      const apiToken = environmentValue(apiTokenEnv);
      if (!apiToken) notReady(id, [apiTokenEnv]);
      const vm = await createExeVm({
        apiToken,
        name: resourceId,
        ssh: sshOptions(),
      });
      const workspace = resource(
        id,
        vm,
        remoteRoot(config.remoteRoot, resourceId),
        {
          managedInfrastructure: true,
          vmName: vm.name,
          host: vm.host,
          providerRoot: configuredRemoteRoot(config.remoteRoot),
          username: config.username ?? 'user',
          privateHome: remotePrivateHome(config.remoteRoot, resourceId),
        },
      );
      const connection = await connectRemoteTransport(
        workspace,
        sshOptions(),
        connectSsh,
      );
      try {
        await runRemoteStructuredMutation(id, 'mkdir', () =>
          connection.env.mkdir(workspace.root, { recursive: true }),
        );
        return await canonicalRemoteResource(connection.env, workspace);
      } finally {
        await closeRemoteTransport(connection, 'exe.dev provision');
      }
    },
    async attach({ externalId, root, allowProviderRoot, privateHomeIdentity }) {
      const vm =
        externalId === 'configured' || externalId.startsWith('configured-')
          ? resolveExistingVm()
          : { host: externalId };
      const providerRoot = configuredRemoteRoot(config.remoteRoot);
      const selectedRoot =
        root ??
        (allowProviderRoot &&
        (externalId === 'configured' || externalId.startsWith('configured-'))
          ? providerRoot
          : remoteRoot(config.remoteRoot, externalId));
      if (allowProviderRoot) assertRemoteRoot(providerRoot, selectedRoot, true);
      const workspace = resource(id, vm, selectedRoot, {
        managedInfrastructure: false,
        host: vm.host,
        providerRoot,
        username: config.username ?? 'user',
        privateHome: remotePrivateHome(
          config.remoteRoot,
          privateHomeIdentity ?? externalId,
        ),
        pathsCanonical: false,
        allowProviderRoot: allowProviderRoot === true,
        ...('name' in vm && vm.name ? { vmName: vm.name } : {}),
      });
      const connection = await connectRemoteTransport(
        workspace,
        sshOptions(),
        connectSsh,
      );
      try {
        return await canonicalRemoteResource(connection.env, workspace);
      } finally {
        await closeRemoteTransport(connection, 'exe.dev attach');
      }
    },
    connect: (workspace) => connectRemote(workspace, sshOptions(), connectSsh),
    sandbox: (workspace, context) =>
      remoteSandbox(workspace, sshOptions(), connectSsh, context),
    inspect: (workspace) => inspectRemote(workspace, sshOptions(), connectSsh),
    async destroy(workspace, context) {
      context?.assertLease();
      if (workspace.metadata.managedInfrastructure !== true) {
        await removeRemotePrivateHome(
          workspace,
          sshOptions(),
          connectSsh,
          context,
        );
        return;
      }
      const apiTokenEnv = config.apiTokenEnv ?? 'EXE_API_TOKEN';
      const apiToken = environmentValue(apiTokenEnv);
      const name = readMetadataString(workspace, 'vmName');
      if (!apiToken) notReady(id, [apiTokenEnv]);
      if (!name) {
        throw new WorkspaceProviderError(
          'resource-unavailable',
          'Managed exe.dev resource is missing its VM name.',
          id,
        );
      }
      context?.assertLease();
      await deleteExeVm({ apiToken, name });
    },
  };
}

function sshProvider(
  id: string,
  config: Extract<WorkspaceProviderConfig, { driver: 'ssh' }>,
  connectSsh: typeof createSshSandbox,
): WorkspaceProvider {
  const vm = () => {
    const host = environmentValue(config.hostEnv);
    if (!host) notReady(id, [config.hostEnv]);
    return { host: canonicalSshHost(host as string), port: config.port };
  };
  const sshOptions = (): SshAdapterOptions => {
    const privateKeyPath = environmentValue(config.privateKeyEnv);
    if (!privateKeyPath) notReady(id, [config.privateKeyEnv]);
    return {
      username: config.username,
      port: config.port,
      privateKeyPath,
      allowAmbientAuth: false,
    };
  };
  const plannedResource = (resourceId: string) => {
    safeResourceId(resourceId);
    return resource(id, vm(), remoteRoot(config.remoteRoot, resourceId), {
      managedInfrastructure: false,
      managedDirectory: true,
      providerRoot: config.remoteRoot,
      username: config.username ?? 'user',
      privateHome: remotePrivateHome(config.remoteRoot, resourceId),
      pathsCanonical: false,
    });
  };
  return {
    descriptor: {
      id,
      label: id,
      location: 'remote',
      capabilities: {
        provision: true,
        attachExisting: true,
        persistentResources: true,
        snapshots: false,
        commandCancellation: 'orphan-possible',
      },
    },
    validateConfig: () => ({ ok: true }),
    async readiness() {
      const missing = missingEnvironment([
        config.hostEnv,
        config.privateKeyEnv,
      ]);
      const credentialError = missing.includes(config.privateKeyEnv)
        ? undefined
        : await sshKeyError(config.privateKeyEnv);
      const hostError = missing.includes(config.hostEnv)
        ? undefined
        : sshHostError(config.hostEnv);
      return {
        ready: missing.length === 0 && !credentialError && !hostError,
        message:
          missing.length > 0
            ? `Missing SSH provider environment: ${missing.join(', ')}.`
            : (credentialError ??
              hostError ??
              `SSH workspace provider "${id}" is configured.`),
        missingEnvironment: missing,
      };
    },
    planProvision({ resourceId }) {
      return plannedResource(resourceId);
    },
    async provision({ resourceId }) {
      const workspace = plannedResource(resourceId);
      const connection = await connectRemoteTransport(
        workspace,
        sshOptions(),
        connectSsh,
      );
      try {
        await runRemoteStructuredMutation(id, 'mkdir', () =>
          connection.env.mkdir(workspace.root, { recursive: true }),
        );
        return await canonicalRemoteResource(connection.env, workspace);
      } finally {
        await closeRemoteTransport(connection, 'generic SSH provision');
      }
    },
    async attach({ externalId, root, allowProviderRoot, privateHomeIdentity }) {
      safeResourceId(externalId);
      const selectedRoot =
        root ??
        (allowProviderRoot
          ? config.remoteRoot
          : remoteRoot(config.remoteRoot, externalId));
      assertRemoteRoot(config.remoteRoot, selectedRoot, allowProviderRoot);
      const workspace = resource(id, vm(), selectedRoot, {
        managedInfrastructure: false,
        managedDirectory: false,
        attachedResourceId: externalId,
        providerRoot: config.remoteRoot,
        username: config.username ?? 'user',
        privateHome: remotePrivateHome(
          config.remoteRoot,
          privateHomeIdentity ?? externalId,
        ),
        pathsCanonical: false,
        allowProviderRoot: allowProviderRoot === true,
      });
      const connection = await connectRemoteTransport(
        workspace,
        sshOptions(),
        connectSsh,
      );
      try {
        return await canonicalRemoteResource(connection.env, workspace);
      } finally {
        await closeRemoteTransport(connection, 'generic SSH attach');
      }
    },
    connect: (workspace) => connectRemote(workspace, sshOptions(), connectSsh),
    sandbox: (workspace, context) =>
      remoteSandbox(workspace, sshOptions(), connectSsh, context),
    inspect: (workspace) => inspectRemote(workspace, sshOptions(), connectSsh),
    async destroy(workspace, context) {
      context?.assertLease();
      const connection = await connectRemoteTransport(
        workspace,
        sshOptions(),
        connectSsh,
      );
      try {
        const declaredProviderRoot =
          readMetadataString(workspace, 'providerRoot') ?? config.remoteRoot;
        if (!(await connection.env.exists(declaredProviderRoot))) return;
        const providerRoot =
          workspace.metadata.pathsCanonical === true
            ? declaredProviderRoot
            : await realPath(connection.env, declaredProviderRoot, false);
        if (workspace.metadata.managedDirectory === true) {
          const workspaceRoot =
            workspace.metadata.pathsCanonical === true
              ? workspace.root
              : await realPath(connection.env, workspace.root, true);
          assertPhysicalRemoteRoot(providerRoot, workspaceRoot);
          context?.assertLease();
          const removed = await connection.env.exec(
            `rm -rf -- '${shellEscape(workspaceRoot)}'`,
            {
              cwd: providerRoot,
              timeoutMs: 60_000,
              signal: context?.signal,
            },
          );
          assertRemoteCommand(removed, 'SSH workspace cleanup');
          context?.assertLease();
        }
        context?.assertLease();
        await removeRemotePrivateHomeWithEnvironment(
          connection.env,
          workspace,
          providerRoot,
          context,
        );
      } finally {
        await closeRemoteTransport(connection, 'generic SSH cleanup');
      }
    },
  };
}

function resource(
  providerId: string,
  vm: ExeDevVm,
  root: string,
  metadata: Record<string, unknown>,
): WorkspaceResource {
  const host = canonicalSshHost(vm.host);
  return {
    providerId,
    externalId: remoteResourceIdentity(host, root),
    root,
    metadata: { ...metadata, host, port: vm.port },
  };
}

function remoteResourceIdentity(host: string, root: string) {
  return `remote:${JSON.stringify([canonicalSshHost(host), posix.normalize(root)])}`;
}

export function physicalRemoteResourceKey(resource: WorkspaceResource) {
  const host = canonicalSshHost(
    readMetadataString(resource, 'host') ?? resource.externalId,
  );
  const username = readMetadataString(resource, 'username') ?? 'user';
  const port = readMetadataNumber(resource, 'port') ?? 22;
  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  const encodedRoot = posix
    .normalize(resource.root)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `ssh://${encodeURIComponent(username)}@${urlHost}:${port}${encodedRoot}`;
}

async function connectRemote(
  workspace: WorkspaceResource,
  options: SshAdapterOptions,
  connectSsh: typeof createSshSandbox,
  control?: RemoteExecutionControl,
  context?: WorkspaceSandboxContext,
) {
  const connected = control
    ? await connectRemoteTransportWithControl(
        workspace,
        options,
        connectSsh,
        control,
        context,
      )
    : await connectRemoteTransport(workspace, options, connectSsh);
  try {
    return {
      env: await securedRemoteEnvironment(
        connected.env,
        workspace,
        control,
        context,
      ),
      close: connected.close,
    };
  } catch (error) {
    await closeRemoteTransport(connected, 'secured SSH connection setup');
    throw error;
  }
}

type RemoteExecutionControl = {
  signal?: AbortSignal;
  deadline?: number;
};

function remoteAbortError(reason: unknown) {
  const error = new DOMException(
    'Remote sandbox setup was aborted before command execution.',
    'AbortError',
  );
  Object.defineProperty(error, 'cause', { value: reason });
  return error;
}

function assertRemoteExecutionActive(control?: RemoteExecutionControl) {
  if (control?.signal?.aborted) {
    throw remoteAbortError(control.signal.reason);
  }
}

function remainingRemoteTimeout(
  control: RemoteExecutionControl | undefined,
  maximumMs: number,
) {
  assertRemoteExecutionActive(control);
  if (control?.deadline === undefined) return maximumMs;
  const remaining = control.deadline - Date.now();
  if (remaining <= 0) {
    throw new WorkspaceOperationUncertainError({
      kind: 'timeout',
      operation: 'remote sandbox setup',
      message:
        'Remote sandbox setup exhausted the command timeout before execution began.',
    });
  }
  return Math.min(maximumMs, remaining);
}

async function connectRemoteTransport(
  workspace: WorkspaceResource,
  options: SshAdapterOptions,
  connectSsh: typeof createSshSandbox,
) {
  const host = readMetadataString(workspace, 'host') ?? workspace.externalId;
  const port = readMetadataNumber(workspace, 'port');
  const connected = await connectSsh({ host, port }, options);
  return {
    env: connected.env,
    close: async () => connected.dispose(),
  };
}

async function connectRemoteTransportWithControl(
  workspace: WorkspaceResource,
  options: SshAdapterOptions,
  connectSsh: typeof createSshSandbox,
  control: RemoteExecutionControl,
  context?: WorkspaceSandboxContext,
) {
  assertRemoteExecutionActive(control);
  const pending = connectRemoteTransport(workspace, options, connectSsh);
  const signal = control.signal;
  return new Promise<Awaited<ReturnType<typeof connectRemoteTransport>>>(
    (resolve, reject) => {
      let settled = false;
      const remaining =
        control.deadline === undefined
          ? undefined
          : Math.max(0, control.deadline - Date.now());
      const timeout =
        remaining === undefined
          ? undefined
          : setTimeout(() => {
              finish(() =>
                reject(
                  new WorkspaceOperationUncertainError({
                    kind: 'timeout',
                    operation: 'SSH connection setup',
                    message:
                      'SSH connection setup exceeded the command timeout before the remote command began.',
                  }),
                ),
              );
            }, remaining);
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () =>
        finish(() => reject(remoteAbortError(signal?.reason)));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
      void pending.then(
        (connection) => {
          if (settled) {
            void closeRemoteTransport(
              connection,
              'aborted SSH connection setup',
              context,
            );
            return;
          }
          finish(() => resolve(connection));
        },
        (error) => finish(() => reject(error)),
      );
    },
  );
}

function remoteSandbox(
  workspace: WorkspaceResource,
  options: SshAdapterOptions,
  connectSsh: typeof createSshSandbox,
  context?: WorkspaceSandboxContext,
): SandboxFactory {
  return {
    async createSandbox() {
      try {
        return await disposableRemoteEnvironment(
          workspace,
          options,
          connectSsh,
          context,
        );
      } catch (error) {
        await reportRemoteOperationUncertainty(context, error);
        throw error;
      }
    },
  };
}

async function reportRemoteOperationUncertainty(
  context: WorkspaceSandboxContext | undefined,
  error: unknown,
) {
  if (isWorkspaceOperationUncertainError(error)) {
    await context?.onOperationUncertain?.(error);
  }
}

async function disposableRemoteEnvironment(
  workspace: WorkspaceResource,
  options: SshAdapterOptions,
  connectSsh: typeof createSshSandbox,
  context?: WorkspaceSandboxContext,
): Promise<Sandbox> {
  const probe = await connectRemoteTransport(workspace, options, connectSsh);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realPath(probe.env, workspace.root, false);
  } finally {
    await closeRemoteTransport(probe, 'sandbox root probe', context);
  }
  const containedPath = containedPathResolver(canonicalRoot);
  const withConnection = async <T>(
    operationName: string,
    operation: (env: Sandbox) => Promise<T>,
    control?: RemoteExecutionControl,
  ) => {
    try {
      const connection = await connectRemote(
        workspace,
        options,
        connectSsh,
        control,
        context,
      );
      let completed = false;
      try {
        const value = await operation(connection.env);
        completed = true;
        return value;
      } finally {
        await closeRemoteTransport(
          connection,
          completed ? 'settled sandbox operation' : 'failed sandbox operation',
          context,
        );
      }
    } catch (error) {
      const normalized = isSshOperationUncertainError(error)
        ? new WorkspaceOperationUncertainError(
            {
              kind: error.uncertainty.kind,
              operation: operationName,
              message: error.uncertainty.message,
            },
            workspace.providerId,
          )
        : error;
      await reportRemoteOperationUncertainty(context, normalized);
      throw normalized;
    }
  };
  return {
    cwd: canonicalRoot,
    resolvePath: containedPath,
    exec: (command, execOptions) => {
      if (execOptions?.signal?.aborted) {
        return Promise.reject(remoteAbortError(execOptions.signal.reason));
      }
      const control: RemoteExecutionControl = {
        signal: execOptions?.signal,
        ...(execOptions?.timeoutMs === undefined
          ? {}
          : { deadline: Date.now() + execOptions.timeoutMs }),
      };
      return withConnection(
        'exec',
        (env) =>
          env.exec(command, {
            ...execOptions,
            timeoutMs:
              execOptions?.timeoutMs === undefined
                ? undefined
                : remainingRemoteTimeout(control, execOptions.timeoutMs),
            cwd: containedPath(execOptions?.cwd ?? canonicalRoot),
          }),
        control,
      );
    },
    readFile: (path) => withConnection('readFile', (env) => env.readFile(path)),
    readFileBuffer: (path) =>
      withConnection('readFileBuffer', (env) => env.readFileBuffer(path)),
    writeFile: (path, content) =>
      withConnection('writeFile', (env) => env.writeFile(path, content)),
    stat: (path) => withConnection('stat', (env) => env.stat(path)),
    readdir: (path) => withConnection('readdir', (env) => env.readdir(path)),
    async exists(path) {
      try {
        return await withConnection('exists', (env) => env.exists(path));
      } catch {
        return false;
      }
    },
    mkdir: (path, mkdirOptions) =>
      withConnection('mkdir', (env) => env.mkdir(path, mkdirOptions)),
    rm: (path, rmOptions) =>
      withConnection('rm', (env) => env.rm(path, rmOptions)),
  };
}

async function securedRemoteEnvironment(
  env: Sandbox,
  workspace: WorkspaceResource,
  control?: RemoteExecutionControl,
  context?: WorkspaceSandboxContext,
): Promise<Sandbox> {
  assertRemoteExecutionActive(control);
  await assertCredentialFreeRemote(env, workspace.providerId, control);
  const root = await realPath(env, workspace.root, false, undefined, control);
  const privateHome = requiredMetadataString(workspace, 'privateHome');
  const providerRootValue = requiredMetadataString(workspace, 'providerRoot');
  const canonicalProviderRoot = await realPath(
    env,
    providerRootValue,
    false,
    undefined,
    control,
  );
  assertRemoteRoot(
    canonicalProviderRoot,
    root,
    workspace.metadata.allowProviderRoot === true,
  );
  const canonicalPrivateHome = await realPath(
    env,
    privateHome,
    true,
    undefined,
    control,
  );
  assertPhysicalRemoteRoot(canonicalProviderRoot, canonicalPrivateHome);
  const created = await env.exec(
    `mkdir -p -- '${shellEscape(canonicalPrivateHome)}' && chmod 700 -- '${shellEscape(canonicalPrivateHome)}'`,
    {
      timeoutMs: remainingRemoteTimeout(control, 10_000),
      signal: control?.signal,
    },
  );
  assertRemoteCommand(created, 'Remote private HOME setup');
  const protectedEnvironment: Record<string, string> = {
    HOME: canonicalPrivateHome,
    SSH_AUTH_SOCK: '',
    GIT_ASKPASS: '/bin/false',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH_COMMAND:
      'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes',
  };
  return containedRemoteEnvironment(
    env,
    root,
    protectedEnvironment,
    workspace.providerId,
    context,
  );
}

function containedRemoteEnvironment(
  env: Sandbox,
  root: string,
  protectedEnvironment: Record<string, string>,
  providerId?: string,
  context?: WorkspaceSandboxContext,
): Sandbox {
  const canonicalRoot = posix.resolve(root);
  const containedPath = containedPathResolver(canonicalRoot);
  const assertPhysical = async (
    candidate: string,
    allowMissing: boolean,
    control?: RemoteExecutionControl,
  ) => {
    const resolved = containedPath(candidate);
    const physical = await realPath(
      env,
      resolved,
      allowMissing,
      { ...protectedEnvironment },
      control,
    );
    containedPath(physical);
    return resolved;
  };
  const structuredMutation = async <T>(
    operation: 'writeFile' | 'mkdir' | 'rm',
    mutate: () => Promise<T>,
  ) => {
    try {
      return await mutate();
    } catch (error) {
      if (isSshOperationUncertainError(error)) {
        throw new WorkspaceOperationUncertainError({
          kind: error.uncertainty.kind,
          operation,
          message: error.uncertainty.message,
        });
      }
      throw error;
    }
  };
  return {
    ...env,
    cwd: canonicalRoot,
    resolvePath: containedPath,
    async exec(command, execOptions) {
      if (execOptions?.signal?.aborted) {
        throw remoteAbortError(execOptions.signal.reason);
      }
      const control: RemoteExecutionControl = {
        signal: execOptions?.signal,
        ...(execOptions?.timeoutMs === undefined
          ? {}
          : { deadline: Date.now() + execOptions.timeoutMs }),
      };
      const cwd = await assertPhysical(
        execOptions?.cwd ?? canonicalRoot,
        false,
        control,
      );
      return env.exec(command, {
        ...execOptions,
        timeoutMs:
          execOptions?.timeoutMs === undefined
            ? undefined
            : remainingRemoteTimeout(control, execOptions.timeoutMs),
        cwd,
        env: { ...execOptions?.env, ...protectedEnvironment },
      });
    },
    readFile: async (path) => env.readFile(await assertPhysical(path, false)),
    readFileBuffer: async (path) =>
      env.readFileBuffer(await assertPhysical(path, false)),
    writeFile: async (path, content) =>
      structuredMutation('writeFile', async () =>
        env.writeFile(await assertPhysical(path, true), content),
      ),
    stat: async (path) => {
      await assertPhysical(path, false);
      return env.stat(containedPath(path));
    },
    readdir: async (path) => env.readdir(await assertPhysical(path, false)),
    exists: async (path) => {
      try {
        const resolved = await assertPhysical(path, true);
        return await env.exists(resolved);
      } catch (error) {
        const normalized = isSshOperationUncertainError(error)
          ? new WorkspaceOperationUncertainError(
              {
                kind: error.uncertainty.kind,
                operation: 'exists',
                message: error.uncertainty.message,
              },
              providerId,
            )
          : error;
        try {
          await reportRemoteOperationUncertainty(context, normalized);
        } catch {
          // Flue requires exists to be total. The application callback fences
          // release before its durable quarantine write, so returning false
          // here remains fail-closed even when that write reports failure.
        }
        return false;
      }
    },
    mkdir: async (path, mkdirOptions) =>
      structuredMutation('mkdir', async () =>
        env.mkdir(await assertPhysical(path, true), mkdirOptions),
      ),
    rm: async (path, rmOptions) =>
      structuredMutation('rm', async () =>
        env.rm(
          await assertPhysical(path, Boolean(rmOptions?.force)),
          rmOptions,
        ),
      ),
  };
}

async function runRemoteStructuredMutation<T>(
  providerId: string,
  operation: 'writeFile' | 'mkdir' | 'rm',
  mutate: () => Promise<T>,
) {
  try {
    return await mutate();
  } catch (error) {
    if (isSshOperationUncertainError(error)) {
      throw new WorkspaceOperationUncertainError(
        {
          kind: error.uncertainty.kind,
          operation,
          message: error.uncertainty.message,
        },
        providerId,
      );
    }
    throw error;
  }
}

function containedPathResolver(canonicalRoot: string) {
  return (candidate: string) => {
    const resolved = posix.resolve(
      canonicalRoot,
      posix.isAbsolute(candidate)
        ? posix.relative(canonicalRoot, candidate)
        : candidate,
    );
    const fromRoot = posix.relative(canonicalRoot, resolved);
    if (fromRoot === '..' || fromRoot.startsWith('../')) {
      throw new Error(`Workspace path escapes the managed root: ${candidate}`);
    }
    return resolved;
  };
}

async function realPath(
  env: Sandbox,
  candidate: string,
  allowMissing: boolean,
  commandEnvironment?: Record<string, string>,
  control?: RemoteExecutionControl,
) {
  const result = await env.exec(
    `realpath ${allowMissing ? '-m' : '-e'} -- '${shellEscape(candidate)}'`,
    {
      timeoutMs: remainingRemoteTimeout(control, 10_000),
      signal: control?.signal,
      env: commandEnvironment,
    },
  );
  assertRemoteCommand(result, 'Remote path resolution');
  return result.stdout.trim();
}

async function assertCredentialFreeRemote(
  env: Sandbox,
  providerId: string,
  control?: RemoteExecutionControl,
) {
  const audit = await env.exec(
    [
      'set -eu',
      'for path in "$HOME/.git-credentials" "$HOME/.netrc" "$HOME/.config/gh/hosts.yml" "$HOME/.config/glab-cli/config.yml"; do [ ! -e "$path" ] || printf "%s\\n" "$path"; done',
      'if [ -d "$HOME/.ssh" ]; then find "$HOME/.ssh" -maxdepth 1 -type f ! -name authorized_keys ! -name known_hosts ! -name known_hosts.old ! -name "*.pub" -print; fi',
      'git config --global --get-all credential.helper 2>/dev/null || true',
      "env | awk -F= '$1 ~ /(TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|AUTH_SOCK)$/ { print $1 }'",
    ].join('; '),
    {
      timeoutMs: remainingRemoteTimeout(control, 10_000),
      signal: control?.signal,
    },
  );
  assertRemoteCommand(audit, 'Remote credential audit');
  if (audit.stdout.trim()) {
    throw new WorkspaceProviderError(
      'not-ready',
      `Workspace provider "${providerId}" must use a dedicated credential-free SSH account. Remove ambient Git/SSH credentials reported by the readiness audit.`,
      providerId,
    );
  }
}

function assertRemoteCommand(
  result: { exitCode: number; stderr: string },
  operation: string,
) {
  const uncertainty = sshCommandUncertainty(result);
  if (uncertainty) {
    throw new WorkspaceOperationUncertainError({
      kind: uncertainty.kind,
      operation,
      message: `${operation} has an uncertain remote outcome: ${uncertainty.message}`,
    });
  }
  if (result.exitCode !== 0) {
    throw new WorkspaceProviderError(
      'provider-operation-failed',
      `${operation} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}.`,
    );
  }
}

async function inspectRemote(
  workspace: WorkspaceResource,
  options: SshAdapterOptions,
  connectSsh: typeof createSshSandbox,
) {
  try {
    const connection = await connectRemoteTransport(
      workspace,
      options,
      connectSsh,
    );
    try {
      const providerRoot = await realPath(
        connection.env,
        requiredMetadataString(workspace, 'providerRoot'),
        false,
      );
      const workspaceRoot = await realPath(
        connection.env,
        workspace.root,
        true,
      );
      assertPhysicalRemoteRoot(providerRoot, workspaceRoot);
      return (await connection.env.exists(workspaceRoot))
        ? {
            status: 'ready' as const,
            message: 'Remote workspace is available.',
          }
        : {
            status: 'missing' as const,
            message: 'Remote workspace root is missing.',
          };
    } finally {
      await closeRemoteTransport(connection, 'remote inspection');
    }
  } catch (error) {
    return {
      status: 'unavailable' as const,
      message: sanitizeExecutionText(
        error instanceof Error ? error.message : String(error),
        16 * 1024,
      ).content,
    };
  }
}

function remoteRoot(configured: string | undefined, resourceId: string) {
  safeResourceId(resourceId);
  return `${configuredRemoteRoot(configured)}/${resourceId}`;
}

function configuredRemoteRoot(configured: string | undefined) {
  return posix.normalize(configured ?? '/home/user/neondeck/checkouts');
}

function safeResourceId(value: string) {
  if (!shellSafeSegment.test(value)) {
    throw new WorkspaceProviderError(
      'invalid-config',
      `Unsafe workspace resource id "${value}".`,
    );
  }
}

function assertPhysicalRemoteRoot(root: string, candidate: string) {
  assertRemoteRoot(root, candidate, false);
}

function assertRemoteRoot(
  root: string,
  candidate: string,
  allowProviderRoot = false,
) {
  const relative = posix.relative(root, candidate);
  if (
    (!relative && !allowProviderRoot) ||
    relative === '..' ||
    relative.startsWith('../')
  ) {
    throw new WorkspaceProviderError(
      'resource-unavailable',
      `Remote workspace resolves outside its configured provider root ${root}.`,
    );
  }
}

async function canonicalRemoteResource(
  env: Sandbox,
  workspace: WorkspaceResource,
) {
  const providerRoot = await realPath(
    env,
    requiredMetadataString(workspace, 'providerRoot'),
    false,
  );
  const root = await realPath(env, workspace.root, false);
  assertRemoteRoot(
    providerRoot,
    root,
    workspace.metadata.allowProviderRoot === true,
  );
  const privateHome = await realPath(
    env,
    requiredMetadataString(workspace, 'privateHome'),
    true,
  );
  assertPhysicalRemoteRoot(providerRoot, privateHome);
  const host = requiredMetadataString(workspace, 'host');
  return {
    ...workspace,
    externalId: remoteResourceIdentity(host, root),
    root,
    metadata: {
      ...workspace.metadata,
      providerRoot,
      privateHome,
      pathsCanonical: true,
    },
  };
}

async function removeRemotePrivateHome(
  workspace: WorkspaceResource,
  options: SshAdapterOptions,
  connectSsh: typeof createSshSandbox,
  context?: WorkspaceDestroyContext,
) {
  const connection = await connectRemoteTransport(
    workspace,
    options,
    connectSsh,
  );
  try {
    const declaredProviderRoot = requiredMetadataString(
      workspace,
      'providerRoot',
    );
    if (!(await connection.env.exists(declaredProviderRoot))) return;
    const providerRoot =
      workspace.metadata.pathsCanonical === true
        ? declaredProviderRoot
        : await realPath(connection.env, declaredProviderRoot, false);
    context?.assertLease();
    await removeRemotePrivateHomeWithEnvironment(
      connection.env,
      workspace,
      providerRoot,
      context,
    );
  } finally {
    await closeRemoteTransport(connection, 'remote private HOME cleanup');
  }
}

async function closeRemoteTransport(
  connection: { close(): Promise<void> },
  phase: string,
  context?: WorkspaceSandboxContext,
) {
  try {
    await connection.close();
  } catch (error) {
    const message = sanitizeExecutionText(
      error instanceof Error ? error.message : String(error),
      16 * 1024,
    ).content;
    console.warn(
      `[neondeck] remote workspace transport close failed after ${phase}: ${message}`,
    );
    try {
      await context?.onTransportCloseError?.(message);
    } catch (auditError) {
      console.warn(
        `[neondeck] failed to persist remote transport close audit: ${
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

async function removeRemotePrivateHomeWithEnvironment(
  env: Sandbox,
  workspace: WorkspaceResource,
  providerRoot: string,
  context?: WorkspaceDestroyContext,
) {
  const declaredPrivateHome = requiredMetadataString(workspace, 'privateHome');
  const privateHome =
    workspace.metadata.pathsCanonical === true
      ? declaredPrivateHome
      : await realPath(env, declaredPrivateHome, true);
  assertPhysicalRemoteRoot(providerRoot, privateHome);
  context?.assertLease();
  const removed = await env.exec(`rm -rf -- '${shellEscape(privateHome)}'`, {
    cwd: providerRoot,
    timeoutMs: 60_000,
    signal: context?.signal,
  });
  assertRemoteCommand(removed, 'Remote private HOME cleanup');
  context?.assertLease();
}

function remotePrivateHome(providerRoot: string | undefined, identity: string) {
  const digest = createHash('sha256')
    .update(identity)
    .digest('hex')
    .slice(0, 24);
  return `${configuredRemoteRoot(providerRoot)}/.neondeck-homes/${digest}`;
}

function environmentValue(name: string | undefined) {
  return name ? process.env[name] : undefined;
}

async function sshKeyError(environmentName: string) {
  const keyPath = process.env[environmentName];
  if (!keyPath) return `Missing SSH provider environment: ${environmentName}.`;
  try {
    const keyStat = await stat(keyPath);
    if (!keyStat.isFile()) {
      return `SSH private key from ${environmentName} is not a regular file.`;
    }
    await access(keyPath, constants.R_OK);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    return `SSH private key from ${environmentName} is not readable (${code}).`;
  }
}

function sshHostError(environmentName: string) {
  const value = process.env[environmentName];
  if (!value) return `Missing SSH provider environment: ${environmentName}.`;
  try {
    canonicalSshHost(value);
    return undefined;
  } catch (error) {
    return sanitizeExecutionText(
      error instanceof Error ? error.message : 'Invalid SSH host.',
      16 * 1024,
    ).content;
  }
}

export function canonicalSshHost(value: string) {
  if (value !== value.trim() || !value) {
    throw new WorkspaceProviderError(
      'invalid-config',
      'SSH host must not be empty or contain surrounding whitespace.',
    );
  }
  if (/\s|[/@]/.test(value) || value.includes('://')) {
    throw new WorkspaceProviderError(
      'invalid-config',
      'SSH host must be a hostname or IP address, not a URI, user-qualified host, or path.',
    );
  }
  let host = value;
  if (host.startsWith('[') || host.endsWith(']')) {
    if (!(host.startsWith('[') && host.endsWith(']'))) {
      throw new WorkspaceProviderError(
        'invalid-config',
        'SSH IPv6 hosts must use either a complete bracket pair or no brackets.',
      );
    }
    host = host.slice(1, -1);
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) return host;
  if (ipVersion === 6) {
    const normalized = new URL(`http://[${host}]/`).hostname;
    return normalized.slice(1, -1).toLowerCase();
  }
  if (/^[0-9.]+$/.test(host)) {
    throw new WorkspaceProviderError(
      'invalid-config',
      'SSH numeric IPv4 hosts must use canonical four-octet decimal notation.',
    );
  }
  if (host.includes(':')) {
    throw new WorkspaceProviderError(
      'invalid-config',
      'SSH host contains an invalid port or IPv6 address.',
    );
  }
  const normalized = host.toLowerCase().replace(/\.$/, '');
  if (
    normalized.length > 253 ||
    normalized.length === 0 ||
    !normalized
      .split('.')
      .every((label) =>
        /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      )
  ) {
    throw new WorkspaceProviderError(
      'invalid-config',
      'SSH host is not a valid hostname or IP address.',
    );
  }
  return normalized;
}

function missingEnvironment(names: string[]) {
  return names.filter((name) => !process.env[name]);
}

function notReady(providerId: string, missing: string[]): never {
  throw new WorkspaceProviderError(
    'not-ready',
    `Workspace provider "${providerId}" is missing environment variables: ${missing.join(', ')}.`,
    providerId,
  );
}

function vmNameFromHost(host: string) {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\.exe\.(?:xyz|dev)$/.exec(host);
  return match?.[1];
}

function readMetadataString(resource: WorkspaceResource, name: string) {
  const value = resource.metadata[name];
  return typeof value === 'string' ? value : undefined;
}

function requiredMetadataString(resource: WorkspaceResource, name: string) {
  const value = readMetadataString(resource, name);
  if (!value) {
    throw new WorkspaceProviderError(
      'resource-unavailable',
      `Remote workspace metadata is missing ${name}.`,
      resource.providerId,
    );
  }
  return value;
}

function readMetadataNumber(resource: WorkspaceResource, name: string) {
  const value = resource.metadata[name];
  return typeof value === 'number' ? value : undefined;
}

function shellEscape(value: string) {
  return value.replace(/'/g, `'\\''`);
}
