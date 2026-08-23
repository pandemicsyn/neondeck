import type { RuntimePaths } from '../../runtime-home';
import {
  checkForUpdates,
  updateCheckIntervalMs,
  updateChecksEnabled,
} from './service';

const updateLoops = updateLoopRegistry();

export function startUpdateCheckLoop(
  paths: RuntimePaths,
  options: {
    initialDelayMs?: number;
    intervalMs?: number;
    check?: typeof checkForUpdates;
  } = {},
) {
  if (!updateChecksEnabled()) return null;
  const existing = updateLoops.get(paths.home);
  if (existing) {
    clearTimeout(existing.initial);
    clearInterval(existing.interval);
  }
  const check = options.check ?? checkForUpdates;
  const run = () => {
    void check(paths).catch((error) => {
      console.warn('[neondeck] update check failed', error);
    });
  };
  const initial = setTimeout(run, options.initialDelayMs ?? 5_000);
  const interval = setInterval(
    run,
    options.intervalMs ?? updateCheckIntervalMs,
  );
  initial.unref?.();
  interval.unref?.();
  updateLoops.set(paths.home, { initial, interval });
  return { initial, interval };
}

function updateLoopRegistry() {
  const target = globalThis as typeof globalThis & {
    __neondeckUpdateLoops?: Map<
      string,
      {
        initial: ReturnType<typeof setTimeout>;
        interval: ReturnType<typeof setInterval>;
      }
    >;
  };
  return (target.__neondeckUpdateLoops ??= new Map());
}
