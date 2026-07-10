import { Hono } from 'hono';
import type { RuntimePaths } from '../../runtime-home';
import {
  archiveChatSession,
  createChatSession,
  createChatSessionCommandEvent,
  linkChatSessionContext,
  listChatSessionCommandEvents,
  listChatSessions,
  pinChatSession,
  readChatSession,
  readChatSessionMessages,
  readNeonSessionState,
  referenceChatSession,
  renameChatSession,
  refreshChatSessionSummary,
  restoreChatSession,
  searchChatSessions,
  switchChatSession,
  updateChatSessionCommandEvent,
} from '../../modules/sessions';
import { safeJsonBody, safeJsonObject } from '../http';

export function createSessionRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/session', async (c) => {
    return c.json(await readNeonSessionState(paths, c.req.query('surface')));
  });

  routes.get('/sessions', async (c) => {
    return c.json(
      await listChatSessions(
        {
          includeArchived: c.req.query('includeArchived') === '1',
          kind: sessionKind(c.req.query('kind')),
          surface: c.req.query('surface') || undefined,
        },
        paths,
      ),
    );
  });

  routes.post('/sessions/search', async (c) => {
    const result = await searchChatSessions(
      (await safeJsonBody(c)) as Parameters<typeof searchChatSessions>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions', async (c) => {
    const result = await createChatSession(
      (await safeJsonBody(c)) as Parameters<typeof createChatSession>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/sessions/:id', async (c) => {
    const result = await readChatSession(
      {
        id: c.req.param('id'),
        surface: c.req.query('surface') || undefined,
        reason: c.req.query('reason') || undefined,
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/sessions/:id/messages', async (c) => {
    const rawLimit = Number(c.req.query('limit'));
    const result = await readChatSessionMessages(
      {
        id: c.req.param('id'),
        cursor: c.req.query('cursor') || undefined,
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
        surface: c.req.query('surface') || undefined,
        reason: c.req.query('reason') || undefined,
        explicitUserRequest: c.req.query('explicitUserRequest') === '1',
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 'requires' in result ? 400 : 404);
  });

  routes.get('/sessions/:id/command-events', async (c) => {
    const rawLimit = Number(c.req.query('limit'));
    const result = await listChatSessionCommandEvents(
      {
        sessionId: c.req.param('id'),
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.post('/sessions/:id/command-events', async (c) => {
    const result = await createChatSessionCommandEvent(
      {
        ...(await safeJsonObject(c)),
        sessionId: c.req.param('id'),
      } as Parameters<typeof createChatSessionCommandEvent>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/command-events/:eventId', async (c) => {
    const result = await updateChatSessionCommandEvent(
      {
        ...(await safeJsonObject(c)),
        sessionId: c.req.param('id'),
        eventId: c.req.param('eventId'),
      } as Parameters<typeof updateChatSessionCommandEvent>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/summary/refresh', async (c) => {
    const result = await refreshChatSessionSummary(
      {
        ...(await safeJsonObject(c)),
        id: c.req.param('id'),
      } as Parameters<typeof refreshChatSessionSummary>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/reference', async (c) => {
    const result = await referenceChatSession(
      {
        ...(await safeJsonObject(c)),
        id: c.req.param('id'),
      } as Parameters<typeof referenceChatSession>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/switch', async (c) => {
    const result = await switchChatSession(
      { ...(await safeJsonObject(c)), id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/rename', async (c) => {
    const result = await renameChatSession(
      {
        ...(await safeJsonObject(c)),
        id: c.req.param('id'),
      } as Parameters<typeof renameChatSession>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/pin', async (c) => {
    const result = await pinChatSession(
      {
        ...(await safeJsonObject(c)),
        id: c.req.param('id'),
      } as Parameters<typeof pinChatSession>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/archive', async (c) => {
    const result = await archiveChatSession(
      { ...(await safeJsonObject(c)), id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/restore', async (c) => {
    const result = await restoreChatSession(
      { ...(await safeJsonObject(c)), id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/:id/link-context', async (c) => {
    const result = await linkChatSessionContext(
      { ...(await safeJsonObject(c)), id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}

function sessionKind(value: string | undefined) {
  if (
    value === 'main' ||
    value === 'scratch' ||
    value === 'general' ||
    value === 'repo' ||
    value === 'watch' ||
    value === 'task' ||
    value === 'briefing'
  ) {
    return value;
  }

  return undefined;
}
