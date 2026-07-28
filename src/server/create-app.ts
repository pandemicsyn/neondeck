import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { dashboardEventStreamPath } from '../../shared/dashboard-events';
import { getMcpRegistry } from '../domains/mcp';
import { installFlueExecutionContextTracker } from '../modules/flue/execution-context';
import { loadNeondeckEnv } from '../modules/runtime';
import {
  providerRuntimeRegistrations,
  readProviderConfigSync,
  resolveOpenAiCodexAccessToken,
  resolveOpenAiCodexProviderStatus,
  startOpenAiCodexTokenRefresh,
} from '../modules/repos';
import {
  ensureRuntimeHome,
  ensureRuntimeHomeSync,
  type RuntimePaths,
  runtimePaths,
} from '../runtime-home';
import { createEventStreamRoutes } from './events/event-stream';
import {
  displayAssistantLearningMiddleware,
  installFlueObservationHandlers,
} from './learning-hooks';
import {
  requireFlueRunInspectionToken,
  requireLocalApiAccess,
} from './middleware';
import { createBriefingRoutes } from './routes/briefings';
import { createCommandRoutes } from './routes/commands';
import { createConfigRoutes } from './routes/config';
import { createExecutionRoutes } from './routes/execution';
import { createGitHubRoutes } from './routes/github';
import { createHandoffRoutes } from './routes/handoff';
import { createKiloRoutes } from './routes/kilo';
import { createLearningRoutes } from './routes/learning';
import { createMemoryRoutes } from './routes/memory';
import { createMetricsRoutes } from './routes/metrics';
import { createMcpRoutes } from './routes/mcp';
import { createNotificationRoutes } from './routes/notifications';
import { createPreparedDiffRoutes } from './routes/prepared-diffs';
import { createRepoEditRoutes } from './routes/repo-edit';
import {
  createReportApiRoutes,
  createReportFileRoutes,
} from './routes/reports';
import { createReviewRoutes } from './routes/reviews';
import { createReposRoutes } from './routes/repos';
import { createReviewSurfaceRoutes } from './routes/review-surfaces';
import { createScheduledTaskRoutes } from './routes/scheduled-tasks';
import { createRuntimeRoutes } from './routes/runtime';
import { createSafetyRoutes } from './routes/safety';
import { createSchedulerRoutes } from './routes/scheduler';
import {
  resolveTransientSchedulerWorkflowNotification,
  startSchedulerObservedLoop,
} from './scheduler-workflow';
import { createSessionRoutes } from './routes/sessions';
import { createSkillRoutes } from './routes/skills';
import { createWatchRoutes } from './routes/watches';
import { createWorkflowRoutes } from './routes/workflows';
import { createWorktreeRoutes } from './routes/worktrees';
import { recoverInterruptedAutopilotOwners } from '../modules/autopilot/owner/settlement';
import { refreshGitHubQueueSnapshot } from '../modules/github';
import { refreshPrReviewRemoteState } from '../modules/pr-reviews';

export type CreateAppOptions = {
  paths?: RuntimePaths;
  staticRoot?: string;
  scheduler?: boolean;
};

