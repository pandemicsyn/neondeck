import { HTTPException } from 'hono/http-exception';
import * as v from 'valibot';
import { updateFactoryConfig } from '../../modules/config';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  FactoryError,
  factoryState,
  getFactoryWork,
  submitFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
  transitionFactoryWork,
  updateFactorySource,
} from '../../modules/factory';
import { runtimePaths } from '../../runtime-home';

// Mounted only behind the private app's local API middleware. No model tool
// registration; actor identity is server assigned, never taken from source text.
export function createFactoryRoutes(paths = runtimePaths()) {
  const routes = new Hono();
  routes.use('*', bodyLimit({ maxSize: 512 * 1024 }));
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof FactoryError)
      return c.json(
        { error: error.message, current: error.current },
        error.status,
      );
    if (v.isValiError(error))
      return c.json({ error: v.summarize(error.issues) }, 400);
    if (error instanceof SyntaxError)
      return c.json({ error: 'Invalid JSON request.' }, 400);
    console.error('[factory] Request failed', error);
    return c.json(
      { error: 'Factory request failed. Retry or check local runtime health.' },
      500,
    );
  });
  const actor = { kind: 'human' as const, id: 'local-operator' };
  routes.post('/config', async (c) =>
    c.json(updateFactoryConfig(await c.req.json(), paths)),
  );
  routes.get('/state', (c) => c.json(factoryState(paths)));
  routes.get('/work/:id', (c) =>
    c.json(getFactoryWork(c.req.param('id'), paths)),
  );
  routes.post('/work', async (c) =>
    c.json(submitFactoryWork(await c.req.json(), actor, paths)),
  );
  routes.post('/work/:id/spec', async (c) =>
    c.json(
      saveFactorySpec(c.req.param('id'), await c.req.json(), actor, paths),
    ),
  );
  routes.post('/work/:id/release', async (c) =>
    c.json(
      releaseFactoryWork(c.req.param('id'), await c.req.json(), actor, paths),
    ),
  );
  routes.post('/work/:id/transition', async (c) =>
    c.json(
      transitionFactoryWork(
        c.req.param('id'),
        await c.req.json(),
        actor,
        paths,
      ),
    ),
  );
  routes.post('/work/:id/source', async (c) =>
    c.json(
      updateFactorySource(c.req.param('id'), await c.req.json(), actor, paths),
    ),
  );
  return routes;
}
