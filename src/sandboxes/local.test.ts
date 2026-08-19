import { describe, expect, it, vi } from 'vitest';
import type { Sandbox, SandboxFactory } from '@flue/runtime';
import {
  boundedLocal,
  defaultLocalShellTimeoutMs,
  withMaxShellTimeout,
} from './local';

describe('bounded local sandbox', () => {
  it('adds a default timeout and caps longer requested timeouts', async () => {
    const exec = vi.fn<Sandbox['exec']>(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }));
    const sandbox = withMaxShellTimeout(
      sandboxWithExec(exec),
      defaultLocalShellTimeoutMs,
    );
    const environment = await sandbox.createSandbox({ id: 'owner' });
    const signal = new AbortController().signal;

    await environment.exec('default');
    await environment.exec('shorter', { timeoutMs: 1_000, signal });
    await environment.exec('longer', {
      timeoutMs: defaultLocalShellTimeoutMs * 2,
    });

    expect(exec).toHaveBeenNthCalledWith(1, 'default', {
      timeoutMs: defaultLocalShellTimeoutMs,
    });
    expect(exec).toHaveBeenNthCalledWith(2, 'shorter', {
      timeoutMs: 1_000,
      signal,
    });
    expect(exec).toHaveBeenNthCalledWith(3, 'longer', {
      timeoutMs: defaultLocalShellTimeoutMs,
    });
  });

  it('keeps Flue local-shell cancellation effective', async () => {
    const sandbox = boundedLocal({
      cwd: process.cwd(),
      maxCommandTimeoutMs: 5_000,
    });
    const environment = await sandbox.createSandbox({ id: 'owner' });
    const controller = new AbortController();
    const command = environment.exec(`node -e "setInterval(() => {}, 1000)"`, {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 25);

    await expect(command).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects invalid maximum timeouts', () => {
    expect(() =>
      withMaxShellTimeout(
        sandboxWithExec(async () => ({
          stdout: '',
          stderr: '',
          exitCode: 0,
        })),
        0,
      ),
    ).toThrow(/positive safe integer/);
  });
});

function sandboxWithExec(exec: Sandbox['exec']): SandboxFactory {
  return {
    async createSandbox() {
      return {
        exec,
        readFile: async () => '',
        readFileBuffer: async () => new Uint8Array(),
        writeFile: async () => {},
        stat: async () => ({ isFile: false, isDirectory: false }),
        readdir: async () => [],
        exists: async () => false,
        mkdir: async () => {},
        rm: async () => {},
        cwd: '/workspace',
        resolvePath: (path: string) => path,
      };
    },
  };
}
