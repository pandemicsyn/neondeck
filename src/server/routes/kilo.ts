import { Hono } from 'hono';
import {
  abortKiloTask,
  listKiloTasks,
  readKiloSession,
  readKiloSessionChildren,
  readKiloSessionDiff,
  readKiloSessionMessages,
  readKiloTaskDiff,
  readKiloTaskEvents,
  readKiloTaskSessions,
  readKiloTaskStatus,
  readUnavailableSessionAdapter,
  searchKiloSessions,
  startKiloTask,
} from '../../modules/kilo';
import {
  listKiloResultStates,
  promoteKiloResult,
  reviewKiloResult,
  verifyKiloResult,
} from '../../modules/kilo/results';
import type { RuntimePaths } from '../../runtime-home';
import {
  kiloSessionQuery,
  queryBoolean,
  queryNumber,
  safeJsonBody,
  safeJsonObject,
} from '../http';
import { recordHandledPrApiResult } from '../learning-hooks';

export function createKiloRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/tasks', async (c) => {
    return c.json(
      await listKiloTasks(
        {
          status: c.req.query('status'),
          repoId: c.req.query('repoId'),
          limit: queryNumber(c.req.query('limit')),
          includeDiff: queryBoolean(c.req.query('includeDiff')),
        },
        paths,
      ),
    );
  });

  routes.get('/results', async (c) => {
    const result = await listKiloResultStates(
      {
        taskId: c.req.query('taskId') || undefined,
        limit: queryNumber(c.req.query('limit')),
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/tasks', async (c) => {
    const result = await startKiloTask(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/tasks/:id', async (c) => {
    const result = await readKiloTaskStatus(
      { taskId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/tasks/:id/events', async (c) => {
    const result = await readKiloTaskEvents(
      { taskId: c.req.param('id'), limit: queryNumber(c.req.query('limit')) },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.post('/tasks/:id/abort', async (c) => {
    const result = await abortKiloTask({ taskId: c.req.param('id') }, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/tasks/:id/sessions', async (c) => {
    const result = await readKiloTaskSessions(
      { taskId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/tasks/:id/diff', async (c) => {
    const result = await readKiloTaskDiff({ taskId: c.req.param('id') }, paths);
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/tasks/:id/result', async (c) => {
    const result = await listKiloResultStates(
      { taskId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.post('/tasks/:id/review', async (c) => {
    const result = await reviewKiloResult({ taskId: c.req.param('id') }, paths);
    recordHandledPrApiResult(paths, 'api:kilo_result_review', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/tasks/:id/verify', async (c) => {
    const result = await verifyKiloResult(
      { ...(await safeJsonObject(c)), taskId: c.req.param('id') },
      paths,
    );
    recordHandledPrApiResult(paths, 'api:kilo_result_verify', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/tasks/:id/promote', async (c) => {
    const result = await promoteKiloResult(
      { taskId: c.req.param('id') },
      paths,
    );
    recordHandledPrApiResult(paths, 'api:kilo_result_promote', result);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/sessions/search', async (c) => {
    const result = await searchKiloSessions(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/sessions/:id', async (c) => {
    const result = await readKiloSession(
      { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/sessions/:id/messages', async (c) => {
    const result = await readKiloSessionMessages(
      { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/sessions/:id/children', async (c) => {
    const result = await readKiloSessionChildren(
      { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/sessions/:id/todos', async (c) => {
    const result = await readUnavailableSessionAdapter(
      { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
      'todos',
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.get('/sessions/:id/diff', async (c) => {
    const result = await readKiloSessionDiff(
      { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
      paths,
    );
    return c.json(result, result.ok ? 200 : 404);
  });

  return routes;
}
