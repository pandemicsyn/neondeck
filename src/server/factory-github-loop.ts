import {
  startFactoryWorker,
  withFactorySpan,
} from '../modules/factory-observability';
import { runFactoryWriteback } from '../modules/factory/writeback';
import { runFactoryGitHubSync } from '../modules/factory/github-reconcile';
import type { RuntimePaths } from '../runtime-home';
/** Deterministic source recovery; the existing Flue runtime owns model submissions. */
export function startFactoryGitHubLoop(
  paths: RuntimePaths,
  intervalMs = 15000,
) {
  const health = startFactoryWorker(paths, 'github', intervalMs);
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
      await withFactorySpan(paths, 'github.sync', {}, () =>
        runFactoryGitHubSync(
          paths,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        ),
      );
    } catch (error) {
      health.failure(error);
    }
    if (controller.signal.aborted) return;
    try {
      await withFactorySpan(paths, 'github.writeback-controller', {}, () =>
        runFactoryWriteback(
          paths,
          undefined,
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
