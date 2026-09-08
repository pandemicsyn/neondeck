import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initializeAppDatabase } from '../runtime-home/app-db';
import { runtimePaths } from '../runtime-home';
import { getFactoryWorkerHealth } from '../modules/factory-observability';
import { runFactoryLinearSync } from '../modules/factory/linear-reconcile';
import { runFactoryLinearWriteback } from '../modules/factory/linear-writeback';
import { startFactoryLinearLoop } from './factory-linear-loop';
vi.mock('../modules/factory/linear-reconcile', () => ({
  runFactoryLinearSync: vi.fn(),
}));
vi.mock('../modules/factory/linear-writeback', () => ({
  runFactoryLinearWriteback: vi.fn(),
}));
let paths: ReturnType<typeof runtimePaths>;
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'factory-linear-loop-')));
  mkdirSync(paths.data, { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  vi.useFakeTimers();
  vi.mocked(runFactoryLinearSync).mockResolvedValue(undefined);
  vi.mocked(runFactoryLinearWriteback).mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  rmSync(paths.home, { recursive: true, force: true });
});
it('runs writeback independently after failed source sync and records its own health', async () => {
  vi.mocked(runFactoryLinearSync).mockRejectedValueOnce(new Error('failure'));
  stop = startFactoryLinearLoop(paths, 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(runFactoryLinearWriteback).toHaveBeenCalledTimes(1);
  expect(
    getFactoryWorkerHealth(paths).find((w) => w.worker === 'linear'),
  ).toMatchObject({ status: 'waiting', consecutiveFailures: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    getFactoryWorkerHealth(paths).find((w) => w.worker === 'linear'),
  ).toMatchObject({ status: 'waiting', consecutiveFailures: 0 });
  expect(runFactoryLinearSync).toHaveBeenCalledTimes(2);
});
it('does not overlap ticks and shutdown aborts and awaits active source work', async () => {
  let finish!: () => void;
  vi.mocked(runFactoryLinearSync).mockImplementation(
    (_paths, signal) =>
      new Promise<void>((resolve) => {
        finish = resolve;
        signal?.addEventListener('abort', resolve as () => void, {
          once: true,
        });
      }),
  );
  stop = startFactoryLinearLoop(paths, 1000);
  await vi.advanceTimersByTimeAsync(10000);
  expect(runFactoryLinearSync).toHaveBeenCalledTimes(1);
  await stop();
  stop = undefined;
  finish();
  expect(runFactoryLinearWriteback).not.toHaveBeenCalled();
  expect(
    getFactoryWorkerHealth(paths).find((w) => w.worker === 'linear')?.status,
  ).toBe('stopped');
});
