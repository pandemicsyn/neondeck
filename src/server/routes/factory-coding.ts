import { FactoryMutationLockError } from '../../modules/config/factory-mutation-lock';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { FactoryError } from '../../modules/factory/service';
import {
  factoryCodingState,
  saveFactoryCodingConfig,
  factoryCodingRuns,
  factoryCodingEvents,
  factoryCodingLogs,
  controlFactoryCoding,
} from '../../modules/factory/coding-operator';
import {
  publicCodingRun,
  requireCodingRun,
} from '../../modules/factory/coding-service';
export function createFactoryCodingRoutes(paths: RuntimePaths) {
  const routes = new Hono();
  routes.use('*', bodyLimit({ maxSize: 16384 }));
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof FactoryMutationLockError)
      return c.json({ error: error.message }, error.status);
    if (error instanceof FactoryError)
      return c.json({ error: error.message }, error.status);
    if (v.isValiError(error) || error instanceof SyntaxError)
      return c.json({ error: 'Invalid coding request.' }, 400);
    return c.json(
      {
        error:
          'Coding operation failed. Resources are retained; check status and reconcile.',
      },
      500,
    );
  });
  routes.get('/state', async (c) => c.json(await factoryCodingState(paths)));
  routes.post('/config', async (c) =>
    c.json(await saveFactoryCodingConfig(await c.req.json(), paths)),
  );
  routes.get('/runs', (c) =>
    c.json(
      factoryCodingRuns(
        {
          after: Number(c.req.query('after') ?? 0),
          limit: Number(c.req.query('limit') ?? 25),
          ...(c.req.query('workId')
            ? { workItemId: c.req.query('workId') }
            : {}),
        },
        paths,
      ),
    ),
  );
  routes.get('/runs/:id', (c) =>
    c.json(publicCodingRun(requireCodingRun(c.req.param('id'), paths), paths)),
  );
  routes.get('/runs/:id/events', (c) =>
    c.json(
      factoryCodingEvents(
        c.req.param('id'),
        {
          after: Number(c.req.query('after') ?? 0),
          limit: Number(c.req.query('limit') ?? 25),
        },
        paths,
      ),
    ),
  );
  routes.get('/runs/:id/logs', async (c) =>
    c.json(
      await factoryCodingLogs(
        c.req.param('id'),
        {
          offset: Number(c.req.query('offset') ?? 0),
          limit: Number(c.req.query('limit') ?? 16384),
        },
        paths,
      ),
    ),
  );
  routes.post('/runs/:id/cancel', async (c) =>
    c.json(
      await controlFactoryCoding(
        c.req.param('id'),
        await c.req.json(),
        'cancel',
        paths,
      ),
    ),
  );
  routes.post('/runs/:id/reconcile', async (c) =>
    c.json(
      await controlFactoryCoding(
        c.req.param('id'),
        await c.req.json(),
        'reconcile',
        paths,
      ),
    ),
  );
  return routes;
}
