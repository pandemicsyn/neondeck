import { Hono } from 'hono';
import {
  createAgentInstructionTask,
  createBriefingTask,
  listTaskRecords,
  readTaskRecord,
  removeTask,
  setTaskEnabled,
} from '../../modules/scheduled-tasks';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonObject } from '../http';

export function createScheduledTaskRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/scheduled-tasks', async (c) =>
    c.json(await listTaskRecords(paths)),
  );
  routes.post('/scheduled-tasks/briefings', async (c) => {
    const result = await createBriefingTask(await safeJsonObject(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });
  routes.post('/scheduled-tasks/instructions', async (c) => {
    const result = await createAgentInstructionTask(
      await safeJsonObject(c),
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });
  routes.get('/scheduled-tasks/:id', async (c) => {
    const result = await readTaskRecord(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.post('/scheduled-tasks/:id/pause', async (c) => {
    const result = await setTaskEnabled(c.req.param('id'), false, paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.post('/scheduled-tasks/:id/resume', async (c) => {
    const result = await setTaskEnabled(c.req.param('id'), true, paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.delete('/scheduled-tasks/:id', async (c) => {
    if (c.req.query('confirm') !== 'true') {
      return c.json(
        {
          ok: false,
          action: 'scheduled_task_delete',
          changed: false,
          message: 'Deleting a scheduled task requires confirm=true.',
          requires: ['confirm'],
        },
        400,
      );
    }
    const result = await removeTask(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });

  return routes;
}
