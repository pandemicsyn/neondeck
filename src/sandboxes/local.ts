import type { Sandbox, SandboxFactory } from '@flue/runtime';
import { local, type LocalSandboxOptions } from '@flue/runtime/node';

export const defaultLocalShellTimeoutMs = 10 * 60 * 1_000;

export type BoundedLocalSandboxOptions = LocalSandboxOptions & {
  maxCommandTimeoutMs?: number;
};

/**
 * Use Flue's trusted local sandbox while ensuring every shell command has a
 * deadline, even when the model omits the optional bash timeout parameter.
 *
 * Flue's local executor composes this timeout with the turn's AbortSignal and
 * terminates the spawned process group on either cancellation source.
 */
export function boundedLocal(
  options: BoundedLocalSandboxOptions = {},
): SandboxFactory {
  const { maxCommandTimeoutMs = defaultLocalShellTimeoutMs, ...localOptions } =
    options;
  return withMaxShellTimeout(local(localOptions), maxCommandTimeoutMs);
}

export function withMaxShellTimeout(
  sandbox: SandboxFactory,
  maxCommandTimeoutMs: number,
): SandboxFactory {
  if (!Number.isSafeInteger(maxCommandTimeoutMs) || maxCommandTimeoutMs <= 0) {
    throw new RangeError(
      'Local shell timeout must be a positive safe integer.',
    );
  }

  return {
    ...sandbox,
    async createSandbox(options): Promise<Sandbox> {
      const environment = await sandbox.createSandbox(options);
      return {
        ...environment,
        exec(command, execOptions) {
          const requestedTimeoutMs = execOptions?.timeoutMs;
          const timeoutMs =
            requestedTimeoutMs === undefined
              ? maxCommandTimeoutMs
              : Math.min(requestedTimeoutMs, maxCommandTimeoutMs);
          return environment.exec(command, {
            ...execOptions,
            timeoutMs,
          });
        },
      };
    },
  };
}
