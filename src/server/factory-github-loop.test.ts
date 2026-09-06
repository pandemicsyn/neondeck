import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runFactoryGitHubSync } from '../modules/factory/github-reconcile';
import { runFactoryWriteback } from '../modules/factory/writeback';
import { runtimePaths } from '../runtime-home';
import { startFactoryGitHubLoop } from './factory-github-loop';

vi.mock('../modules/factory/github-reconcile', () => ({
  runFactoryGitHubSync: vi.fn(),
}));
vi.mock('../modules/factory/writeback', () => ({
  runFactoryWriteback: vi.fn(),
}));

const paths = runtimePaths('/tmp/factory-github-loop-fixture');
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(runFactoryGitHubSync).mockResolvedValue(undefined);
  vi.mocked(runFactoryWriteback).mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('runs independent writeback after source recovery fails', async () => {
  vi.mocked(runFactoryGitHubSync).mockRejectedValueOnce(
    new Error('invalid source state'),
  );
  stop = startFactoryGitHubLoop(paths, 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(runFactoryWriteback).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining('source recovery failed'),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(runFactoryGitHubSync).toHaveBeenCalledTimes(2);
  expect(runFactoryWriteback).toHaveBeenCalledTimes(2);
});

it('retries on the next tick after writeback fails', async () => {
  vi.mocked(runFactoryWriteback).mockRejectedValueOnce(
    new Error('invalid writeback state'),
  );
  stop = startFactoryGitHubLoop(paths, 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining('writeback recovery failed'),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(runFactoryGitHubSync).toHaveBeenCalledTimes(2);
  expect(runFactoryWriteback).toHaveBeenCalledTimes(2);
});

it.each(['resolve', 'reject'] as const)(
  'shutdown waits for source recovery to %s without starting writeback',
  async (outcome) => {
    const sync = Promise.withResolvers<void>();
    vi.mocked(runFactoryGitHubSync).mockReturnValue(sync.promise);
    stop = startFactoryGitHubLoop(paths, 1000);
    const signal = vi.mocked(runFactoryGitHubSync).mock.calls[0][2]!;
    let settled = false;
    const stopping = stop().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(runFactoryGitHubSync).toHaveBeenCalledTimes(1);
    expect(runFactoryWriteback).not.toHaveBeenCalled();
    if (outcome === 'resolve') sync.resolve();
    else sync.reject(new Error('interrupted'));
    await stopping;
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(true);
    expect(runFactoryGitHubSync).toHaveBeenCalledTimes(1);
    expect(runFactoryWriteback).not.toHaveBeenCalled();
  },
);

it('does not overlap components or ticks and waits for active writeback on shutdown', async () => {
  const sync = Promise.withResolvers<void>();
  const writeback = Promise.withResolvers<void>();
  vi.mocked(runFactoryGitHubSync).mockReturnValue(sync.promise);
  vi.mocked(runFactoryWriteback).mockReturnValue(writeback.promise);
  stop = startFactoryGitHubLoop(paths, 1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(runFactoryGitHubSync).toHaveBeenCalledTimes(1);
  expect(runFactoryWriteback).not.toHaveBeenCalled();
  sync.resolve();
  await vi.advanceTimersByTimeAsync(5000);
  expect(runFactoryGitHubSync).toHaveBeenCalledTimes(1);
  expect(runFactoryWriteback).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(runFactoryWriteback).mock.calls[0][2]!;
  let settled = false;
  const stopping = stop().then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(signal.aborted).toBe(true);
  expect(settled).toBe(false);
  writeback.resolve();
  await stopping;
  await vi.advanceTimersByTimeAsync(5000);
  expect(runFactoryGitHubSync).toHaveBeenCalledTimes(1);
  expect(runFactoryWriteback).toHaveBeenCalledTimes(1);
});

it('gives writeback a fresh bounded timeout after source recovery times out', async () => {
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('timeout')), ms);
    return controller.signal;
  });
  const signals: AbortSignal[] = [];
  const untilAborted = (signal?: AbortSignal) =>
    new Promise<void>((_, reject) => {
      if (!signal) throw new Error('missing recovery signal');
      signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  vi.mocked(runFactoryGitHubSync).mockImplementation((_paths, _io, signal) =>
    untilAborted(signal),
  );
  vi.mocked(runFactoryWriteback).mockImplementation((_paths, _io, signal) =>
    untilAborted(signal),
  );
  stop = startFactoryGitHubLoop(paths, 1000);
  await vi.advanceTimersByTimeAsync(45000);
  expect(signals[0].aborted).toBe(true);
  expect(runFactoryWriteback).toHaveBeenCalledTimes(1);
  expect(signals[1].aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(44999);
  expect(signals[1].aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signals[1].aborted).toBe(true);
  expect(AbortSignal.timeout).toHaveBeenNthCalledWith(1, 45000);
  expect(AbortSignal.timeout).toHaveBeenNthCalledWith(2, 45000);
  expect(runFactoryGitHubSync).toHaveBeenCalledTimes(1);
});
