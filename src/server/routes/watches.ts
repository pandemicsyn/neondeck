import { Hono } from 'hono';
import {
  listPrWatchEventWatermarks,
  refreshPrWatchEventState,
} from '../../modules/pr-events';
import type { RuntimePaths } from '../../runtime-home';
import {
  addRefWatch,
  listPrWatches,
  listRefWatches,
  removePrWatch,
  setPrWatchPolling,
} from '../../modules/watches';
import {
  addPrWatchWithAutopilotLease,
  listAutopilotWatchBindings,
} from '../../modules/autopilot';
import { controlAutopilotWatchWithSetupLease } from '../../modules/autopilot/setup';
import {
  isAutopilotSetupBlocked,
  withAutopilotSetupWatchLease,
} from '../../modules/autopilot/setup-transactions';
import { safeJsonBody, safeJsonObject } from '../http';

export function createWatchRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/watches', async (c) => {
    return c.json(await listPrWatches(paths));
  });

  routes.post('/watches', async (c) => {
    const input = (await safeJsonBody(c)) as Parameters<
      typeof addPrWatchWithAutopilotLease
    >[0];
    const result = await addPrWatchWithAutopilotLease(input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/watches/events/watermarks', async (c) => {
    return c.json(
      await listPrWatchEventWatermarks(
        { watchId: c.req.query('watchId') || undefined },
        paths,
      ),
    );
  });

  routes.get('/watches/:id/events/watermarks', async (c) => {
    return c.json(
      await listPrWatchEventWatermarks({ watchId: c.req.param('id') }, paths),
    );
  });

  routes.post('/watches/:id/events/refresh', async (c) => {
    const id = c.req.param('id');
    const body = await safeJsonObject(c);
    const result = await refreshPrWatchEventState(
      { ...body, watchId: id },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/watches/ref', async (c) => {
    return c.json(await listRefWatches(paths));
  });

  routes.post('/watches/ref', async (c) => {
    const input = (await safeJsonBody(c)) as Parameters<typeof addRefWatch>[0];
    const result = await addRefWatch(input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/watches/:id/polling', async (c) => {
    const body = await safeJsonObject(c);
    const id = c.req.param('id');
    const response = await withAutopilotSetupWatchLease(id, paths, async () => {
      if (await isAutopilotSetupBlocked(id, paths))
        return blockedWatchResponse('watch_pr_polling_update');
      const bound = (await listAutopilotWatchBindings(paths)).some(
        (binding) => binding.owner.watchId === id,
      );
      const result = bound
        ? await controlAutopilotWatchWithSetupLease(
            {
              operation: body.enabled === true ? 'resume' : 'pause',
              watchId: id,
            },
            paths,
          )
        : await setPrWatchPolling(
            { id, enabled: body.enabled === true },
            paths,
          );
      return { status: result.ok ? (200 as const) : (400 as const), result };
    });
    return c.json(response.result, response.status);
  });

  routes.post('/watches/:id', async (c) => {
    const body = await safeJsonObject(c);
    const id = c.req.param('id');
    const response = await withAutopilotSetupWatchLease(id, paths, async () => {
      if (await isAutopilotSetupBlocked(id, paths))
        return blockedWatchResponse('watch_pr_remove');
      const bound = (await listAutopilotWatchBindings(paths)).some(
        (binding) => binding.owner.watchId === id,
      );
      const result = bound
        ? await controlAutopilotWatchWithSetupLease(
            { operation: 'stop', watchId: id, confirm: body.confirm === true },
            paths,
          )
        : await removePrWatch({ id, confirm: body.confirm === true }, paths);
      return { status: result.ok ? (200 as const) : (400 as const), result };
    });
    return c.json(response.result, response.status);
  });

  return routes;
}

function blockedWatchResponse(action: string) {
  return {
    status: 409 as const,
    result: {
      ok: false,
      action,
      changed: false,
      message: 'Watch controls are blocked until Autopilot setup recovers.',
      requires: ['retrySetup'],
    },
  };
}
