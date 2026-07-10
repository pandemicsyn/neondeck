import { Hono } from 'hono';
import {
  applyDashboardPreset,
  readProviderConfig,
  reloadConfig,
  updateAgentModels,
  updateDashboardLayout,
  updateProviderConfig,
  updateRepoAutopilotPolicy,
  updateWorktreePolicy,
} from '../../modules/config';
import { isRegisteredProvider } from '../../modules/repos';
import {
  ConfigValidationError,
  parseDashboardConfig,
  readRuntimeJson,
  type RuntimePaths,
} from '../../runtime-home';
import { safeJsonBody, safeJsonObject } from '../http';

export function createConfigRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/providers', async (c) => {
    return c.json(await readProviderConfig(paths));
  });

  routes.post('/config/reload', async (c) => {
    return c.json(await reloadConfig(paths));
  });

  routes.post('/models', async (c) => {
    return c.json(await updateAgentModels(await c.req.json(), paths));
  });

  routes.post('/providers/kilocode', async (c) => {
    const input = (await c.req.json()) as Record<string, unknown>;
    return c.json(
      await updateProviderConfig(
        {
          ...input,
          provider: 'kilocode',
        },
        paths,
      ),
    );
  });

  routes.post('/providers/:provider', async (c) => {
    const input = (await safeJsonObject(c)) as Record<string, unknown>;
    const provider = c.req.param('provider');
    if (!isRegisteredProvider(provider)) {
      return c.json(
        {
          ok: false,
          changed: false,
          action: 'config_update_provider',
          message: `Unsupported provider "${provider}".`,
        },
        400,
      );
    }

    return c.json(
      await updateProviderConfig(
        {
          ...input,
          provider,
        },
        paths,
      ),
    );
  });

  routes.post('/worktrees/policy', async (c) => {
    const input = (await safeJsonBody(c)) as Parameters<
      typeof updateWorktreePolicy
    >[0];
    const result = await updateWorktreePolicy(input, paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/repos/:repoId/autopilot-policy', async (c) => {
    const input = (await safeJsonObject(c)) as Record<string, unknown>;
    const result = await updateRepoAutopilotPolicy(
      { ...input, repoId: c.req.param('repoId') },
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.get('/dashboard/config', async (c) => {
    try {
      return c.json(
        await readRuntimeJson(paths.dashboard, parseDashboardConfig),
      );
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return c.json(
          {
            error: 'Invalid dashboard config',
            message: error.message,
            path: error.path,
          },
          500,
        );
      }

      throw error;
    }
  });

  routes.post('/dashboard/config', async (c) => {
    const result = await updateDashboardLayout(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/dashboard/preset', async (c) => {
    const result = await applyDashboardPreset(await safeJsonBody(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}
