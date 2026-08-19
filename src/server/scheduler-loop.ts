import { refreshGitHubQueueSnapshot } from '../modules/github';
import { refreshPrReviewRemoteState } from '../modules/pr-reviews';
import { runSchedulerTick } from '../modules/scheduler/service';
import { recoverInterruptedAutopilotOwners } from '../modules/autopilot/owner/settlement';
import type { RuntimePaths } from '../runtime-home';

const schedulerTicksInFlight = schedulerTickRegistry();
const schedulerLoopRegistry = schedulerLoops();

/**
 * Runs one deterministic scheduler tick per runtime home at a time.
 * Cross-process concurrency is guarded by the scheduler service's SQLite lease.
 */
export function runSerializedSchedulerTick(paths: RuntimePaths) {
  const inFlight = schedulerTicksInFlight.get(paths.home);
  if (inFlight) return inFlight;

  const next = (async () => {
    await recoverInterruptedAutopilotOwners(paths, {
      reclaimSettling: false,
    });
    return runSchedulerTick(paths);
  })().finally(() => {
    schedulerTicksInFlight.delete(paths.home);
  });
  schedulerTicksInFlight.set(paths.home, next);
  return next;
}

export function startSchedulerLoop(
  paths: RuntimePaths,
  intervalMs = 60_000,
  runTick: (paths: RuntimePaths) => Promise<void> = async (runtimePaths) => {
    await runSerializedSchedulerTick(runtimePaths);
  },
  refreshGitHubQueue: (paths: RuntimePaths) => Promise<void> = async (
    runtimePaths,
  ) => {
    await refreshGitHubQueueSnapshot(runtimePaths);
  },
  refreshPrReviews: (paths: RuntimePaths) => Promise<void> = async (
    runtimePaths,
  ) => {
    await refreshPrReviewRemoteState(runtimePaths);
  },
) {
  const existing = schedulerLoopRegistry.get(paths.home);
  if (existing) clearInterval(existing);

  let tickInFlight = false;
  const timer = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    void refreshGitHubQueue(paths).catch((error) => {
      console.warn('[neondeck] GitHub queue snapshot refresh failed', error);
    });
    void refreshPrReviews(paths).catch((error) => {
      console.warn('[neondeck] PR review state refresh failed', error);
    });
    void runTick(paths)
      .catch((error) => {
        console.error('[neondeck] scheduler tick failed', error);
      })
      .finally(() => {
        tickInFlight = false;
      });
  }, intervalMs);

  timer.unref?.();
  schedulerLoopRegistry.set(paths.home, timer);
  return timer;
}

function schedulerTickRegistry() {
  // SAFETY: this module exclusively owns the global registry and preserves the
  // map's key/value contract across application reloads.
  const target = globalThis as typeof globalThis & {
    __neondeckSchedulerTicksInFlight?: Map<
      string,
      ReturnType<typeof runSchedulerTick>
    >;
  };
  return (target.__neondeckSchedulerTicksInFlight ??= new Map());
}

function schedulerLoops() {
  // SAFETY: this module exclusively owns the global registry and preserves the
  // map's key/value contract across application reloads.
  const target = globalThis as typeof globalThis & {
    __neondeckSchedulerLoops?: Map<string, ReturnType<typeof setInterval>>;
  };
  return (target.__neondeckSchedulerLoops ??= new Map());
}
