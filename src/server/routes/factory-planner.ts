import { Hono } from 'hono';
import { createAgentRouter } from '@flue/runtime/routing';
import { FactoryPlanner } from '../../agents/factory-planner';
import {
  FactoryError,
  getBoundPlanningSession,
  stopFactoryPlanning,
} from '../../modules/factory';
import { type RuntimePaths } from '../../runtime-home';
/** All routes share the private application's authentication middleware. Only
 * registered task bindings reach Flue, including reads/aborts/attachments. */
export function createFactoryPlannerRoutes(paths: RuntimePaths) {
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof FactoryError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: 'Factory conversation unavailable.' }, 500),
  );
  app.use('/:id/*', async (c, next) => {
    getBoundPlanningSession(c.req.param('id')!, paths);
    return next();
  });
  app.use('/:id', async (c, next) => {
    getBoundPlanningSession(c.req.param('id')!, paths);
    return next();
  });
  app.get('/:id/session', (c) =>
    c.json(getBoundPlanningSession(c.req.param('id'), paths).session),
  );
  app.post('/:id', (c) =>
    c.json(
      {
        error:
          'Send through the task planning API so its revision and dispatch intent are captured.',
      },
      403,
    ),
  );
  app.post('/:id/abort', async (c) => {
    await stopFactoryPlanning(c.req.param('id'), paths);
    return c.json({ ok: true });
  });
  app.route('/', createAgentRouter(FactoryPlanner));
  return app;
}
