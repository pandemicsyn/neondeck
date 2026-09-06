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
    pending = recover().finally(() => {
      if (!controller.signal.aborted) {
        timer = setTimeout(tick, intervalMs);
        timer.unref();
      }
    });
  }
  async function recover() {
    try {
      await runFactoryGitHubSync(
        paths,
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
      );
    } catch {
      console.warn(
        '[factory] GitHub source recovery failed; retained work will retry.',
      );
    }
    if (controller.signal.aborted) return;
    try {
      await runFactoryWriteback(
        paths,
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
      );
    } catch {
      console.warn(
        '[factory] GitHub writeback recovery failed; retained work will retry.',
      );
    }
  }
  tick();
  return async () => {
    controller.abort();
    clearTimeout(timer);
    await pending;
  };
}
