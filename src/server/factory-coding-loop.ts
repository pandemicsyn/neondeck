import { startFactoryWorker } from '../modules/factory-observability';
import type { RuntimePaths } from '../runtime-home';
import { tickFactoryCoding } from '../modules/factory/coding-service';
/** Recovery runs even while disabled. The settled tick schedules its successor,
 * so no polling interval can overlap itself. Shutdown never launches a model. */
export function startFactoryCodingLoop(
  paths: RuntimePaths,
  intervalMs = 3000,
  tick = tickFactoryCoding,
) {
  const health = startFactoryWorker(paths, 'coding', intervalMs);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  function run() {
    if (stopped) return;
    pending = health
      .tick(() => tick(paths))
      .finally(() => {
        if (!stopped) {
          health.scheduled();
          timer = setTimeout(run, intervalMs);
          timer.unref();
        }
      });
  }
  run();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
    health.stopped();
  };
}
