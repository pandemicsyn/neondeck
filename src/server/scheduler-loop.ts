import { refreshGitHubQueueSnapshot } from '../modules/github';
import { refreshPrReviewRemoteState } from '../modules/pr-reviews';
import { runSchedulerTick } from '../modules/scheduler/service';
import { recoverInterruptedAutopilotOwners } from '../modules/autopilot/owner/settlement';
import type { RuntimePaths } from '../runtime-home';

const schedulerTicksInFlight = new Map<
  string,
  ReturnType<typeof runSchedulerTick>
>();
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
  runTick: (
    paths: RuntimePaths,
  ) => Promise<unknown> = runSerializedSchedulerTick,
  refreshGitHubQueue: (
    paths: RuntimePaths,
  ) => Promise<unknown> = refreshGitHubQueueSnapshot,
  refreshPrReviews: (
    paths: RuntimePaths,
  ) => Promise<unknown> = refreshPrReviewRemoteState,
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

function schedulerLoops() {
  const target = globalThis as typeof globalThis & {
    __neondeckSchedulerLoops?: Map<string, ReturnType<typeof setInterval>>;
  };
  return (target.__neondeckSchedulerLoops ??= new Map());
}
