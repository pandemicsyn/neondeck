import { observe, registerProvider, type FlueObservation } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { supportedCommands } from './commands';
import {
  readProviderConfig,
  reloadConfig,
  updateDashboardLayout,
  updateExecutionPolicy,
  updateAgentModels,
  updateProviderConfig,
  applyDashboardPreset,
  updateWorktreePolicy,
} from './config-actions';
import {
  formatConfigServerSentEvent,
  replayConfigEventsAfter,
  subscribeConfigEvents,
} from './config-events';
import {
  formatNotificationServerSentEvent,
  subscribeNotificationEvents,
} from './notification-events';
import {
  formatChatSessionServerSentEvent,
  subscribeChatSessionEvents,
} from './session-events';
import {
  listExecutionApprovals,
  requestExecutionApproval,
  resolveExecutionApproval,
  runApprovedExecution,
} from './execution-actions';
import { checkExecutionPolicy, readExecutionPolicy } from './execution-policy';
import { loadNeondeckEnv } from './env';
import { listGitHubPrQueue } from './github-actions';
import { deleteMemory, listMemories, upsertMemory } from './memory-actions';
import { readHostMetrics } from './metrics';
import { readRepoHealthSnapshot, readRepoRegistrySnapshot } from './repos';
import {
  isRegisteredProvider,
  readProviderConfigSync,
  providerRuntimeRegistrations,
} from './providers';
import {
  listRepoEditEvents,
  patchRepoFiles,
  readRepoCheckoutStatus,
  readRepoDiff,
  readRepoFile,
  replaceRepoFile,
  searchRepoFiles,
  writeRepoFile,
} from './repo-edit';
import {
  addNotification,
  listNotifications,
  listWorkflowSummaries,
  markNotificationRead,
  resolveNotification,
  setWorkflowSummaryRunId,
} from './app-state';
import {
  listSchedulerJobs,
  runSchedulerTick,
  startSchedulerLoop,
} from './scheduler';
import {
  archiveChatSession,
  createChatSession,
  linkChatSessionContext,
  listChatSessions,
  pinChatSession,
  readChatSession,
  readChatSessionMessages,
  readNeonSessionState,
  renameChatSession,
  restoreChatSession,
  searchChatSessions,
  startNeonSession,
  switchChatSession,
} from './session-actions';
import {
  ConfigValidationError,
  ensureRuntimeHome,
  ensureRuntimeHomeSync,
  parseDashboardConfig,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
import { readRuntimeStatus } from './runtime-status';
import { readSafetyPolicy } from './safety';
import {
  listRuntimeSkills,
  loadRuntimeSkill,
  reloadRuntimeSkills,
} from './runtime-skills';
import { addRefWatch, listPrWatches, listRefWatches } from './watch-actions';
import {
  readWorkflowObservability,
  recordFlueObservation,
} from './workflow-observability';
import {
  cleanupWorktrees,
  createWorktree,
  listWorktrees,
  lockWorktree,
  readWorktreeStatus,
  releaseWorktreeLock,
  syncWorktree,
} from './worktrees';

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
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const configEventHeartbeatMs = 10_000;
const configEventStreamMaxAgeMs = 20_000;

const requireLocalApiAccess: MiddlewareHandler = async (c, next) => {
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
  void recordFlueObservation(event, paths).catch((error) => {
    console.error('[neondeck] failed to record Flue observation', error);
  });

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
            error: 'See guarded Flue run inspection for error details.',
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
          error: 'See workflow observability for error details.',
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

app.use('/api/*', requireLocalApiAccess);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'neondeck',
    home: paths.home,
    uptimeSeconds: Math.round(process.uptime()),
  }),
);

app.get('/api/runtime/status', async (c) => {
  return c.json(await readRuntimeStatus(paths));
});

