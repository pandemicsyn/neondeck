import { Hono } from 'hono';
import { runNeonCommand, supportedCommands } from '../../modules/commands';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { safeJsonObject } from '../http';

export function createCommandRoutes(paths: RuntimePaths = runtimePaths()) {
  const routes = new Hono();

  routes.get('/', (c) => {
    return c.json({ items: supportedCommands() });
  });

  routes.post('/run', async (c) => {
    const body = await safeJsonObject(c);
    return c.json(
      await runNeonCommand(
        {
          command: typeof body.command === 'string' ? body.command : '',
          ...(typeof body.sessionId === 'string'
            ? { sessionId: body.sessionId }
            : {}),
          ...(typeof body.surface === 'string'
            ? { surface: body.surface }
            : {}),
        },
        paths,
      ),
    );
  });

  return routes;
}
