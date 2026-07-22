import { getRun } from '@flue/runtime';
import { Hono } from 'hono';
import { listWorkflowSummaries } from '../../modules/app-state';
import type { RuntimePaths } from '../../runtime-home';
import { readWorkflowObservability } from '../../modules/learning';

export function createWorkflowRoutes(
  paths: RuntimePaths,
  dependencies: { getRun?: typeof getRun } = {},
) {
  const routes = new Hono();
  const readRun = dependencies.getRun ?? getRun;

  routes.get('/summaries', async (c) => {
    return c.json({
      items: await listWorkflowSummaries(paths),
      fetchedAt: new Date().toISOString(),
    });
  });

  routes.get('/observability', async (c) => {
    return c.json(await readWorkflowObservability(paths));
  });

  routes.get('/runs/:runId', async (c) => {
    const run = await readRun(c.req.param('runId'));
    if (!run) {
      return c.json({ error: 'Workflow run not found.' }, 404);
    }
    return c.json({
      ok: true,
      action: 'workflow_run_inspection_read',
      run,
      fetchedAt: new Date().toISOString(),
    });
  });

  return routes;
}
