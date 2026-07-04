import { Hono } from 'hono';
import type { RuntimePaths } from '../../runtime-home';
import {
  cleanupWorktrees,
  createWorktree,
  listWorktrees,
  lockWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
} from '../../modules/worktrees';
import { safeJsonBody, safeJsonObject } from '../http';

export function createWorktreeRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/worktrees', async (c) => {
    return c.json(await listWorktrees(paths));
  });

  routes.post('/worktrees', async (c) => {
    const result = await createWorktree(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/worktrees/:id/status', async (c) => {
    const result = await readWorktreeStatus(
      { worktreeId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/worktrees/:id/sync', async (c) => {
    const result = await syncWorktree(
      { ...(await safeJsonObject(c)), worktreeId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/worktrees/:id/lock', async (c) => {
    const result = await lockWorktree(
      { ...(await safeJsonObject(c)), worktreeId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/worktree-locks/:id/release', async (c) => {
    const result = await releaseWorktreeLock(
      { ...(await safeJsonObject(c)), lockId: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/worktrees/cleanup', async (c) => {
    const result = await cleanupWorktrees(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
