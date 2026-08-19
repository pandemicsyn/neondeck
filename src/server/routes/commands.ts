import { Hono } from 'hono';
import { runNeonCommand, supportedCommands } from '../../modules/commands';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { isJsonString, safeJsonObject } from '../http';

type CommandInput = {
  command: string;
  sessionId?: string;
  surface?: string;
};

export function createCommandRoutes(paths: RuntimePaths = runtimePaths()) {
  const routes = new Hono();

  routes.get('/', (c) => {
    return c.json({ items: supportedCommands() });
  });

  routes.post('/run', async (c) => {
    const body = await safeJsonObject(c);
    const command = isJsonString(body.command) ? body.command : '';
    const input: CommandInput = { command };
    if (isJsonString(body.sessionId)) input.sessionId = body.sessionId;
    if (isJsonString(body.surface)) input.surface = body.surface;
    return c.json(await runNeonCommand(input, paths));
  });

  return routes;
}