app.get('/api/events/config', (c) => {
  const lastEventId = c.req.header('last-event-id');
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let active = true;
      function send(value: string) {
        if (!active) return;
        controller.enqueue(encoder.encode(value));
      }

      send('retry: 3000\n: connected\n\n');
      const unsubscribe = subscribeConfigEvents((event) => {
        send(formatConfigServerSentEvent(event));
      });
      for (const event of replayConfigEventsAfter(lastEventId)) {
        send(formatConfigServerSentEvent(event));
      }
      const heartbeat = setInterval(() => {
        send(`: heartbeat ${Date.now()}\n\n`);
      }, configEventHeartbeatMs);
      const maxAge = setTimeout(() => {
        send(': reconnecting\n\n');
        cleanup();
        controller.close();
      }, configEventStreamMaxAgeMs);

      cleanup = () => {
        if (!active) return;
        active = false;
        clearInterval(heartbeat);
        clearTimeout(maxAge);
        unsubscribe();
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
});

app.get('/api/events/notifications', () => {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      function send(value: string) {
        controller.enqueue(encoder.encode(value));
      }

      send(': connected\n\n');
      const unsubscribe = subscribeNotificationEvents((event) => {
        send(formatNotificationServerSentEvent(event));
      });
      const heartbeat = setInterval(() => {
        send(`: heartbeat ${Date.now()}\n\n`);
      }, 25_000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
});

app.get('/api/events/sessions', () => {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      function send(value: string) {
        controller.enqueue(encoder.encode(value));
      }

      send(': connected\n\n');
      const unsubscribe = subscribeChatSessionEvents((event) => {
        send(formatChatSessionServerSentEvent(event));
      });
      const heartbeat = setInterval(() => {
        send(`: heartbeat ${Date.now()}\n\n`);
      }, 25_000);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    },
  });
});

app.get('/api/safety/policy', (c) => {
  return c.json(readSafetyPolicy(paths));
});

app.get('/api/execution/policy', async (c) => {
  return c.json(await readExecutionPolicy(paths));
});

app.post('/api/execution/policy', async (c) => {
  const input = (await safeJsonBody(c)) as Parameters<
    typeof updateExecutionPolicy
  >[0];
  return c.json(await updateExecutionPolicy(input, paths));
});

app.post('/api/execution/check', async (c) => {
  const input = (await safeJsonBody(c)) as Parameters<
    typeof checkExecutionPolicy
  >[0];
  return c.json(await checkExecutionPolicy(input, paths));
});

app.get('/api/execution/approvals', async (c) => {
  const includeResolved = c.req.query('includeResolved') === '1';
  return c.json(await listExecutionApprovals(paths, { includeResolved }));
});

