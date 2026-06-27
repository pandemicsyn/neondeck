import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { fetchGitHubLogin, fetchPullRequestQueue } from './github';
import { readHostMetrics } from './metrics';
import { readRepoRegistrySnapshot } from './repos';
import { listNotifications, markNotificationRead } from './app-state';
import {
  listSchedulerJobs,
  runSchedulerTick,
  startSchedulerLoop,
} from './scheduler';
import {
  ConfigValidationError,
  ensureRuntimeHome,
  parseDashboardConfig,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
import { listPrWatches } from './watch-actions';

const kiloApiKey = process.env.KILOCODE_API_KEY ?? process.env.KILO_API_KEY;
const kiloOrganizationId =
  process.env.KILOCODE_ORGANIZATION_ID ?? process.env.KILO_ORGANIZATION_ID;

registerProvider('kilocode', {
  api: 'openai-completions',
  baseUrl: 'https://api.kilo.ai/api/gateway',
  apiKey: kiloApiKey,
  headers: kiloOrganizationId
    ? { 'X-KiloCode-OrganizationId': kiloOrganizationId }
    : undefined,
});

const app = new Hono();

const staticRoot = './web/dist';
const paths = runtimePaths();

await ensureRuntimeHome(paths);
if (process.env.NEONDECK_DISABLE_SCHEDULER !== '1') {
  startSchedulerLoop(paths);
}

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'neondeck',
    home: paths.home,
    uptimeSeconds: Math.round(process.uptime()),
  }),
);

app.get('/api/dashboard/config', async (c) => {
  try {
    return c.json(await readRuntimeJson(paths.dashboard, parseDashboardConfig));
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

app.get('/api/metrics/host', async (c) => {
  return c.json(await readHostMetrics());
});

app.get('/api/repos', async (c) => {
  try {
    return c.json(await readRepoRegistrySnapshot(paths));
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return c.json(
        {
          error: 'Invalid repo registry',
          message: error.message,
          path: error.path,
        },
        500,
      );
    }

    throw error;
  }
});

app.get('/api/watches', async (c) => {
  return c.json(await listPrWatches(paths));
});

app.get('/api/jobs', async (c) => {
  return c.json(await listSchedulerJobs(paths));
});

app.post('/api/scheduler/tick', async (c) => {
  return c.json(await runSchedulerTick(paths));
});

app.get('/api/notifications', async (c) => {
  return c.json({
    items: await listNotifications(paths),
    fetchedAt: new Date().toISOString(),
  });
});

app.post('/api/notifications/:id/read', async (c) => {
  await markNotificationRead(c.req.param('id'), paths);
  return c.json({ ok: true });
});

app.get('/api/github/prs', async (c) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return c.json({ error: 'GITHUB_TOKEN is not configured', items: [] }, 503);
  }

  const login = process.env.GITHUB_LOGIN ?? (await fetchGitHubLogin(token));
  const registry = await readRepoRegistrySnapshot(paths);

  return c.json(
    await fetchPullRequestQueue({
      token,
      login,
      repos: registry.repos,
    }),
  );
});

app.route('/api/flue', flue());

app.use('/assets/*', serveStatic({ root: staticRoot }));
app.get('/favicon.svg', serveStatic({ root: staticRoot, path: 'favicon.svg' }));
app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

export default app;
