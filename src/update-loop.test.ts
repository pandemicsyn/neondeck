import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimePaths } from './runtime-home';
import {
  checkForUpdates,
  readUpdateStatus,
  startUpdateCheckLoop,
} from './modules/updates';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Neondeck update loop', () => {
  it('clears an existing loop when update checks become disabled', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NEONDECK_DISABLE_UPDATE_CHECK', '0');
    const paths = runtimePaths('/tmp/neondeck-update-loop-disable-test');
    const check = vi.fn<typeof checkForUpdates>(async () =>
      Promise.resolve({} as Awaited<ReturnType<typeof checkForUpdates>>),
    );
    const reconcile = vi.fn<typeof readUpdateStatus>(async () =>
      Promise.resolve({} as Awaited<ReturnType<typeof readUpdateStatus>>),
    );
    startUpdateCheckLoop(paths, {
      initialDelayMs: 100,
      intervalMs: 1_000,
      check,
      reconcile,
    });

    vi.stubEnv('NEONDECK_DISABLE_UPDATE_CHECK', '1');
    expect(startUpdateCheckLoop(paths, { check, reconcile })).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(check).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
