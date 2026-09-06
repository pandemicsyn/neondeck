import { createFactoryRoutes } from './routes/factory';
import { getAgentInstance } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import type { FlueConversationSnapshot } from '@flue/sdk';
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
import { createReviewTourRoutes } from './routes/review-tours';
import { createScheduledTaskRoutes } from './routes/scheduled-tasks';
import { createRuntimeRoutes } from './routes/runtime';
import { createSafetyRoutes } from './routes/safety';
import { createSchedulerRoutes } from './routes/scheduler';
import { startSchedulerLoop } from './scheduler-loop';
import { createSessionRoutes } from './routes/sessions';
import { createSkillRoutes } from './routes/skills';
import { createWatchRoutes } from './routes/watches';
import { createWorktreeRoutes } from './routes/worktrees';
import { createUpdateRoutes } from './routes/updates';
import { recoverPrReviewEvidenceFollowups } from './pr-review-submission-followups';
import { logApiRequests, logFlueActivity } from './request-logging';
import { recoverInterruptedAutopilotOwners } from '../modules/autopilot/owner/settlement';
import { refreshGitHubQueueSnapshot } from '../modules/github';
import { recoverPrReviewDeliveryFollowups } from '../modules/pr-events';
import { refreshPrReviewRemoteState } from '../modules/pr-reviews';
import {
  installBriefingConversationHistoryReader,
  recoverInterruptedBriefingAdmissions,
} from '../modules/briefings';
import { recoverInterruptedLearningReviews } from '../modules/learning/reviews';
import {
  admitPrReviewAssist,
  readPrReviewAssistSettlement,
  recoverInterruptedPrReviewAssists,
} from '../modules/pr-review-assist';
import { startUpdateCheckLoop } from '../modules/updates';

export type CreateAppOptions = {
  paths?: RuntimePaths;
  staticRoot?: string;
  scheduler?: boolean;
  runtimeServices?: boolean;
  requestLogging?: boolean;
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
  installFlueObservationHandlers(
    paths,
    options.requestLogging === true ? { logActivity: logFlueActivity } : {},
  );

  await getMcpRegistry(paths).start();

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

  const requireAppAccess = requireLocalApiAccess({
    trustedOrigins: appConfig.server?.trustedOrigins,
  });
  if (options.requestLogging === true) {
    app.use(
      '/api/*',
      logApiRequests({
        logSuccessfulReads: process.env.NEONDECK_LOG_LEVEL === 'debug',
      }),
    );
  }
  app.use('/api/*', requireAppAccess);
  app.use('/reports/*', requireAppAccess);

  app.route('/api', createRuntimeRoutes(paths));
  app.route(
    dashboardEventStreamPath,
    createEventStreamRoutes(
      undefined,
      options.requestLogging === true
        ? {
            onConnectionChange({ activeConnections, state }) {
              console.info(
                `[neondeck] DASHBOARD ${state} active=${activeConnections}`,
              );
            },
          }
        : {},
    ),
  );
  app.route('/api/factory', createFactoryRoutes(paths));
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
  app.route('/api/update-status', createUpdateRoutes(paths));
  app.route('/api/activity', createActivityRoutes(paths));
  app.route('/api/operations', createOperationRoutes(paths));
  app.route('/api', createMemoryRoutes(paths));
  app.route('/api', createReviewTourRoutes(paths));
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

  if (options.runtimeServices === true) {
    startUpdateCheckLoop(paths);
    const startRuntimeServices = createFlueRuntimeServiceStarter({
      paths,
      scheduler: options.scheduler !== false,
      readBriefingConversationHistory,
    });
    void startRuntimeServicesWhenAvailable(startRuntimeServices);
  }

  return app;
}

type FlueRuntimeReadinessProbe = () => Promise<unknown>;

export async function waitForFlueRuntime(
  probe: FlueRuntimeReadinessProbe = () =>
    getAgentInstance(DisplayAssistant, '__neondeck-runtime-readiness__'),
  retryDelayMs = 25,
) {
  let waitedForConfiguration = false;
  for (;;) {
    try {
      await probe();
      return waitedForConfiguration;
    } catch (error) {
      if (!isRuntimeNotConfiguredError(error)) throw error;
      waitedForConfiguration = true;
      await startupDelay(retryDelayMs);
    }
  }
}

