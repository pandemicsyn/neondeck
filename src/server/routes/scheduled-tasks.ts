import { Hono } from 'hono';
import {
  createAgentInstructionTask,
  createBriefingTask,
  cleanupTaskRunWorkspace,
  listTaskRunRecords,
  listTaskRecords,
  readTaskRunRecord,
  readTaskRecord,
  removeTask,
  retainTaskRunWorkspace,
  scheduleTaskNow,
  setTaskEnabled,
  readScheduledTaskRun,
  listScheduledWorkspaceQuarantines,
  clearScheduledWorkspaceQuarantine,
} from '../../modules/scheduled-tasks';
import { createWorkspaceProviderRegistry } from '../../modules/workspace-providers';
import {
  parseAppConfig,
  readRuntimeJsonSync,
  type RuntimePaths,
} from '../../runtime-home';
import { safeJsonObject } from '../http';
import { runSerializedSchedulerTick } from '../scheduler-loop';

export function createScheduledTaskRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/scheduled-tasks', async (c) =>
    c.json(await listTaskRecords(paths)),
  );
  routes.get('/workspace-providers', async (c) => {
    const config = readRuntimeJsonSync(paths.config, parseAppConfig);
    const registry = createWorkspaceProviderRegistry(paths);
    const providers = await Promise.all(
      registry.list().map(async (descriptor) => {
        const provider = registry.get(descriptor.id);
        const [readiness, perRun, reuseTask, existing] = await Promise.all([
          provider.readiness(),
          provider.readiness({ lifecycle: 'per-run' }),
          provider.readiness({ lifecycle: 'reuse-task' }),
          provider.readiness({ lifecycle: 'existing' }),
        ]);
        return {
          descriptor,
          readiness,
          readinessByLifecycle: {
            'per-run': perRun,
            'reuse-task': reuseTask,
            existing,
          },
        };
      }),
    );
    return c.json({
      ok: true,
      action: 'workspace_provider_list',
      changed: false,
      message: 'Listed configured workspace providers.',
      defaultProviderId: 'local',
      defaultRemoteProviderId: config.workspaces?.defaultRemoteProvider ?? null,
      providers,
    });
  });
  routes.get('/scheduled-workspace-quarantines', async (c) =>
    c.json(await listScheduledWorkspaceQuarantines(paths)),
  );
  routes.post('/scheduled-workspace-quarantines/clear', async (c) => {
    const result = await clearScheduledWorkspaceQuarantine(
      await safeJsonObject(c),
      paths,
    );
    return c.json(result, result.ok ? 200 : 409);
  });
  routes.post('/scheduled-tasks/briefings', async (c) => {
    const result = await createBriefingTask(await safeJsonObject(c), paths);
    return c.json(result, result.ok ? 200 : 400);
  });
  routes.post('/scheduled-tasks/instructions', async (c) => {
    const result = await createAgentInstructionTask(
      await safeJsonObject(c),
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });
  routes.get('/scheduled-tasks/:id', async (c) => {
    const result = await readTaskRecord(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.get('/scheduled-tasks/:id/runs', async (c) => {
    const result = await listTaskRunRecords(c.req.param('id'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.get('/scheduled-task-runs/:runId', async (c) => {
    const result = await readTaskRunRecord(c.req.param('runId'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.post('/scheduled-tasks/:id/run', async (c) => {
    const result = await scheduleTaskNow(c.req.param('id'), paths);
    if (result.ok) void runSerializedSchedulerTick(paths);
    return c.json(result, result.ok ? 202 : 409);
  });
  routes.post('/scheduled-task-runs/:runId/retry', async (c) => {
    const run = await readScheduledTaskRun(c.req.param('runId'), paths);
    if (!run) {
      return c.json(
        { ok: false, message: 'Scheduled task run was not found.' },
        404,
      );
    }
    const result = await scheduleTaskNow(run.taskId, paths);
    if (result.ok) void runSerializedSchedulerTick(paths);
    return c.json(result, result.ok ? 202 : 409);
  });
  routes.post('/scheduled-task-runs/:runId/retain', async (c) => {
    const result = await retainTaskRunWorkspace(c.req.param('runId'), paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.post('/scheduled-task-runs/:runId/cleanup', async (c) => {
    const result = await cleanupTaskRunWorkspace(
      c.req.param('runId'),
      await safeJsonObject(c),
      paths,
    );
    return c.json(result, result.ok ? 200 : 409);
  });
  routes.post('/scheduled-tasks/:id/pause', async (c) => {
    const result = await setTaskEnabled(c.req.param('id'), false, paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.post('/scheduled-tasks/:id/resume', async (c) => {
    const result = await setTaskEnabled(c.req.param('id'), true, paths);
    return c.json(result, result.ok ? 200 : 404);
  });
  routes.delete('/scheduled-tasks/:id', async (c) => {
    if (c.req.query('confirm') !== 'true') {
      return c.json(
        {
          ok: false,
          action: 'scheduled_task_delete',
          changed: false,
          message: 'Deleting a scheduled task requires confirm=true.',
          requires: ['confirm'],
        },
        400,
      );
    }
    const result = await removeTask(c.req.param('id'), paths);
    return c.json(
      result,
      result.ok ? 200 : result.message.includes('was not found') ? 404 : 409,
    );
  });

  return routes;
}
