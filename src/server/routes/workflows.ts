import { getRun } from '@flue/runtime';
import { Hono } from 'hono';
import { listWorkflowSummaries } from '../../modules/app-state';
import type { RuntimePaths } from '../../runtime-home';
import {
  readWorkflowObservability,
  readWorkflowRunEvents,
} from '../../modules/learning';

export function createWorkflowRoutes(
  paths: RuntimePaths,
  dependencies: {
    getRun?: typeof getRun;
    readRunEvents?: typeof readWorkflowRunEvents;
  } = {},
) {
  const routes = new Hono();
  const readRun = dependencies.getRun ?? getRun;
  const readRunEvents = dependencies.readRunEvents ?? readWorkflowRunEvents;

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
    const runId = c.req.param('runId');
    const run = await readRun(runId);
    if (!run) {
      return c.json({ error: 'Workflow run not found.' }, 404);
    }
    const eventHistory = await readRunEvents(runId, paths);
    return c.json({
      ok: true,
      action: 'workflow_run_inspection_read',
      run,
      events: eventHistory.events,
      eventHistory: {
        totalEventCount: eventHistory.totalEventCount,
        retainedEventCount: eventHistory.retainedEventCount,
        isTruncated: eventHistory.isTruncated,
      },
      fetchedAt: new Date().toISOString(),
    });
  });

  return routes;
}
