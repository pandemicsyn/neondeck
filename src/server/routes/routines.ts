import { Hono } from 'hono';
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  readRoutine,
  runRoutineNow,
  setRoutineEnabled,
  updateRoutine,
} from '../../modules/routines';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonObject } from '../http';

export function createRoutineRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/routines', async (c) => {
    return c.json(await listRoutines(paths));
  });

  routes.post('/routines', async (c) => {
    const input = (await safeJsonObject(c)) as Parameters<
      typeof createRoutine
    >[0];
    const result = await createRoutine(
      {
        ...input,
        createdBy: 'user:api',
      },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/routines/:id', async (c) => {
    const result = await readRoutine(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });

  routes.post('/routines/:id', async (c) => {
    const result = await updateRoutine(
      c.req.param('id'),
      (await safeJsonObject(c)) as Parameters<typeof updateRoutine>[1],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/routines/:id/run', async (c) => {
    const result = await runRoutineNow(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/routines/:id/pause', async (c) => {
    const result = await setRoutineEnabled(c.req.param('id'), false, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/routines/:id/resume', async (c) => {
    const result = await setRoutineEnabled(c.req.param('id'), true, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.delete('/routines/:id', async (c) => {
    if (c.req.query('confirm') !== 'true') {
      return c.json(
        {
          ok: false,
          action: 'routine_delete',
          changed: false,
          message: 'Routine deletion requires confirm=true.',
          requires: ['confirm'],
        },
        400,
      );
    }
    const result = await deleteRoutine(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
