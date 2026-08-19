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
  removePrWatch,
  setPrWatchPolling,
} from '../../modules/watches';
import { safeJsonBody, safeJsonObject } from '../http';
import {
  approvePrAutopilotChange,
  configurePrAutopilot,
  controlPrAutopilot,
  messagePrAutopilotOwner,
  readPrAutopilotStatus,
} from '../../modules/autopilot';

export function createWatchRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/watches', async (c) => {
    return c.json(await listPrWatches(paths));
  });

  routes.post('/watches', async (c) => {
    // SAFETY: addPrWatch validates the externally supplied watch contract.
    const input = (await safeJsonBody(c)) as Parameters<typeof addPrWatch>[0];
    const result = await addPrWatch(input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/watches/autopilot', async (c) => {
    // SAFETY: configurePrAutopilot validates the externally supplied policy.
    const result = await configurePrAutopilot(
      (await safeJsonBody(c)) as Parameters<typeof configurePrAutopilot>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/watches/:id/autopilot', async (c) => {
    const result = await readPrAutopilotStatus(
      { id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.post('/watches/:id/autopilot/control', async (c) => {
    // SAFETY: controlPrAutopilot validates the action and the route owns id.
    const result = await controlPrAutopilot(
      {
        ...(await safeJsonObject(c)),
        id: c.req.param('id'),
      } as Parameters<typeof controlPrAutopilot>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/watches/:id/autopilot/message', async (c) => {
    // SAFETY: messagePrAutopilotOwner validates the message and route owns id.
    const result = await messagePrAutopilotOwner(
      {
        ...(await safeJsonObject(c)),
        id: c.req.param('id'),
      } as Parameters<typeof messagePrAutopilotOwner>[0],
      paths,
    );
    return c.json(result, result.ok ? 202 : 400);
  });

  routes.post('/watches/:id/autopilot/approve', async (c) => {
    // SAFETY: approvePrAutopilotChange validates the request and the route owns id.
    const result = await approvePrAutopilotChange(
      {
        ...(await safeJsonObject(c)),
        id: c.req.param('id'),
      } as Parameters<typeof approvePrAutopilotChange>[0],
      paths,
    );
    return c.json(result, result.ok ? 202 : 409);
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
    // SAFETY: addRefWatch validates the externally supplied watch contract.
    const input = (await safeJsonBody(c)) as Parameters<typeof addRefWatch>[0];
    const result = await addRefWatch(input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/watches/:id/polling', async (c) => {
    // SAFETY: setPrWatchPolling validates the action and the route owns id.
    const input = {
      ...(await safeJsonObject(c)),
      id: c.req.param('id'),
    } as Parameters<typeof setPrWatchPolling>[0];
    const result = await setPrWatchPolling(input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/watches/:id', async (c) => {
    const result = await removePrWatch(
      { ...(await safeJsonObject(c)), id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
