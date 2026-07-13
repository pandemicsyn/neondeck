import { Hono } from 'hono';
import {
  readBriefingRunDetails,
  readBriefingState,
  runBriefingNow,
  rotateBriefingSession,
  updateBriefingProfile,
} from '../../modules/briefings';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonObject } from '../http';

export function createBriefingRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/briefings', async (c) => c.json(await readBriefingState(paths)));
  routes.get('/briefings/runs/:id', async (c) => {
    const result = await readBriefingRunDetails(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.put('/briefings/profile', async (c) => {
    const result = await updateBriefingProfile(await safeJsonObject(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });
  routes.post('/briefings/run', async (c) => {
    const result = await runBriefingNow(await safeJsonObject(c), paths);
    return c.json(result, result.ok ? 202 : 400);
  });
  routes.post('/briefings/session/rotate', async (c) => {
    const result = await rotateBriefingSession(await safeJsonObject(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
