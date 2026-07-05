import { Hono } from 'hono';
import { listReports, readReportHtml } from '../../modules/reports';
import type { RuntimePaths } from '../../runtime-home';

export function createReportApiRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/reports', async (c) => {
    const kind = c.req.query('kind')?.trim() || undefined;
    const limitText = c.req.query('limit');
    const limit = limitText ? Number(limitText) : undefined;
    if (
      limitText &&
      (limit === undefined || !Number.isFinite(limit) || limit <= 0)
    ) {
      return c.json(
        {
          ok: false,
          action: 'reports_list',
          message: 'Report limit must be a positive number.',
          items: [],
        },
        400,
      );
    }

    try {
      return c.json({
        ok: true,
        action: 'reports_list',
        items: await listReports(paths, { kind, limit }),
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      return c.json(
        {
          ok: false,
          action: 'reports_list',
          message: error instanceof Error ? error.message : String(error),
          items: [],
        },
        400,
      );
    }
  });

  return routes;
}

export function createReportFileRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/:id', async (c) => {
    const id = c.req.param('id')?.trim();
    if (!id) return c.text('Not found', 404);

    try {
      const result = await readReportHtml(id, paths);
      if (!result) return c.text('Not found', 404);
      return c.html(result.html, 200, {
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline';",
        'x-content-type-options': 'nosniff',
      });
    } catch {
      return c.text('Not found', 404);
    }
  });

  return routes;
}
