import { Hono } from 'hono';
import {
  listPrWatchEventWatermarks,
  refreshPrWatchEventState,
} from '../../modules/pr-events';
import type { RuntimePaths } from '../../runtime-home';
import {
  addPrWatch,
  addRefWatch,
  listPrWatches,
  listRefWatches,
} from '../../modules/watches';
import { controlAutopilotWatch } from '../../modules/autopilot';
import { safeJsonBody, safeJsonObject } from '../http';

export function createWatchRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/watches', async (c) => {
    return c.json(await listPrWatches(paths));
  });

  routes.post('/watches', async (c) => {
    const input = (await safeJsonBody(c)) as Parameters<typeof addPrWatch>[0];
    const result = await addPrWatch(input, paths);
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
    const result = await refreshPrWatchEventState(
      { ...(await safeJsonObject(c)), watchId: c.req.param('id') },
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
    const result = await controlAutopilotWatch(
      {
        operation: body.enabled === true ? 'resume' : 'pause',
        watchId: c.req.param('id'),
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/watches/:id', async (c) => {
    const body = await safeJsonObject(c);
    const result = await controlAutopilotWatch(
      {
        operation: 'stop',
        watchId: c.req.param('id'),
        confirm: body.confirm === true,
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
