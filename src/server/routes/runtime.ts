import { Hono } from 'hono';
import {
  autopilotStateSchema,
  readAutopilotState,
} from '../../modules/autopilot/state';
import {
  localApiAuthHeader,
  localApiTokenQueryParam,
  readLocalApiToken,
} from '../../modules/runtime';
import type { RuntimePaths } from '../../runtime-home';
import { readRuntimeStatus } from '../../modules/runtime';
import * as v from 'valibot';

export function createRuntimeRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'neondeck',
      home: paths.home,
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );

  routes.get('/runtime/status', async (c) => {
    return c.json(await readRuntimeStatus(paths));
  });

  routes.get('/local-api/session', async (c) => {
    return c.json({
      ok: true,
      action: 'local_api_session_read',
      token: await readLocalApiToken(paths),
      header: localApiAuthHeader,
      queryParam: localApiTokenQueryParam,
    });
  });

  routes.get('/autopilot/state', async (c) => {
    return c.json(
      v.parse(autopilotStateSchema, await readAutopilotState(paths)),
    );
  });

  return routes;
}
