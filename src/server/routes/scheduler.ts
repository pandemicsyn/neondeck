import { Hono } from 'hono';
import { listSchedulerJobs, runSchedulerTick } from '../../modules/scheduler';
import type { RuntimePaths } from '../../runtime-home';

export function createSchedulerRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/jobs', async (c) => {
    return c.json(await listSchedulerJobs(paths));
  });

  routes.post('/scheduler/tick', async (c) => {
    return c.json(await runSchedulerTick(paths));
  });

  return routes;
}
