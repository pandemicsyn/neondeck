import { Hono } from 'hono';
import {
  checkForUpdates,
  dismissUpdate,
  readUpdateStatus,
} from '../../modules/updates';
import type { RuntimePaths } from '../../runtime-home';

export function createUpdateRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/', async (c) => c.json(await readUpdateStatus(paths)));

  routes.post('/check', async (c) => c.json(await checkForUpdates(paths)));

  routes.post('/:version/dismiss', async (c) => {
    try {
      return c.json(await dismissUpdate(c.req.param('version'), paths));
    } catch (error) {
      return c.json(
        { message: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  });

  return routes;
}
