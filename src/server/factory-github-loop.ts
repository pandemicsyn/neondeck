import { runFactoryWriteback } from '../modules/factory/writeback';
import { runFactoryGitHubSync } from '../modules/factory/github-reconcile';
import type { RuntimePaths } from '../runtime-home';
/** Deterministic source recovery; the existing Flue runtime owns model submissions. */
export function startFactoryGitHubLoop(
  paths: RuntimePaths,
  intervalMs = 15000,
) {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function tick() {
    if (controller.signal.aborted) return;
    pending = runFactoryGitHubSync(
      paths,
      undefined,
      AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
    )
      .then(() =>
        runFactoryWriteback(
          paths,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
        ),
      )
      .catch(() => {
        console.warn(
          '[factory] GitHub recovery failed; retained work will retry.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          timer = setTimeout(tick, intervalMs);
          timer.unref();
        }
      });
  }
  tick();
  return async () => {
    controller.abort();
    clearTimeout(timer);
    await pending;
  };
}
