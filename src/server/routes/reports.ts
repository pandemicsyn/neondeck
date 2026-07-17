import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { REPORT_DECK_CONTROLLER_SOURCE } from '../../lib/report-deck-controller';
import { stageDocsDriftFix } from '../../modules/docs-drift';
import { listReports, readReport, readReportHtml } from '../../modules/reports';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonObject } from '../http';

export const REPORT_DECK_CONTROLLER_HASH = createHash('sha256')
  .update(REPORT_DECK_CONTROLLER_SOURCE)
  .digest('base64');

const reportContentSecurityPolicy = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${REPORT_DECK_CONTROLLER_HASH}'`,
].join('; ');

export function createReportApiRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/reports', async (c) => {
    const kind = c.req.query('kind')?.trim() || undefined;
    const excludeKind = c.req.query('excludeKind')?.trim() || undefined;
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
        items: await listReports(paths, { kind, excludeKind, limit }),
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

  routes.get('/reports/:id', async (c) => {
    const id = c.req.param('id')?.trim();
    if (!id) {
      return c.json(
        {
          ok: false,
          action: 'reports_read',
          message: 'Report id is required.',
          item: null,
        },
        400,
      );
    }

    try {
      const item = await readReport(id, paths);
      if (!item) {
        return c.json(
          {
            ok: false,
            action: 'reports_read',
            message: 'Report not found.',
            item: null,
          },
          404,
        );
      }
      return c.json({
        ok: true,
        action: 'reports_read',
        item,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      return c.json(
        {
          ok: false,
          action: 'reports_read',
          message: error instanceof Error ? error.message : String(error),
          item: null,
        },
        400,
      );
    }
  });

  routes.post('/reports/:id/stage-docs-fix', async (c) => {
    const result = await stageDocsDriftFix(
      { ...(await safeJsonObject(c)), reportId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
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
        'content-security-policy': reportContentSecurityPolicy,
        'x-content-type-options': 'nosniff',
      });
    } catch {
      return c.text('Not found', 404);
    }
  });

  return routes;
}
