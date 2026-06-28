import { observe, registerProvider, type FlueObservation } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import { supportedCommands } from './commands';
import { fetchGitHubLogin, fetchPullRequestQueue } from './github';
import { readHostMetrics } from './metrics';
import { readRepoHealthSnapshot, readRepoRegistrySnapshot } from './repos';
import {
  addNotification,
  listNotifications,
  listWorkflowSummaries,
  markNotificationRead,
  setWorkflowSummaryRunId,
} from './app-state';
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
import {
  listRuntimeSkills,
  loadRuntimeSkill,
  reloadRuntimeSkills,
} from './runtime-skills';
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
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const requireLocalFlueAccess: MiddlewareHandler = async (c, next) => {
  const host = hostName(c.req.header('host'));
  if (host && localHosts.has(host)) {
    if (!isSafeMethod(c.req.method) && !isAllowedBrowserOrigin(c.req.raw)) {
      return c.json({ error: 'Not found' }, 404);
    }

    await next();
    return;
  }

  return c.json({ error: 'Not found' }, 404);
};

await ensureRuntimeHome(paths);
observe((event) => {
  if (event.type === 'run_end') {
    const summaryId = commandRunSummaryId(event);
    if (summaryId) {
      void setWorkflowSummaryRunId(summaryId, event.runId, paths).catch(
        (error) => {
          console.error('[neondeck] failed to attach Flue run id', error);
        },
      );
    }

    if (event.isError) {
      void addNotification(
        {
          level: 'attention',
          title: 'Workflow failed',
          message: `${workflowLabel(event)} failed.`,
          source: 'flue',
          sourceId: event.runId,
          data: {
            runId: event.runId,
            workflow: workflowLabel(event),
            error: errorMessage(event.error),
          },
        },
        paths,
      ).catch((error) => {
        console.error('[neondeck] failed to record Flue failure', error);
      });
    }

    return;
  }

  if (
    event.type === 'operation' &&
    event.durationMs > 15_000 &&
    event.isError
  ) {
    void addNotification(
      {
        level: 'attention',
        title: 'Slow Flue operation failed',
        message: `${event.operationKind} failed after ${Math.round(event.durationMs / 1000)}s.`,
        source: 'flue',
        sourceId: event.operationId,
        data: {
          operationKind: event.operationKind,
          durationMs: event.durationMs,
          error: errorMessage(event.error),
        },
      },
      paths,
    ).catch((error) => {
      console.error('[neondeck] failed to record Flue operation', error);
    });
  }
});

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

app.get('/api/repos/health', async (c) => {
  try {
    return c.json(await readRepoHealthSnapshot(paths));
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

app.get('/api/skills', async (c) => {
  return c.json(await listRuntimeSkills(paths));
});

app.get('/api/skills/:id', async (c) => {
  const result = await loadRuntimeSkill({ id: c.req.param('id') }, paths);
  if (!result.ok) {
    return c.json(result, 404);
  }

  return c.json(result);
});

app.post('/api/skills/reload', async (c) => {
  return c.json(await reloadRuntimeSkills(paths));
});

app.get('/api/commands', (c) => {
  return c.json({ items: supportedCommands() });
});

app.get('/api/workflows/summaries', async (c) => {
  return c.json({
    items: await listWorkflowSummaries(paths),
    fetchedAt: new Date().toISOString(),
  });
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

app.use('/api/flue/*', requireLocalFlueAccess);
app.route('/api/flue', flue());

app.use('/assets/*', serveStatic({ root: staticRoot }));
app.get('/favicon.svg', serveStatic({ root: staticRoot, path: 'favicon.svg' }));
app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

export default app;

function commandRunSummaryId(event: FlueObservation) {
  if (!('result' in event)) return undefined;
  const result = event.result;
  if (!result || typeof result !== 'object') return undefined;

  const summary = (result as { workflowSummary?: unknown }).workflowSummary;
  if (!summary || typeof summary !== 'object') return undefined;

  const id = (summary as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function workflowLabel(event: FlueObservation) {
  if ('workflow' in event && typeof event.workflow === 'string') {
    return event.workflow;
  }

  return `Workflow run ${event.runId ?? 'unknown'}`;
}

function errorMessage(error: unknown) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }

  return String(error);
}

function hostName(host: string | undefined) {
  if (!host) return undefined;
  const lower = host.toLowerCase();
  if (lower.startsWith('[')) {
    return lower.slice(0, lower.indexOf(']') + 1);
  }

  return lower.split(':')[0];
}

function isSafeMethod(method: string) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function isAllowedBrowserOrigin(request: Request) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return false;
  }

  const origin = request.headers.get('origin');
  if (origin) return isLocalUrl(origin);

  const referer = request.headers.get('referer');
  if (referer) return isLocalUrl(referer);

  return true;
}

function isLocalUrl(value: string) {
  try {
    const url = new URL(value);
    return localHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
