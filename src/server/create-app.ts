import { createAgentRouter } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { dashboardEventStreamPath } from '../../shared/dashboard-events';
import {
  DisplayAssistant,
  route as displayAssistantRoute,
} from '../agents/display-assistant';
import {
  PrAutopilotOwner,
  route as prAutopilotOwnerRoute,
} from '../agents/pr-autopilot-owner';
import { createPrReviewerRoute, PrReviewer } from '../agents/pr-reviewer';
import { getMcpRegistry } from '../domains/mcp';
import { installFlueExecutionContextTracker } from '../modules/flue/execution-context';
import { installNeondeckProviders } from '../modules/repos';
import {
  ensureRuntimeHome,
  ensureRuntimeHomeSync,
  type RuntimePaths,
  runtimePaths,
} from '../runtime-home';
import { createEventStreamRoutes } from './events/event-stream';
import { installFlueObservationHandlers } from './learning-hooks';
import { requireLocalApiAccess } from './middleware';
import { createActivityRoutes } from './routes/activity';
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
import { createOperationRoutes } from './routes/operations';
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
import { startSchedulerLoop } from './scheduler-loop';
import { createSessionRoutes } from './routes/sessions';
import { createSkillRoutes } from './routes/skills';
import { createWatchRoutes } from './routes/watches';
import { createWorktreeRoutes } from './routes/worktrees';
import { recoverInterruptedAutopilotOwners } from '../modules/autopilot/owner/settlement';
import { refreshGitHubQueueSnapshot } from '../modules/github';
import { refreshPrReviewRemoteState } from '../modules/pr-reviews';
import {
  installBriefingConversationHistoryReader,
  recoverInterruptedBriefingAdmissions,
} from '../modules/briefings';
import { recoverInterruptedLearningReviews } from '../modules/learning/reviews';

export type CreateAppOptions = {
  paths?: RuntimePaths;
  staticRoot?: string;
  scheduler?: boolean;
};

export async function createApp(options: CreateAppOptions = {}) {
  const paths = options.paths ?? runtimePaths();
  process.env.NEONDECK_HOME = paths.home;
  ensureRuntimeHomeSync(paths);
  const appConfig = await installNeondeckProviders(paths);

  const app = new Hono();
  const staticRoot = options.staticRoot ?? resolveStaticRoot();

  await ensureRuntimeHome(paths);
  installFlueExecutionContextTracker();
  await recoverInterruptedAutopilotOwners(paths);
  installFlueObservationHandlers(paths);
  const learningRecovery = await recoverInterruptedLearningReviews(paths);
  if (learningRecovery.failed.length > 0) {
    console.warn(
      '[neondeck] learning review recovery remains pending',
      learningRecovery.failed,
    );
  }

  if (
    options.scheduler !== false &&
    process.env.NEONDECK_DISABLE_SCHEDULER !== '1'
  ) {
    startSchedulerLoop(paths);
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
  app.route(
    '/api/mcp',
    createMcpRoutes(paths, {
      trustedOrigins: appConfig.server?.trustedOrigins,
    }),
  );
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
  app.route('/api/activity', createActivityRoutes(paths));
  app.route('/api/operations', createOperationRoutes(paths));
  app.route('/api', createMemoryRoutes(paths));
  app.route('/api/learning', createLearningRoutes(paths));
  app.route('/api/skills', createSkillRoutes(paths));
  app.route('/api/commands', createCommandRoutes(paths));
  app.route('/api', createReportApiRoutes(paths));
  app.route('/api', createReviewRoutes(paths));
  app.route('/api', createReviewSurfaceRoutes());
  app.route('/api/github', createGitHubRoutes(paths));

  app.use('/api/flue/agents/display-assistant/*', displayAssistantRoute);
  app.route(
    '/api/flue/agents/display-assistant',
    createAgentRouter(DisplayAssistant),
  );
  app.use('/api/flue/agents/pr-reviewer/*', createPrReviewerRoute(paths));
  app.route('/api/flue/agents/pr-reviewer', createAgentRouter(PrReviewer));
  app.use('/api/flue/agents/pr-autopilot-owner/:id', prAutopilotOwnerRoute);
  app.route(
    '/api/flue/agents/pr-autopilot-owner',
    createAgentRouter(PrAutopilotOwner),
  );

  const readBriefingConversationHistory = async (sessionId: string) => {
    const response = await app.request(
      `http://localhost/api/flue/agents/display-assistant/${encodeURIComponent(sessionId)}?view=history`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Flue conversation history returned ${response.status}.`);
    }
    return response.json();
  };
  installBriefingConversationHistoryReader(
    paths,
    readBriefingConversationHistory,
  );
  const briefingRecovery = await recoverInterruptedBriefingAdmissions(
    {
      readConversationHistory: readBriefingConversationHistory,
    },
    paths,
  );
  if (briefingRecovery.failed.length > 0) {
    console.warn(
      '[neondeck] briefing admission recovery remains pending',
      briefingRecovery.failed,
    );
  }
  app.route('/reports', createReportFileRoutes(paths));

  app.all('/api/*', (c) => c.notFound());

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
