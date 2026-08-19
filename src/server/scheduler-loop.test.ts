import { describe, expect, it, vi } from 'vitest';
import { runtimePaths } from '../runtime-home';
import { startSchedulerLoop } from './scheduler-loop';

describe('scheduler loop', () => {
  it('replaces the previous loop for the same runtime home', async () => {
    vi.useFakeTimers();
    const paths = runtimePaths('/tmp/neondeck-scheduler-loop-test');
    type LoopEffect = (paths: ReturnType<typeof runtimePaths>) => Promise<void>;
    const previousTick = vi.fn<LoopEffect>(async () => undefined);
    const replacementTick = vi.fn<LoopEffect>(async () => undefined);
    const refreshGitHubQueue = vi.fn<LoopEffect>(async () => undefined);
    const refreshPrReviews = vi.fn<LoopEffect>(async () => undefined);

    startSchedulerLoop(
      paths,
      1_000,
      previousTick,
      refreshGitHubQueue,
      refreshPrReviews,
    );
    const replacement = startSchedulerLoop(
      paths,
      1_000,
      replacementTick,
      refreshGitHubQueue,
      refreshPrReviews,
    );
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(previousTick).not.toHaveBeenCalled();
      expect(replacementTick).toHaveBeenCalledTimes(1);
      expect(refreshGitHubQueue).toHaveBeenCalledTimes(1);
      expect(refreshPrReviews).toHaveBeenCalledTimes(1);
    } finally {
      clearInterval(replacement);
      vi.useRealTimers();
    }
  });

  it('does not overlap ticks from the same loop', async () => {
    vi.useFakeTimers();
    const paths = runtimePaths('/tmp/neondeck-scheduler-loop-overlap-test');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    type LoopEffect = (paths: ReturnType<typeof runtimePaths>) => Promise<void>;
    const runTick = vi.fn<LoopEffect>(() => pending);
    const refreshGitHubQueue = vi.fn<LoopEffect>(async () => undefined);
    const refreshPrReviews = vi.fn<LoopEffect>(async () => undefined);
    const timer = startSchedulerLoop(
      paths,
      1_000,
      runTick,
      refreshGitHubQueue,
      refreshPrReviews,
    );

    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(runTick).toHaveBeenCalledTimes(1);
      release();
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runTick).toHaveBeenCalledTimes(2);
    } finally {
      clearInterval(timer);
      release();
      vi.useRealTimers();
    }
  });
});
