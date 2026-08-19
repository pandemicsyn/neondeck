import { Hono } from 'hono';
import { listWorkflowSummaries } from '../../modules/app-state';
import type { RuntimePaths } from '../../runtime-home';

export function createOperationRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/summaries', async (c) => {
    return c.json({
      items: await listWorkflowSummaries(paths),
      fetchedAt: new Date().toISOString(),
    });
  });

  return routes;
}
