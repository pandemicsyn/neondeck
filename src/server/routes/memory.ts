import { Hono } from 'hono';
import {
  archiveMemory,
  deleteMemory,
  listMemories,
  listMemoryEvents,
  upsertMemory,
} from '../../modules/memory';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonBody } from '../http';

export function createMemoryRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/memories', async (c) => {
    const rawScope = c.req.query('scope');
    const scope = memoryScope(rawScope);
    const key = c.req.query('key');
    const rawStatus = c.req.query('status');
    const status = memoryStatus(rawStatus);
    if (rawScope && !scope) {
      return c.json(
        {
          ok: false,
          action: 'memory_list',
          changed: false,
          message: `Invalid memory scope "${rawScope}".`,
        },
        400,
      );
    }
    if (rawStatus && !status) {
      return c.json(
        {
          ok: false,
          action: 'memory_list',
          changed: false,
          message: `Invalid memory status "${rawStatus}".`,
        },
        400,
      );
    }

    return c.json(
      await listMemories(
        {
          scope,
          key: key || undefined,
          status,
          includeArchived: c.req.query('includeArchived') === 'true',
          repoId: c.req.query('repoId') || undefined,
        },
        paths,
      ),
    );
  });

  routes.post('/memories', async (c) => {
    return c.json(await upsertMemory(await c.req.json(), paths));
  });

  routes.delete('/memories', async (c) => {
    const scope = memoryScope(c.req.query('scope'));
    const key = c.req.query('key');
    if (!scope || !key) {
      return c.json(
        {
          ok: false,
          action: 'memory_delete',
          changed: false,
          message: 'Memory delete requires scope and key query parameters.',
        },
        400,
      );
    }

    const result = await deleteMemory(
      { scope, key, confirm: c.req.query('confirm') === 'true' },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/memories/:id/archive', async (c) => {
    const result = await archiveMemory(
      {
        ...((await safeJsonBody(c)) as Record<string, unknown>),
        id: c.req.param('id'),
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/memory-events', async (c) => {
    const limit = Number(c.req.query('limit') ?? '100');
    return c.json(
      await listMemoryEvents(
        {
          memoryId: c.req.query('memoryId') || undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
        },
        paths,
      ),
    );
  });

  return routes;
}

function memoryScope(value: string | undefined) {
  if (
    value === 'user' ||
    value === 'local' ||
    value === 'project' ||
    value === 'session' ||
    value === 'watch'
  ) {
    return value;
  }

  return undefined;
}

function memoryStatus(value: string | undefined) {
  if (value === 'active' || value === 'archived') return value;
  return undefined;
}
