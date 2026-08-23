import { boundedLocal } from '../../sandboxes/local';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import type { Sandbox, SandboxFactory } from '@flue/runtime';
import type { WorkspaceProvider, WorkspaceResource } from './schemas';
import { WorkspaceProviderError } from './schemas';
import { sanitizeExecutionText } from '../execution/utils';

export function localWorkspaceProvider(
  options: { privateHomeRoot?: string } = {},
): WorkspaceProvider {
  return {
    descriptor: {
      id: 'local',
      label: 'Trusted local worktree',
      location: 'local',
      capabilities: {
        provision: false,
        attachExisting: true,
        persistentResources: true,
        snapshots: false,
        commandCancellation: 'native',
      },
    },
    validateConfig: () => ({ ok: true }),
    readiness: async () => ({
      ready: true,
      message: 'Local managed worktrees are available.',
      missingEnvironment: [],
    }),
    planProvision() {
      throw new WorkspaceProviderError(
        'unsupported-capability',
        'The local provider attaches Neondeck-managed worktrees; application code provisions them.',
        'local',
      );
    },
    async provision() {
      throw new WorkspaceProviderError(
        'unsupported-capability',
        'The local provider attaches Neondeck-managed worktrees; application code provisions them.',
        'local',
      );
    },
    async attach(input) {
      if (!input.root) {
        throw new WorkspaceProviderError(
          'invalid-config',
          'A local workspace requires a declared managed-worktree path.',
          'local',
        );
      }
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(input.root);
      } catch (error) {
        throw new WorkspaceProviderError(
          'resource-unavailable',
          `Local managed worktree "${input.root}" is unavailable: ${error instanceof Error ? error.message : String(error)}.`,
          'local',
        );
      }
      return {
        providerId: 'local',
        externalId: input.externalId,
        root: canonicalRoot,
        metadata: {
          privateHome: join(
            options.privateHomeRoot ??
              join(resolve(canonicalRoot, '..'), '.neondeck-workspace-homes'),
            input.externalId.replace(/[^A-Za-z0-9._-]/g, '-'),
          ),
        },
      };
    },
    async connect(resource) {
      const env = await containedLocalSandbox(resource).createSandbox({
        id: resource.externalId,
      });
      return { env, close: async () => undefined };
    },
    sandbox(resource) {
      return containedLocalSandbox(resource);
    },
    async inspect(resource) {
      try {
        await stat(resource.root);
        return { status: 'ready', message: 'Managed worktree is available.' };
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return { status: 'missing', message: 'Managed worktree is missing.' };
        }
        return {
          status: 'unavailable',
          message: sanitizeExecutionText(
            error instanceof Error ? error.message : String(error),
            16 * 1024,
          ).content,
        };
      }
    },
    async destroy(_resource: WorkspaceResource) {
      // The managed-worktree service owns local removal and its audit trail.
    },
  };
}

function containedLocalSandbox(resource: WorkspaceResource): SandboxFactory {
  const root = resource.root;
  const privateHome =
    typeof resource.metadata.privateHome === 'string'
      ? resource.metadata.privateHome
      : join(
          resolve(root, '..'),
          '.neondeck-workspace-homes',
          resource.externalId.replace(/[^A-Za-z0-9._-]/g, '-'),
        );
  const factory = boundedLocal({
    cwd: root,
    env: credentialStrippedEnvironment(privateHome),
  });
  return {
    ...factory,
    async createSandbox(options) {
      await mkdir(privateHome, { recursive: true, mode: 0o700 });
      const env = await factory.createSandbox(options);
      return containedSandbox(env, root);
    },
  };
}

function containedSandbox(env: Sandbox, root: string): Sandbox {
  const canonicalRoot = resolve(root);
  const containedPath = (candidate: string) => {
    const resolved = resolve(
      canonicalRoot,
      isAbsolute(candidate) ? relative(canonicalRoot, candidate) : candidate,
    );
    const fromRoot = relative(canonicalRoot, resolved);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      throw new Error(`Workspace path escapes the managed root: ${candidate}`);
    }
    return resolved;
  };
  const assertContainedPhysical = (candidate: string) => {
    const fromRoot = relative(canonicalRoot, candidate);
    if (
      fromRoot === '..' ||
      fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    ) {
      throw new Error(
        `Workspace path resolves outside the managed root: ${candidate}`,
      );
    }
    return candidate;
  };
  const existingPhysicalPath = async (candidate: string) =>
    assertContainedPhysical(await realpath(containedPath(candidate)));
  const nearestExistingPhysicalParent = async (candidate: string) => {
    const resolved = containedPath(candidate);
    let current = dirname(resolved);
    for (;;) {
      try {
        await lstat(current);
        assertContainedPhysical(await realpath(current));
        return resolved;
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        ) {
          throw error;
        }
        const parent = dirname(current);
        if (parent === current) throw error;
        current = parent;
      }
    }
  };
  const writablePhysicalPath = async (candidate: string) => {
    const resolved = containedPath(candidate);
    try {
      await lstat(resolved);
      return await existingPhysicalPath(resolved);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return nearestExistingPhysicalParent(resolved);
      }
      throw error;
    }
  };
  return {
    ...env,
    cwd: canonicalRoot,
    resolvePath: containedPath,
    async exec(command, options) {
      return env.exec(command, {
        ...options,
        cwd: await existingPhysicalPath(options?.cwd ?? canonicalRoot),
      });
    },
    readFile: async (path) => env.readFile(await existingPhysicalPath(path)),
    readFileBuffer: async (path) =>
      env.readFileBuffer(await existingPhysicalPath(path)),
    writeFile: async (path, content) =>
      env.writeFile(await writablePhysicalPath(path), content),
    stat: async (path) => env.stat(await existingPhysicalPath(path)),
    readdir: async (path) => env.readdir(await existingPhysicalPath(path)),
    async exists(path) {
      try {
        return await env.exists(await existingPhysicalPath(path));
      } catch {
        return false;
      }
    },
    mkdir: async (path, options) =>
      env.mkdir(await writablePhysicalPath(path), options),
    rm: async (path, options) => {
      const resolved = containedPath(path);
      await nearestExistingPhysicalParent(resolved);
      return env.rm(resolved, options);
    },
  };
}

function credentialStrippedEnvironment(privateHome: string) {
  const env: Record<string, string> = {
    HOME: privateHome,
    SSH_AUTH_SOCK: '',
    GIT_ASKPASS: process.platform === 'win32' ? 'NUL' : '/bin/false',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'tag.gpgsign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_SSH_COMMAND:
      'ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null',
  };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL']) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}
