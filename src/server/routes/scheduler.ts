import { Hono } from 'hono';
import { listSchedulerJobs } from '../../modules/scheduler';
import type { RuntimePaths } from '../../runtime-home';
import { runObservedSchedulerTick } from '../scheduler-workflow';

export function createSchedulerRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/jobs', async (c) => {
    return c.json(await listSchedulerJobs(paths));
  });

  routes.post('/scheduler/tick', async (c) => {
    return c.json(await runObservedSchedulerTick(paths));
  });

  return routes;
}
