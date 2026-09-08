import {
  startFactoryWorker,
  withFactorySpan,
} from '../modules/factory-observability';
import { runFactoryLinearWriteback } from '../modules/factory/linear-writeback';
import { runFactoryLinearSync } from '../modules/factory/linear-reconcile';
import type { RuntimePaths } from '../runtime-home';
/** Deterministic source recovery; the existing Flue runtime owns model submissions. */
export function startFactoryLinearLoop(
  paths: RuntimePaths,
  intervalMs = 15000,
) {
  const health = startFactoryWorker(paths, 'linear', intervalMs);
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function tick() {
    if (controller.signal.aborted) return;
    pending = health.tick(recover).finally(() => {
      if (!controller.signal.aborted) {
        health.scheduled();
        timer = setTimeout(tick, intervalMs);
        timer.unref();
      }
    });
  }
  async function recover() {
    try {
      await withFactorySpan(paths, 'linear.sync', {}, () =>
        runFactoryLinearSync(
          paths,
          AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        ),
      );
    } catch (error) {
      health.failure(error);
    }
    if (controller.signal.aborted) return;
    try {
      await withFactorySpan(paths, 'linear.writeback-controller', {}, () =>
        runFactoryLinearWriteback(
          paths,
          AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        ),
      );
    } catch (error) {
      health.failure(error);
    }
  }
  tick();
  return async () => {
    controller.abort();
    clearTimeout(timer);
    await pending;
    health.stopped();
  };
}
