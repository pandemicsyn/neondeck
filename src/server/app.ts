import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getMcpRegistry } from '../domains/mcp';
import { loadNeondeckEnv } from '../modules/runtime';
import {
  providerRuntimeRegistrations,
  readProviderConfigSync,
} from '../modules/repos';
import {
  ensureRuntimeHome,
  ensureRuntimeHomeSync,
  runtimePaths,
} from '../runtime-home';
import { startSchedulerLoop } from '../modules/scheduler';
import { createConfigEventRoutes } from './events/config-stream';
import { createNotificationEventRoutes } from './events/notification-stream';
import { createSessionEventRoutes } from './events/session-stream';
import {
  displayAssistantLearningMiddleware,
  installFlueObservationHandlers,
} from './learning-hooks';
import {
  requireFlueRunInspectionToken,
  requireLocalApiAccess,
} from './middleware';
import { createAutopilotRoutes } from './routes/autopilot';
import { createCommandRoutes } from './routes/commands';
import { createConfigRoutes } from './routes/config';
import { createExecutionRoutes } from './routes/execution';
import { createGitHubRoutes } from './routes/github';
import { createKiloRoutes } from './routes/kilo';
import { createLearningRoutes } from './routes/learning';
import { createMemoryRoutes } from './routes/memory';
import { createMetricsRoutes } from './routes/metrics';
import { createMcpRoutes } from './routes/mcp';
import { createNotificationRoutes } from './routes/notifications';
import { createRepoEditRoutes } from './routes/repo-edit';
import { createReposRoutes } from './routes/repos';
import { createRuntimeRoutes } from './routes/runtime';
import { createSafetyRoutes } from './routes/safety';
import { createSchedulerRoutes } from './routes/scheduler';
import { createSessionRoutes } from './routes/sessions';
import { createSkillRoutes } from './routes/skills';
import { createWatchRoutes } from './routes/watches';
import { createWorkflowRoutes } from './routes/workflows';
import { createWorktreeRoutes } from './routes/worktrees';

const paths = runtimePaths();
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
const staticRoot = './web/dist';

await ensureRuntimeHome(paths);
installFlueObservationHandlers(paths);

if (process.env.NEONDECK_DISABLE_SCHEDULER !== '1') {
  startSchedulerLoop(paths);
}
getMcpRegistry(paths).start();

app.use('/api/*', requireLocalApiAccess);

app.route('/api', createRuntimeRoutes(paths));
app.route('/api/events', createConfigEventRoutes());
app.route('/api/events', createNotificationEventRoutes());
app.route('/api/events', createSessionEventRoutes());
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
app.route('/api', createWatchRoutes(paths));
app.route('/api', createSchedulerRoutes(paths));
app.route('/api/notifications', createNotificationRoutes(paths));
app.route('/api', createMemoryRoutes(paths));
app.route('/api/learning', createLearningRoutes(paths));
app.route('/api/skills', createSkillRoutes(paths));
app.route('/api/commands', createCommandRoutes());
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

app.use('/assets/*', serveStatic({ root: staticRoot }));
app.get('/favicon.svg', serveStatic({ root: staticRoot, path: 'favicon.svg' }));
app.get('*', serveStatic({ root: staticRoot, path: 'index.html' }));

export default app;
