import { Hono } from 'hono';
import {
  readRepoHealthSnapshot,
  readRepoRegistrySnapshot,
} from '../../modules/repos';
import { ConfigValidationError, type RuntimePaths } from '../../runtime-home';

export function createReposRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    try {
      return c.json(await readRepoRegistrySnapshot(paths));
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json(
          {
            error: 'Invalid repo registry',
            message: error.message,
            path: error.path,
          },
          500,
        );
      }

      throw error;
    }
  });

  routes.get('/health', async (c) => {
    try {
      return c.json(await readRepoHealthSnapshot(paths));
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json(
          {
            error: 'Invalid repo registry',
            message: error.message,
            path: error.path,
          },
          500,
        );
      }

      throw error;
    }
  });

  return routes;
}
