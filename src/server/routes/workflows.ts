import { Hono } from 'hono';
import { listWorkflowSummaries } from '../../modules/app-state';
import type { RuntimePaths } from '../../runtime-home';
import { readWorkflowObservability } from '../../modules/learning';

export function createWorkflowRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/summaries', async (c) => {
    return c.json({
      items: await listWorkflowSummaries(paths),
      fetchedAt: new Date().toISOString(),
    });
  });

  routes.get('/observability', async (c) => {
    return c.json(await readWorkflowObservability(paths));
  });

  return routes;
}
