import { startFactoryCodingLoop } from './factory-coding-loop';
import { startFactoryDeliveryLoop } from './factory-delivery-loop';
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
type Stop = () => Promise<void>;

/** One service set after Flue initialization (and successful binds in production).
 * Register cleanup before startup so hosts retain ownership if rollback fails. */
export async function startManagedServices(
  paths: RuntimePaths,
  app: Fetchable,
  ownCleanup: (stop: Stop) => void = () => {},
) {
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let recovery: Promise<void> | undefined;
  const initialRefreshes: Promise<unknown>[] = [];
  const cleanup = new Set<() => void | Promise<void>>();
  const mcp = getMcpRegistry(paths);
  let mcpStopped = false;
  let stopping: Promise<void> | undefined;

  function stop(): Promise<void> {
    return (stopping ??= (async () => {
      stopped = true;
      clearTimeout(retry);
      const results = await Promise.allSettled(
        [...cleanup].map(async (dispose) => {
          await dispose();
          cleanup.delete(dispose);
        }),
      );
      await Promise.allSettled([recovery, ...initialRefreshes]);
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (!mcpStopped) {
        try {
          await mcp.stop();
          mcpStopped = true;
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Managed service cleanup failed.');
    })().finally(() => {
      stopping = undefined;
    }));
  }

  ownCleanup(stop);
  try {
    // createApp may be cached across HMR after the old owner's MCP shutdown.
    await mcp.start();
    cleanup.add(() => stopUpdateCheckLoop(paths));
    startUpdateCheckLoop(paths);
    if (process.env.NEONDECK_DISABLE_SCHEDULER !== '1') {
      cleanup.add(async () => {
        await stopSchedulerLoop(paths);
      });
      startSchedulerLoop(paths);
      initialRefreshes.push(
        refreshGitHubQueueSnapshot(paths).catch(() => undefined),
        refreshPrReviewRemoteState(paths).catch(() => undefined),
      );
    }
    cleanup.add(startFactoryCodingLoop(paths));
    cleanup.add(startFactoryDeliveryLoop(paths));
    cleanup.add(startFactoryGitHubLoop(paths));
    recover();
    return stop;
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Managed service startup and rollback failed.',
      );
    }
    throw error;
  }

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
}
