import { Hono } from 'hono';
import { supportedCommands } from '../../commands';

export function createCommandRoutes() {
  const routes = new Hono();

  routes.get('/', (c) => {
    return c.json({ items: supportedCommands() });
  });

  return routes;
}
