import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getMcpRegistry } from '../domains/mcp';
import { installFlueExecutionContextTracker } from '../modules/flue/execution-context';
import { loadNeondeckEnv } from '../modules/runtime';
import {
  providerRuntimeRegistrations,
  readProviderConfigSync,
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
import { createAutopilotRoutes } from './routes/autopilot';
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
import { createRepoEditRoutes } from './routes/repo-edit';
import {
  createReportApiRoutes,
  createReportFileRoutes,
} from './routes/reports';
import { createReviewRoutes } from './routes/reviews';
import { createReposRoutes } from './routes/repos';
import { createScheduledTaskRoutes } from './routes/scheduled-tasks';
import { createRuntimeRoutes } from './routes/runtime';
import { createSafetyRoutes } from './routes/safety';
import { createSchedulerRoutes } from './routes/scheduler';
import { startSchedulerObservedLoop } from './scheduler-workflow';
import { createSessionRoutes } from './routes/sessions';
import { createSkillRoutes } from './routes/skills';
import { createWatchRoutes } from './routes/watches';
import { createWorkflowRoutes } from './routes/workflows';
import { createWorktreeRoutes } from './routes/worktrees';

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
  const providerConfig = readProviderConfigSync(paths);
  for (const provider of providerRuntimeRegistrations(
    process.env,
    providerConfig,
  )) {
    registerProvider(provider.id, provider.registration);
  }

  const app = new Hono();
  const staticRoot = options.staticRoot ?? resolveStaticRoot();

  await ensureRuntimeHome(paths);
  installFlueExecutionContextTracker();
  installFlueObservationHandlers(paths);

  if (
    options.scheduler !== false &&
    process.env.NEONDECK_DISABLE_SCHEDULER !== '1'
  ) {
    startSchedulerObservedLoop(paths);
  }
  await getMcpRegistry(paths).start();

  app.use('/api/*', requireLocalApiAccess);
  app.use('/reports/*', requireLocalApiAccess);

  app.route('/api', createRuntimeRoutes(paths));
  app.route('/api/events', createEventStreamRoutes());
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
  app.route('/api', createAutopilotRoutes(paths));
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
  app.route('/api/workflows', createWorkflowRoutes(paths));
  app.route('/api/github', createGitHubRoutes(paths));

  app.use(
    '/api/flue/agents/display-assistant/*',
    displayAssistantLearningMiddleware(paths),
  );

  const requireRunInspection = requireFlueRunInspectionToken(paths);
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

export function resolveStaticRoot(env = process.env) {
  const candidates = [
    env.NEONDECK_STATIC_ROOT,
    fileURLToPath(new URL('../../web/dist', import.meta.url)),
    fileURLToPath(new URL('../web/dist', import.meta.url)),
    './web/dist',
  ].filter((value): value is string => Boolean(value));

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
