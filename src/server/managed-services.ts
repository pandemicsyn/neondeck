import { refreshGitHubQueueSnapshot } from '../modules/github';
import { refreshPrReviewRemoteState } from '../modules/pr-reviews';
import type { Fetchable } from '@flue/runtime/routing';
import { getMcpRegistry } from '../domains/mcp';
import {
  startUpdateCheckLoop,
  stopUpdateCheckLoop,
} from '../modules/updates/loop';
import type { RuntimePaths } from '../runtime-home';
import { recoverFlueRuntimeServices } from './create-app';
import { startSchedulerLoop, stopSchedulerLoop } from './scheduler-loop';
import { startFactoryGitHubLoop } from './factory-github-loop';
/** Production owns one service set, after Flue initialization and both successful binds. */
export function startManagedServices(paths: RuntimePaths, app: Fetchable) {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let recovery: Promise<void> | undefined;
  startUpdateCheckLoop(paths);
  const initialRefreshes: Promise<unknown>[] = [];
  if (process.env.NEONDECK_DISABLE_SCHEDULER !== '1') {
    startSchedulerLoop(paths);
    initialRefreshes.push(
      refreshGitHubQueueSnapshot(paths).catch(() => undefined),
      refreshPrReviewRemoteState(paths).catch(() => undefined),
    );
  }
  const stopSources = startFactoryGitHubLoop(paths);
  function recover() {
    if (stopped) return;
    recovery = recoverFlueRuntimeServices({
      paths,
      scheduler: false,
      readBriefingConversationHistory: async (id) => {
        const response = await app.fetch(
          new Request(
            `http://localhost/api/flue/agents/display-assistant/${encodeURIComponent(id)}?view=history`,
          ),
        );
        if (response.status === 404) return null;
        if (!response.ok) throw new Error('Conversation recovery read failed.');
        return response.json();
      },
    }).catch(() => {
      if (!stopped) {
        retry = setTimeout(recover, 30000);
        retry.unref();
      }
    });
  }
  recover();
  return async () => {
    stopped = true;
    clearTimeout(retry);
    stopUpdateCheckLoop(paths);
    await Promise.allSettled([
      stopSources(),
      stopSchedulerLoop(paths),
      recovery,
      ...initialRefreshes,
    ]);
    await getMcpRegistry(paths).stop();
  };
}
