import { startFactoryWorker } from '../modules/factory-observability';
import type { RuntimePaths } from '../runtime-home';
import { tickFactoryDelivery } from '../modules/factory-delivery';

/** Completion-driven polling keeps publication and recovery ticks serialized.
 * Stopping waits for the current fenced operation and admits no successor. */
export function startFactoryDeliveryLoop(
  paths: RuntimePaths,
  intervalMs = 3000,
  tick = tickFactoryDelivery,
) {
  const health = startFactoryWorker(paths, 'delivery', intervalMs);
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
