import type { RuntimePaths } from '../runtime-home';
import { tickFactoryDelivery } from '../modules/factory-delivery';

/** Completion-driven polling keeps publication and recovery ticks serialized.
 * Stopping waits for the current fenced operation and admits no successor. */
export function startFactoryDeliveryLoop(
  paths: RuntimePaths,
  intervalMs = 3000,
  tick = tickFactoryDelivery,
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  function run() {
    if (stopped) return;
    pending = tick(paths)
      .catch(() => {
        console.warn(
          '[factory] Delivery recovery needs attention; resources retained.',
        );
      })
      .finally(() => {
        if (!stopped) {
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
  };
}