function createFlueRuntimeServiceStarter(input: FlueRuntimeServiceInput) {
  let completed = false;
  let inFlight: Promise<void> | null = null;
  let retryDelayMs = 1_000;
  let schedulerStarted = false;

  function start() {
    if (completed || inFlight) return;
    inFlight = startFlueRuntimeServiceAttempt()
      .then(() => {
        completed = true;
        console.info('[neondeck] Runtime services ready');
      })
      .catch((error) => {
        console.warn(
          `[neondeck] Flue-backed runtime services will retry in ${retryDelayMs}ms`,
          error,
        );
        const timer = setTimeout(() => {
          inFlight = null;
          retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
          start();
        }, retryDelayMs);
        timer.unref?.();
      });
  }

  async function startFlueRuntimeServiceAttempt() {
    await waitForFlueRuntime();
    if (!schedulerStarted) {
      schedulerStarted = true;
      startFlueRuntimeScheduler(input);
    }
    await recoverFlueRuntimeServices(input);
  }

  return start;
}

async function startRuntimeServicesWhenAvailable(start: () => void) {
  await startupDelay(0);
  try {
    await waitForFlueRuntime();
  } catch {}
  start();
}

type FlueRuntimeServiceInput = {
  paths: RuntimePaths;
  scheduler: boolean;
  readBriefingConversationHistory: (
    sessionId: string,
  ) => Promise<FlueConversationSnapshot | null>;
};

function startFlueRuntimeScheduler(input: FlueRuntimeServiceInput) {
  if (input.scheduler && process.env.NEONDECK_DISABLE_SCHEDULER !== '1') {
    startSchedulerLoop(input.paths);
    console.info('[neondeck] Scheduler started');
    void refreshGitHubQueueSnapshot(input.paths).catch((error) => {
      console.warn('[neondeck] initial GitHub queue refresh failed', error);
    });
    void refreshPrReviewRemoteState(input.paths).catch((error) => {
      console.warn('[neondeck] initial PR review state refresh failed', error);
    });
  }
}

async function recoverFlueRuntimeServices(input: FlueRuntimeServiceInput) {
  const failures: Error[] = [];
  await captureRuntimeStartupFailure(
    'PR review submission follow-up recovery',
    failures,
    async () => {
      const deliveryResults = await recoverPrReviewDeliveryFollowups(
        input.paths,
      );
      const evidenceResults = await recoverPrReviewEvidenceFollowups(
        input.paths,
      );
      if ([...deliveryResults, ...evidenceResults].includes(false)) {
        throw new Error('One or more submission follow-ups remain pending.');
      }
    },
  );
  await captureRuntimeStartupFailure('Autopilot owner recovery', failures, () =>
    recoverInterruptedAutopilotOwners(input.paths),
  );

  const prReviewRecovery = await captureRuntimeStartupFailure(
    'PR review recovery',
    failures,
    () =>
      recoverInterruptedPrReviewAssists(
        input.paths,
        readPrReviewAssistSettlement,
        admitPrReviewAssist,
      ),
  );
  if (prReviewRecovery?.failed.length) {
    console.warn(
      '[neondeck] PR review admission recovery remains pending',
      prReviewRecovery.failed,
    );
    failures.push(new Error('PR review admission recovery remains pending.'));
  }

  const learningRecovery = await captureRuntimeStartupFailure(
    'Learning review recovery',
    failures,
    () => recoverInterruptedLearningReviews(input.paths),
  );
  if (learningRecovery?.failed.length) {
    console.warn(
      '[neondeck] learning review recovery remains pending',
      learningRecovery.failed,
    );
    failures.push(new Error('Learning review recovery remains pending.'));
  }

  const briefingRecovery = await captureRuntimeStartupFailure(
    'Briefing recovery',
    failures,
    () =>
      recoverInterruptedBriefingAdmissions(
        {
          readConversationHistory: input.readBriefingConversationHistory,
        },
        input.paths,
      ),
  );
  if (briefingRecovery?.failed.length) {
    console.warn(
      '[neondeck] briefing admission recovery remains pending',
      briefingRecovery.failed,
    );
    failures.push(new Error('Briefing admission recovery remains pending.'));
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      'Flue-backed runtime recovery is pending.',
    );
}

async function captureRuntimeStartupFailure<T>(
  label: string,
  failures: Error[],
  run: () => Promise<T>,
) {
  try {
    return await run();
  } catch (error) {
    const failure =
      error instanceof Error ? error : new Error(`${label}: ${String(error)}`);
    failures.push(failure);
    console.warn(`[neondeck] ${label} remains pending`, failure);
    return null;
  }
}

function isRuntimeNotConfiguredError(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes('before runtime was configured')
  );
}

function startupDelay(delayMs: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
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