app.post('/api/execution/approvals', async (c) => {
  const result = await requestExecutionApproval(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/execution/approvals/:id/resolve', async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const result = await resolveExecutionApproval(
    { ...input, id: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/execution/run', async (c) => {
  const result = await runApprovedExecution(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/session', async (c) => {
  return c.json(await readNeonSessionState(paths, c.req.query('surface')));
});

app.post('/api/session/new', async (c) => {
  const input = (await c.req.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const result = await startNeonSession(input, paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/sessions', async (c) => {
  return c.json(
    await listChatSessions(
      {
        includeArchived: c.req.query('includeArchived') === '1',
        kind: sessionKind(c.req.query('kind')),
        surface: c.req.query('surface') || undefined,
      },
      paths,
    ),
  );
});

app.post('/api/sessions/search', async (c) => {
  const result = await searchChatSessions(
    (await safeJsonBody(c)) as Parameters<typeof searchChatSessions>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/sessions', async (c) => {
  const result = await createChatSession(
    (await safeJsonBody(c)) as Parameters<typeof createChatSession>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/sessions/:id', async (c) => {
  const result = await readChatSession(
    {
      id: c.req.param('id'),
      surface: c.req.query('surface') || undefined,
      reason: c.req.query('reason') || undefined,
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/sessions/:id/messages', async (c) => {
  const rawLimit = Number(c.req.query('limit'));
  const result = await readChatSessionMessages(
    {
      id: c.req.param('id'),
      cursor: c.req.query('cursor') || undefined,
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
      surface: c.req.query('surface') || undefined,
      reason: c.req.query('reason') || undefined,
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.post('/api/sessions/:id/switch', async (c) => {
  const result = await switchChatSession(
    { ...(await safeJsonObject(c)), id: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/sessions/:id/rename', async (c) => {
  const result = await renameChatSession(
    {
      ...(await safeJsonObject(c)),
      id: c.req.param('id'),
    } as Parameters<typeof renameChatSession>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/sessions/:id/pin', async (c) => {
  const result = await pinChatSession(
    {
      ...(await safeJsonObject(c)),
      id: c.req.param('id'),
    } as Parameters<typeof pinChatSession>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/sessions/:id/archive', async (c) => {
  const result = await archiveChatSession(
    { ...(await safeJsonObject(c)), id: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/sessions/:id/restore', async (c) => {
  const result = await restoreChatSession(
    { ...(await safeJsonObject(c)), id: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/sessions/:id/link-context', async (c) => {
  const result = await linkChatSessionContext(
    { ...(await safeJsonObject(c)), id: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/providers', async (c) => {
  return c.json(await readProviderConfig(paths));
});

app.post('/api/config/reload', async (c) => {
  return c.json(await reloadConfig(paths));
});

app.post('/api/models', async (c) => {
  return c.json(await updateAgentModels(await c.req.json(), paths));
});

app.post('/api/providers/kilocode', async (c) => {
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

app.post('/api/providers/:provider', async (c) => {
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

app.post('/api/worktrees/policy', async (c) => {
  const input = (await safeJsonBody(c)) as Parameters<
    typeof updateWorktreePolicy
  >[0];
  const result = await updateWorktreePolicy(input, paths);
  return c.json(result, result.ok ? 200 : 400);
});

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

app.post('/api/dashboard/config', async (c) => {
  const result = await updateDashboardLayout(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/dashboard/preset', async (c) => {
  const result = await applyDashboardPreset(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
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

app.get('/api/repos/:repoId/status', async (c) => {
  const result = await readRepoCheckoutStatus(
    { repoId: c.req.param('repoId') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/read', async (c) => {
  const result = await readRepoFile(
    { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/search', async (c) => {
  const result = await searchRepoFiles(
    { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/write/preview', async (c) => {
  const result = await writeRepoFile(
    {
      ...(await safeJsonObject(c)),
      repoId: c.req.param('repoId'),
      dryRun: true,
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/write', async (c) => {
  const result = await writeRepoFile(
    { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/replace/preview', async (c) => {
  const result = await replaceRepoFile(
    {
      ...(await safeJsonObject(c)),
      repoId: c.req.param('repoId'),
      dryRun: true,
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/replace', async (c) => {
  const result = await replaceRepoFile(
    { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/patch/preview', async (c) => {
  const result = await patchRepoFiles(
    {
      ...(await safeJsonObject(c)),
      repoId: c.req.param('repoId'),
      dryRun: true,
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/files/patch', async (c) => {
  const result = await patchRepoFiles(
    { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/repos/:repoId/diff', async (c) => {
  const result = await readRepoDiff(
    { ...(await safeJsonObject(c)), repoId: c.req.param('repoId') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/repo-edits', async (c) => {
  return c.json(await listRepoEditEvents(paths));
});

app.get('/api/worktrees', async (c) => {
  return c.json(await listWorktrees(paths));
});

app.post('/api/worktrees', async (c) => {
  const result = await createWorktree(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/worktrees/:id/status', async (c) => {
  const result = await readWorktreeStatus(
    { worktreeId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/worktrees/:id/sync', async (c) => {
  const result = await syncWorktree(
    { ...(await safeJsonObject(c)), worktreeId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/worktrees/:id/lock', async (c) => {
  const result = await lockWorktree(
    { ...(await safeJsonObject(c)), worktreeId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/worktree-locks/:id/release', async (c) => {
  const result = await releaseWorktreeLock(
    { ...(await safeJsonObject(c)), lockId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/worktrees/cleanup', async (c) => {
  const result = await cleanupWorktrees(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/watches', async (c) => {
  return c.json(await listPrWatches(paths));
});

app.get('/api/watches/ref', async (c) => {
  return c.json(await listRefWatches(paths));
});

app.post('/api/watches/ref', async (c) => {
  const input = (await safeJsonBody(c)) as Parameters<typeof addRefWatch>[0];
  const result = await addRefWatch(input, paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/jobs', async (c) => {
  return c.json(await listSchedulerJobs(paths));
});

app.post('/api/scheduler/tick', async (c) => {
  return c.json(await runSchedulerTick(paths));
});

app.get('/api/notifications', async (c) => {
  const includeResolved = c.req.query('includeResolved') === '1';
  return c.json({
    items: await listNotifications(paths, { includeResolved }),
    policy: notificationPolicy(),
    fetchedAt: new Date().toISOString(),
  });
});

app.post('/api/notifications/:id/read', async (c) => {
  await markNotificationRead(c.req.param('id'), paths);
  return c.json({ ok: true });
});

app.post('/api/notifications/:id/resolve', async (c) => {
  await resolveNotification(c.req.param('id'), paths);
  return c.json({ ok: true });
});

app.get('/api/memories', async (c) => {
  const rawScope = c.req.query('scope');
  const scope = memoryScope(rawScope);
  const key = c.req.query('key');
  if (rawScope && !scope) {
    return c.json(
      {
        ok: false,
        action: 'memory_list',
        changed: false,
        message: `Invalid memory scope "${rawScope}".`,
      },
      400,
    );
  }

  return c.json(
    await listMemories(
      {
        scope,
        key: key || undefined,
      },
      paths,
    ),
  );
});

app.post('/api/memories', async (c) => {
  return c.json(await upsertMemory(await c.req.json(), paths));
});

app.delete('/api/memories', async (c) => {
  const scope = memoryScope(c.req.query('scope'));
  const key = c.req.query('key');
  if (!scope || !key) {
    return c.json(
      {
        ok: false,
        action: 'memory_delete',
        changed: false,
        message: 'Memory delete requires scope and key query parameters.',
      },
      400,
    );
  }

  const result = await deleteMemory(
    { scope, key, confirm: c.req.query('confirm') === 'true' },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
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

app.get('/api/workflows/observability', async (c) => {
  return c.json(await readWorkflowObservability(paths));
});

app.get('/api/github/prs', async (c) => {
  const result = await listGitHubPrQueue(paths);
  const queue =
    result.ok && result.data && typeof result.data === 'object'
      ? (result.data as { queue?: unknown }).queue
      : undefined;
  if (queue && typeof queue === 'object') {
    return c.json(queue);
  }

  return c.json(
    {
      error: result.message,
      items: [],
      issues: (result.errors ?? [result.message]).map((message) => ({
        type: 'search-error',
        message,
      })),
    },
    result.requires?.includes('GITHUB_TOKEN') ? 503 : 502,
  );
});

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

async function safeJsonBody(c: Context): Promise<unknown> {
  return c.req.json().catch(() => ({}));
}

async function safeJsonObject(c: Context): Promise<Record<string, unknown>> {
  const body = await safeJsonBody(c);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
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

function memoryScope(value: string | undefined) {
  if (
    value === 'user' ||
    value === 'project' ||
    value === 'session' ||
    value === 'watch'
  ) {
    return value;
  }

  return undefined;
}

function sessionKind(value: string | undefined) {
  if (
    value === 'main' ||
    value === 'scratch' ||
    value === 'general' ||
    value === 'repo' ||
    value === 'watch' ||
    value === 'task' ||
    value === 'briefing'
  ) {
    return value;
  }

  return undefined;
}

function notificationPolicy() {
  return {
    info: 'Passive updates such as queued scheduled work.',
    ready: 'Completed work or green checks that can be glanced at and cleared.',
    attention:
      'Actionable failures, missing configuration, blocked watches, or failed Flue work.',
    urgent:
      'Release or production-facing failures that should interrupt passive viewing.',
    reconcile:
      'Unresolved notifications with the same source and source id are updated in place and counted.',
  };
}
