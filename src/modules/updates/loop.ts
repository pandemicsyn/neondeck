import type { RuntimePaths } from '../../runtime-home';
import { globalMap } from '../../lib/global-registry';
import {
  checkForUpdates,
  updateCheckIntervalMs,
  updateChecksEnabled,
} from './service';

type UpdateLoop = {
  initial: ReturnType<typeof setTimeout>;
  interval: ReturnType<typeof setInterval>;
};

const updateLoops = globalMap<string, UpdateLoop>('__neondeckUpdateLoops');

export function startUpdateCheckLoop(
  paths: RuntimePaths,
  options: {
    initialDelayMs?: number;
    intervalMs?: number;
    check?: typeof checkForUpdates;
  } = {},
) {
  const existing = updateLoops.get(paths.home);
  if (existing) {
    clearTimeout(existing.initial);
    clearInterval(existing.interval);
    updateLoops.delete(paths.home);
  }
  if (!updateChecksEnabled()) return null;
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
