import { Hono } from 'hono';
import * as v from 'valibot';
import type { RuntimePaths } from '../../runtime-home';
import {
  DiagnosticsError,
  getFactoryTaskTimeline,
  getFactoryDiagnosticsHealth,
  previewFactoryDiagnostics,
} from '../../modules/factory-diagnostics';
export function createFactoryDiagnosticsRoutes(paths: RuntimePaths) {
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof DiagnosticsError)
      return c.json({ error: error.message }, error.status);
    if (v.isValiError(error) || error instanceof SyntaxError)
      return c.json(
        { error: 'Invalid diagnostic request or retained record.' },
        400,
      );
    return c.json(
      {
        error:
          'Local diagnostics are unavailable. Check runtime-home initialization and database access.',
      },
      503,
    );
  });
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.get('/health', (c) =>
    c.json(getFactoryDiagnosticsHealth(paths, c.req.query('workId'))),
  );
  routes.get('/tasks/:id/timeline', (c) =>
    c.json(
      getFactoryTaskTimeline(
        c.req.param('id'),
        {
          limit: Number(c.req.query('limit') ?? 25),
          ...(c.req.query('cursor') !== undefined
            ? { cursor: c.req.query('cursor') }
            : {}),
        },
        paths,
      ),
    ),
  );
  routes.get('/tasks/:id/preview', (c) =>
    c.json(previewFactoryDiagnostics(c.req.param('id'), paths)),
  );
  return routes;
}
