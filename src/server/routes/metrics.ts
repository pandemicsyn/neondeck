import { Hono } from 'hono';
import { readHostMetrics } from '../../metrics';

export function createMetricsRoutes() {
  const routes = new Hono();

  routes.get('/host', async (c) => {
    return c.json(await readHostMetrics());
  });

  return routes;
}
