import { Hono } from 'hono';
import type { RuntimePaths } from '../../runtime-home';
import { runSerializedSchedulerTick } from '../scheduler-loop';

export function createSchedulerRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.post('/scheduler/tick', async (c) => {
    return c.json(await runSerializedSchedulerTick(paths));
  });

  return routes;
}
