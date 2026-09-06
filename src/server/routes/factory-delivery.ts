import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import { FactoryError } from '../../modules/factory';
import {
  factoryDeliveryState,
  factoryDeliveryPreview,
  factoryDeliveryDetail,
  authorizeFactoryDelivery,
  revokeFactoryDelivery,
  factoryDeliveryList,
  reconcileFactoryDelivery,
  readDeliveryEvidence,
} from '../../modules/factory-delivery';

const services = {
  readDeliveryEvidence,
  factoryDeliveryState,
  factoryDeliveryPreview,
  factoryDeliveryDetail,
  authorizeFactoryDelivery,
  revokeFactoryDelivery,
  factoryDeliveryList,
  reconcileFactoryDelivery,
};
export function createFactoryDeliveryRoutes(
  paths: RuntimePaths,
  io: typeof services = services,
) {
  const routes = new Hono();
  routes.use('*', bodyLimit({ maxSize: 32768 }));
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof FactoryError)
      return c.json({ error: error.message }, error.status);
    if (v.isValiError(error) || error instanceof SyntaxError)
      return c.json({ error: 'Invalid delivery request.' }, 400);
    return c.json(
      {
        error:
          'Delivery could not complete. Resources and uncertain operations are retained.',
      },
      500,
    );
  });
  routes.get('/state', (c) => c.json(io.factoryDeliveryState(paths)));
  routes.get('/candidates/:runId', async (c) =>
    c.json(await io.factoryDeliveryPreview(c.req.param('runId'), paths)),
  );
  routes.get('/deliveries', (c) =>
    c.json(
      io.factoryDeliveryList(
        {
          after: Number(c.req.query('after') ?? 0),
          limit: Number(c.req.query('limit') ?? 25),
          ...(c.req.query('workItemId')
            ? { workItemId: c.req.query('workItemId') }
            : {}),
        },
        paths,
      ),
    ),
  );
  routes.get('/deliveries/:id', (c) =>
    c.json(io.factoryDeliveryDetail(c.req.param('id'), paths)),
  );
  routes.get('/deliveries/:id/evidence/:evidenceId', async (c) =>
    c.json(
      await io.readDeliveryEvidence(
        {
          deliveryId: c.req.param('id'),
          evidenceId: c.req.param('evidenceId'),
        },
        paths,
      ),
    ),
  );
  routes.post('/grants', async (c) =>
    c.json(await io.authorizeFactoryDelivery(await c.req.json(), paths)),
  );
  routes.post('/deliveries/:id/revoke', async (c) =>
    c.json(
      await io.revokeFactoryDelivery(
        c.req.param('id'),
        await c.req.json(),
        paths,
      ),
    ),
  );
  routes.post('/deliveries/:id/reconcile', async (c) =>
    c.json(
      await io.reconcileFactoryDelivery(
        c.req.param('id'),
        await c.req.json(),
        paths,
      ),
    ),
  );
  return routes;
}
