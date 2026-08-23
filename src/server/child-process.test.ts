import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { manageChildProcess } from './child-process';

describe('managed child process', () => {
  it('forwards one signal and removes handlers after exit', async () => {
    const child = fakeChild();
    const signals = new EventEmitter();
    const controller = manageChildProcess(child, { signalSource: signals });

    signals.emit('SIGINT');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');

    child.emit('exit', null, 'SIGINT');
    await expect(controller.exit).resolves.toEqual({
      code: null,
      signal: 'SIGINT',
    });
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('force-kills a child that does not stop before the timeout', async () => {
    const child = fakeChild();
    const controller = manageChildProcess(child, { shutdownTimeoutMs: 1 });
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') child.emit('exit', null, signal);
      return true;
    });

    await expect(controller.terminate('SIGTERM')).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('force-kills immediately when shutdown is requested twice', async () => {
    const child = fakeChild();
    const signals = new EventEmitter();
    const controller = manageChildProcess(child, {
      signalSource: signals,
      shutdownTimeoutMs: 10_000,
    });
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') child.emit('exit', null, signal);
      return true;
    });

    signals.emit('SIGINT');
    signals.emit('SIGINT');

    await expect(controller.exit).resolves.toEqual({
      code: null,
      signal: 'SIGKILL',
    });
    expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGKILL']]);
  });
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(() => true),
  });
}
