import { Hono } from 'hono';
import {
  listExecutionApprovals,
  requestExecutionApproval,
  resolveExecutionApproval,
  runApprovedExecution,
} from '../../modules/execution';
import { syncExeDevCheckout } from '../../modules/execution';
import {
  checkExecutionPolicy,
  readExecutionPolicy,
} from '../../modules/execution';
import type { RuntimePaths } from '../../runtime-home';
import { updateExecutionPolicy } from '../../modules/config';
import { safeJsonBody } from '../http';

export function createExecutionRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/policy', async (c) => {
    return c.json(await readExecutionPolicy(paths));
  });

  routes.post('/policy', async (c) => {
    const input = (await safeJsonBody(c)) as Parameters<
      typeof updateExecutionPolicy
    >[0];
    return c.json(await updateExecutionPolicy(input, paths));
  });

  routes.post('/check', async (c) => {
    const input = (await safeJsonBody(c)) as Parameters<
      typeof checkExecutionPolicy
    >[0];
    return c.json(await checkExecutionPolicy(input, paths));
  });

  routes.get('/approvals', async (c) => {
    const includeResolved = c.req.query('includeResolved') === '1';
    return c.json(await listExecutionApprovals(paths, { includeResolved }));
  });

  routes.post('/approvals', async (c) => {
    const result = await requestExecutionApproval(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/approvals/:id/resolve', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = await resolveExecutionApproval(
      { ...input, id: c.req.param('id') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/run', async (c) => {
    const result = await runApprovedExecution(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/exedev/sync-checkout', async (c) => {
    const result = await syncExeDevCheckout(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
