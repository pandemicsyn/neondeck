import { Hono } from 'hono';
import type { RuntimePaths } from '../../runtime-home';
import { readSafetyPolicy } from '../../safety';

export function createSafetyRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/policy', (c) => {
    return c.json(readSafetyPolicy(paths));
  });

  return routes;
}