export async function createApp(options: CreateAppOptions = {}) {
  const paths = options.paths ?? runtimePaths();
  process.env.NEONDECK_HOME = paths.home;
  ensureRuntimeHomeSync(paths);
  loadNeondeckEnv(paths);
  const appConfig = readProviderConfigSync(paths);
  for (const provider of providerRuntimeRegistrations(process.env, appConfig)) {
    registerProvider(provider.id, provider.registration);
  }
  if (resolveOpenAiCodexProviderStatus(appConfig).enabled) {
    let accessToken = '';
    try {
      accessToken =
        (await resolveOpenAiCodexAccessTokenForStartup(paths)) ?? '';
    } catch (error) {
      console.warn(
        '[neondeck] ChatGPT subscription authentication needs attention',
        error,
      );
    }
    registerProvider('openai-codex', { apiKey: accessToken });
    startOpenAiCodexTokenRefresh(paths, (token) => {
      registerProvider('openai-codex', { apiKey: token });
    });
  }

  const app = new Hono();
  const staticRoot = options.staticRoot ?? resolveStaticRoot();
  const requireRunInspection = requireFlueRunInspectionToken(paths);

  await ensureRuntimeHome(paths);
  installFlueExecutionContextTracker();
  await recoverInterruptedAutopilotOwners(paths);
  installFlueObservationHandlers(paths);

  if (
    options.scheduler !== false &&
    process.env.NEONDECK_DISABLE_SCHEDULER !== '1'
  ) {
    await resolveTransientSchedulerWorkflowNotification(paths);
    startSchedulerObservedLoop(paths);
    void refreshGitHubQueueSnapshot(paths).catch((error) => {
      console.warn('[neondeck] initial GitHub queue refresh failed', error);
    });
    void refreshPrReviewRemoteState(paths).catch((error) => {
      console.warn('[neondeck] initial PR review state refresh failed', error);
    });
  }
  await getMcpRegistry(paths).start();

  const requireAppAccess = requireLocalApiAccess({
    trustedOrigins: appConfig.server?.trustedOrigins,
  });
  app.use('/api/*', requireAppAccess);
  app.use('/reports/*', requireAppAccess);

  app.route('/api', createRuntimeRoutes(paths));
  app.route(dashboardEventStreamPath, createEventStreamRoutes());
  app.route('/api/safety', createSafetyRoutes(paths));
  app.route('/api/execution', createExecutionRoutes(paths));
  app.route('/api', createSessionRoutes(paths));
  app.route('/api', createConfigRoutes(paths));
  app.route('/api/metrics', createMetricsRoutes());
  app.route('/api/mcp', createMcpRoutes(paths));
  app.route('/api/repos', createReposRoutes(paths));
  app.route('/api', createRepoEditRoutes(paths));
  app.route('/api', createWorktreeRoutes(paths));
  app.route('/api/kilo', createKiloRoutes(paths));
  app.route('/api', createPreparedDiffRoutes(paths));
  app.route('/api', createBriefingRoutes(paths));
  app.route('/api', createHandoffRoutes(paths));
  app.route('/api', createWatchRoutes(paths));
  app.route('/api', createSchedulerRoutes(paths));
  app.route('/api', createScheduledTaskRoutes(paths));
  app.route('/api/notifications', createNotificationRoutes(paths));
  app.route('/api', createMemoryRoutes(paths));
  app.route('/api/learning', createLearningRoutes(paths));
  app.route('/api/skills', createSkillRoutes(paths));
  app.route('/api/commands', createCommandRoutes());
  app.route('/api', createReportApiRoutes(paths));
  app.route('/api', createReviewRoutes(paths));
  app.route('/api', createReviewSurfaceRoutes());
  app.use('/api/workflows/runs/*', requireRunInspection);
  app.route('/api/workflows', createWorkflowRoutes(paths));
  app.route('/api/github', createGitHubRoutes(paths));

  app.use(
    '/api/flue/agents/display-assistant/*',
    displayAssistantLearningMiddleware(paths),
  );

  app.use('/api/flue/runs', requireRunInspection);
  app.use('/api/flue/runs/*', requireRunInspection);
  app.route('/api/flue', flue());
  app.route('/reports', createReportFileRoutes(paths));

  app.use('/assets/*', serveStatic({ root: staticRoot }));
  app.get(
    '/manifest.webmanifest',
    serveStatic({ root: staticRoot, path: 'manifest.webmanifest' }),
  );
  app.use('/icons/*', serveStatic({ root: staticRoot }));
  app.get(
    '/favicon.svg',
    serveStatic({ root: staticRoot, path: 'favicon.svg' }),
  );
  app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

  return app;
}

export async function resolveOpenAiCodexAccessTokenForStartup(
  paths: RuntimePaths,
  timeoutMs = 5_000,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      resolveOpenAiCodexAccessToken(paths),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `ChatGPT subscription token refresh exceeded the ${timeoutMs}ms startup budget; Neondeck will retry in the background.`,
            ),
          );
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resolveStaticRoot(env = process.env) {
  const candidates = [
    env.NEONDECK_STATIC_ROOT,
    fileURLToPath(new URL('../../web/dist', import.meta.url)),
    fileURLToPath(new URL('../web/dist', import.meta.url)),
    './web/dist',
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
