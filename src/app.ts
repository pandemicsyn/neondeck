import {
  invoke,
  observe,
  registerProvider,
  type FlueObservation,
} from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import * as v from 'valibot';
import { supportedCommands } from './commands';
import { autopilotStateSchema, readAutopilotState } from './autopilot';
import {
  fixPrCiFailure,
  fixPrReviewFeedback,
  commentPrAutofixResult,
  preparePrWorktree,
  pushPrAutofix,
  triagePrEvent,
  verifyPrWorktree,
} from './autopilot-workflows';
import {
  readAutopilotRecoveryOptions,
  runAutopilotRecoveryAction,
} from './autopilot-recovery';
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
import { syncExeDevCheckout } from './exedev-checkouts';
import { checkExecutionPolicy, readExecutionPolicy } from './execution-policy';
import { loadNeondeckEnv } from './env';
import { listGitHubPrQueue } from './github-actions';
import {
  bearerToken,
  localApiAuthHeader,
  localApiTokenMatches,
  localApiTokenQueryParam,
  readLocalApiToken,
} from './local-api-auth';
import {
  abortKiloTask,
  listKiloTasks,
  readKiloSession,
  readKiloSessionChildren,
  readKiloSessionDiff,
  readKiloSessionMessages,
  readKiloTaskDiff,
  readKiloTaskEvents,
  readKiloTaskSessions,
  readKiloTaskStatus,
  readUnavailableSessionAdapter,
  searchKiloSessions,
  startKiloTask,
} from './kilo-actions';
import {
  listKiloResultStates,
  promoteKiloResult,
  reviewKiloResult,
  verifyKiloResult,
} from './kilo-results';
import {
  archiveMemory,
  decideMemoryCandidate,
  deleteMemory,
  listMemories,
  listMemoryCandidates,
  listMemoryEvents,
  upsertMemory,
} from './memory-actions';
import {
  attachLearningReviewRunId,
  listLearningReviews,
  recordConversationTurnAndMaybeQueueLearning,
  recordHandledPrFromWorkflowResult,
} from './learning-reviews';
import {
  applySkillPatchCandidate,
  listSkillPatchCandidates,
  rejectSkillPatchCandidate,
} from './skill-patches';
import { readHostMetrics } from './metrics';
import {
  abandonPreparedDiff,
  approvePreparedDiffPush,
  listPreparedDiffs,
  openPreparedDiffWorktree,
  readPreparedDiffChangedFiles,
  readPreparedDiffFileDiff,
  readPreparedDiffSummary,
  requestPreparedDiffRevision,
  runPreparedDiffVerification,
} from './prepared-diffs';
import {
  getGitHubPrBranchPermissions,
  getGitHubPrEventState,
  getGitHubPrRequestedChanges,
  getGitHubPrReviewThreads,
  listPrWatchEventWatermarks,
  postGitHubPrComment,
  refreshPrWatchEventState,
} from './pr-event-state';
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
  referenceChatSession,
  renameChatSession,
  refreshChatSessionSummary,
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
import curateLearningStoreWorkflow from './workflows/curate_learning_store';
import reviewConversationForLearningWorkflow from './workflows/review_conversation_for_learning';
import reviewPrBatchForLearningWorkflow from './workflows/review_pr_batch_for_learning';

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

const requireFlueRunInspectionToken: MiddlewareHandler = async (c, next) => {
  const expected = await readLocalApiToken(paths);
  const provided =
    c.req.header(localApiAuthHeader) ??
    bearerToken(c.req.header('authorization')) ??
    c.req.query(localApiTokenQueryParam);

  if (!localApiTokenMatches(provided, expected)) {
    return c.json({ error: 'Not found' }, 404);
  }

  await next();
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
    const learningReviewId = learningReviewResultId(event);
    if (learningReviewId) {
      void Promise.resolve()
        .then(() =>
          attachLearningReviewRunId(
            { reviewId: learningReviewId, runId: event.runId },
            paths,
          ),
        )
        .catch((error) => {
          console.error(
            '[neondeck] failed to attach learning review run id',
            error,
          );
        });
    }
    if (!learningReviewId && !event.isError && 'result' in event) {
      void Promise.resolve()
        .then(() =>
          recordHandledPrFromWorkflowResult(
            {
              workflow: workflowLabel(event),
              runId: event.runId,
              result: event.result,
            },
            paths,
            {
              async invokePrBatchReview(input) {
                return invoke(reviewPrBatchForLearningWorkflow, { input });
              },
            },
          ),
        )
        .catch((error) => {
          console.error(
            '[neondeck] failed to record handled PR learning event',
            error,
          );
        });
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

app.get('/api/local-api/session', async (c) => {
  return c.json({
    ok: true,
    action: 'local_api_session_read',
    token: await readLocalApiToken(paths),
    header: localApiAuthHeader,
    queryParam: localApiTokenQueryParam,
  });
});

app.get('/api/autopilot/state', async (c) => {
  return c.json(v.parse(autopilotStateSchema, await readAutopilotState(paths)));
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

app.post('/api/execution/exedev/sync-checkout', async (c) => {
  const result = await syncExeDevCheckout(await safeJsonBody(c), paths);
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
      explicitUserRequest: c.req.query('explicitUserRequest') === '1',
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 'requires' in result ? 400 : 404);
});

app.post('/api/sessions/:id/summary/refresh', async (c) => {
  const result = await refreshChatSessionSummary(
    {
      ...(await safeJsonObject(c)),
      id: c.req.param('id'),
    } as Parameters<typeof refreshChatSessionSummary>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/sessions/:id/reference', async (c) => {
  const result = await referenceChatSession(
    {
      ...(await safeJsonObject(c)),
      id: c.req.param('id'),
    } as Parameters<typeof referenceChatSession>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
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

app.get('/api/kilo/tasks', async (c) => {
  return c.json(
    await listKiloTasks(
      {
        status: c.req.query('status'),
        repoId: c.req.query('repoId'),
        limit: queryNumber(c.req.query('limit')),
        includeDiff: queryBoolean(c.req.query('includeDiff')),
      },
      paths,
    ),
  );
});

app.get('/api/kilo/results', async (c) => {
  const result = await listKiloResultStates(
    {
      taskId: c.req.query('taskId') || undefined,
      limit: queryNumber(c.req.query('limit')),
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/kilo/tasks', async (c) => {
  const result = await startKiloTask(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/kilo/tasks/:id', async (c) => {
  const result = await readKiloTaskStatus({ taskId: c.req.param('id') }, paths);
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/kilo/tasks/:id/events', async (c) => {
  const result = await readKiloTaskEvents(
    { taskId: c.req.param('id'), limit: queryNumber(c.req.query('limit')) },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.post('/api/kilo/tasks/:id/abort', async (c) => {
  const result = await abortKiloTask({ taskId: c.req.param('id') }, paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/kilo/tasks/:id/sessions', async (c) => {
  const result = await readKiloTaskSessions(
    { taskId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/kilo/tasks/:id/diff', async (c) => {
  const result = await readKiloTaskDiff({ taskId: c.req.param('id') }, paths);
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/kilo/tasks/:id/result', async (c) => {
  const result = await listKiloResultStates(
    { taskId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.post('/api/kilo/tasks/:id/review', async (c) => {
  const result = await reviewKiloResult({ taskId: c.req.param('id') }, paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/kilo/tasks/:id/verify', async (c) => {
  const result = await verifyKiloResult(
    { ...(await safeJsonObject(c)), taskId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/kilo/tasks/:id/promote', async (c) => {
  const result = await promoteKiloResult({ taskId: c.req.param('id') }, paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/kilo/sessions/search', async (c) => {
  const result = await searchKiloSessions(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/kilo/sessions/:id', async (c) => {
  const result = await readKiloSession(
    { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/kilo/sessions/:id/messages', async (c) => {
  const result = await readKiloSessionMessages(
    { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/kilo/sessions/:id/children', async (c) => {
  const result = await readKiloSessionChildren(
    { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/kilo/sessions/:id/todos', async (c) => {
  const result = await readUnavailableSessionAdapter(
    { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
    'todos',
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.get('/api/kilo/sessions/:id/diff', async (c) => {
  const result = await readKiloSessionDiff(
    { sessionId: c.req.param('id'), ...kiloSessionQuery(c) },
    paths,
  );
  return c.json(result, result.ok ? 200 : 404);
});

app.post('/api/autopilot/triage-pr-event', async (c) => {
  const result = await triagePrEvent(await safeJsonBody(c));
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/autopilot/prepare-pr-worktree', async (c) => {
  const result = await preparePrWorktree(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/autopilot/fix-pr-ci-failure', async (c) => {
  const result = await fixPrCiFailure(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/autopilot/fix-pr-review-feedback', async (c) => {
  const result = await fixPrReviewFeedback(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/autopilot/comment-pr-autofix-result', async (c) => {
  const result = await commentPrAutofixResult(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/prepared-diffs', async (c) => {
  const result = await listPreparedDiffs(
    {
      status: c.req.query('status') || undefined,
      includeTerminal: queryBoolean(c.req.query('includeTerminal')),
      repoId: c.req.query('repoId') || undefined,
    },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.get('/api/prepared-diffs/:id/summary', async (c) => {
  const result = await readPreparedDiffSummary(
    { preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.get('/api/prepared-diffs/:id/files', async (c) => {
  const result = await readPreparedDiffChangedFiles(
    { preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.get('/api/prepared-diffs/:id/files/diff', async (c) => {
  const result = await readPreparedDiffFileDiff(
    {
      preparedDiffId: c.req.param('id'),
      path: c.req.query('path'),
      maxPatchBytes: queryNumber(c.req.query('maxPatchBytes')),
    },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.post('/api/prepared-diffs/:id/approve-push', async (c) => {
  const result = await approvePreparedDiffPush(
    { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.post('/api/prepared-diffs/:id/request-revision', async (c) => {
  const result = await requestPreparedDiffRevision(
    { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.post('/api/prepared-diffs/:id/abandon', async (c) => {
  const result = await abandonPreparedDiff(
    { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.get('/api/prepared-diffs/:id/worktree-path', async (c) => {
  const result = await openPreparedDiffWorktree(
    { preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.post('/api/prepared-diffs/:id/verify', async (c) => {
  const result = await runPreparedDiffVerification(
    { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.get('/api/prepared-diffs/:id/recovery', async (c) => {
  const result = await readAutopilotRecoveryOptions(
    { preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.post('/api/prepared-diffs/:id/recovery/run', async (c) => {
  const result = await runAutopilotRecoveryAction(
    { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, preparedDiffHttpStatus(result));
});

app.post('/api/autopilot/verify-pr-worktree', async (c) => {
  const result = await verifyPrWorktree(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/autopilot/push-pr-autofix', async (c) => {
  const result = await pushPrAutofix(await safeJsonBody(c), paths);
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/prepared-diffs/:id/push', async (c) => {
  const result = await pushPrAutofix(
    { ...(await safeJsonObject(c)), preparedDiffId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/watches', async (c) => {
  return c.json(await listPrWatches(paths));
});

app.get('/api/watches/events/watermarks', async (c) => {
  return c.json(
    await listPrWatchEventWatermarks(
      { watchId: c.req.query('watchId') || undefined },
      paths,
    ),
  );
});

app.get('/api/watches/:id/events/watermarks', async (c) => {
  return c.json(
    await listPrWatchEventWatermarks({ watchId: c.req.param('id') }, paths),
  );
});

app.post('/api/watches/:id/events/refresh', async (c) => {
  const result = await refreshPrWatchEventState(
    { ...(await safeJsonObject(c)), watchId: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
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
  const rawStatus = c.req.query('status');
  const status = memoryStatus(rawStatus);
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
  if (rawStatus && !status) {
    return c.json(
      {
        ok: false,
        action: 'memory_list',
        changed: false,
        message: `Invalid memory status "${rawStatus}".`,
      },
      400,
    );
  }

  return c.json(
    await listMemories(
      {
        scope,
        key: key || undefined,
        status,
        includeArchived: c.req.query('includeArchived') === 'true',
        repoId: c.req.query('repoId') || undefined,
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

app.post('/api/memories/:id/archive', async (c) => {
  const result = await archiveMemory(
    {
      ...((await safeJsonBody(c)) as Record<string, unknown>),
      id: c.req.param('id'),
    },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.get('/api/memory-events', async (c) => {
  const limit = Number(c.req.query('limit') ?? '100');
  return c.json(
    await listMemoryEvents(
      {
        memoryId: c.req.query('memoryId') || undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      },
      paths,
    ),
  );
});

app.post('/api/learning/curate', async (c) => {
  const parsed = v.safeParse(
    v.object({
      mode: v.optional(v.picklist(['off', 'review', 'auto'])),
      reason: v.optional(v.string()),
    }),
    await safeJsonBody(c),
  );
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        action: 'learning_curate',
        changed: false,
        message: v.summarize(parsed.issues),
      },
      400,
    );
  }
  const receipt = await invoke(curateLearningStoreWorkflow, {
    input: { ...parsed.output, trigger: 'manual' },
  });
  return c.json({
    ok: true,
    action: 'learning_curate',
    changed: true,
    runId: receipt.runId,
    message: 'Queued memory curation learning workflow.',
  });
});

app.get('/api/learning/reviews', (c) => {
  const kind = learningReviewKind(c.req.query('kind'));
  const status = learningReviewStatus(c.req.query('status'));
  const limit = boundedQueryLimit(c.req.query('limit'), 50);
  if (c.req.query('kind') && !kind) {
    return c.json(
      {
        ok: false,
        action: 'learning_review_list',
        changed: false,
        message: `Invalid learning review kind "${c.req.query('kind')}".`,
      },
      400,
    );
  }
  if (c.req.query('status') && !status) {
    return c.json(
      {
        ok: false,
        action: 'learning_review_list',
        changed: false,
        message: `Invalid learning review status "${c.req.query('status')}".`,
      },
      400,
    );
  }
  if (c.req.query('limit') && limit === undefined) {
    return c.json(
      {
        ok: false,
        action: 'learning_review_list',
        changed: false,
        message: `Invalid review limit "${c.req.query('limit')}".`,
      },
      400,
    );
  }
  return c.json(
    listLearningReviews(
      {
        kind,
        status,
        limit,
      },
      paths,
    ),
  );
});

app.post('/api/learning/reviews/conversation', async (c) => {
  const parsed = v.safeParse(
    v.object({
      sessionId: v.optional(v.pipe(v.string(), v.minLength(1))),
      reason: v.optional(v.string()),
    }),
    await safeJsonBody(c),
  );
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        action: 'learning_review_conversation',
        changed: false,
        message: v.summarize(parsed.issues),
      },
      400,
    );
  }
  if (parsed.output.sessionId) {
    const session = await readChatSession(
      {
        id: parsed.output.sessionId,
        reason: 'manual-conversation-learning-review',
        surface: 'learning',
      },
      paths,
    );
    if (!session.ok) return c.json(session, 400);
  }
  const receipt = await invoke(reviewConversationForLearningWorkflow, {
    input: { ...parsed.output, trigger: 'manual' },
  });
  return c.json({
    ok: true,
    action: 'learning_review_conversation',
    changed: true,
    runId: receipt.runId,
    message: 'Queued conversation learning review workflow.',
  });
});

app.post('/api/learning/reviews/prs', async (c) => {
  const parsed = v.safeParse(
    v.object({
      repoId: v.optional(v.pipe(v.string(), v.minLength(1))),
      reason: v.optional(v.string()),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    await safeJsonBody(c),
  );
  if (!parsed.success) {
    return c.json(
      {
        ok: false,
        action: 'learning_review_pr_batch',
        changed: false,
        message: v.summarize(parsed.issues),
      },
      400,
    );
  }
  const receipt = await invoke(reviewPrBatchForLearningWorkflow, {
    input: { ...parsed.output, trigger: 'manual' },
  });
  return c.json({
    ok: true,
    action: 'learning_review_pr_batch',
    changed: true,
    runId: receipt.runId,
    message: 'Queued PR/autopilot learning retrospective workflow.',
  });
});

app.get('/api/learning/candidates', async (c) => {
  const status = learningCandidateStatus(c.req.query('status'));
  if (c.req.query('status') && !status) {
    return c.json(
      {
        ok: false,
        action: 'memory_candidate_list',
        changed: false,
        message: `Invalid candidate status "${c.req.query('status')}".`,
      },
      400,
    );
  }
  const limit = Number(c.req.query('limit') ?? '100');
  if (c.req.query('limit') && !boundedQueryLimit(c.req.query('limit'), 100)) {
    return c.json(
      {
        ok: false,
        action: 'learning_candidate_list',
        changed: false,
        message: `Invalid candidate limit "${c.req.query('limit')}".`,
      },
      400,
    );
  }
  const boundedLimit = Number.isFinite(limit) ? limit : undefined;
  const [memoryCandidates, skillCandidates] = await Promise.all([
    listMemoryCandidates({ status, limit: boundedLimit }, paths),
    listSkillPatchCandidates({ status, limit: boundedLimit }, paths),
  ]);
  return c.json({
    ok: memoryCandidates.ok && skillCandidates.ok,
    action: 'learning_candidate_list',
    changed: false,
    candidates: [
      ...(memoryCandidates.candidates ?? []),
      ...(skillCandidates.candidates ?? []),
    ],
    memoryCandidates: memoryCandidates.candidates ?? [],
    skillCandidates: skillCandidates.candidates ?? [],
    fetchedAt: new Date().toISOString(),
  });
});

app.post('/api/learning/candidates/:id/approve', async (c) => {
  const body = (await safeJsonBody(c)) as Record<string, unknown>;
  const result = await decideMemoryCandidate(
    {
      ...body,
      id: c.req.param('id'),
      decision: 'apply',
    },
    paths,
  );
  if (result.ok) return c.json(result);
  const skillResult = await applySkillPatchCandidate(
    { ...body, id: c.req.param('id') },
    paths,
  );
  return c.json(skillResult, skillResult.ok ? 200 : 400);
});

app.post('/api/learning/candidates/:id/reject', async (c) => {
  const body = (await safeJsonBody(c)) as Record<string, unknown>;
  const result = await decideMemoryCandidate(
    {
      ...body,
      id: c.req.param('id'),
      decision: 'reject',
    },
    paths,
  );
  if (result.ok) return c.json(result);
  const skillResult = await rejectSkillPatchCandidate(
    { ...body, id: c.req.param('id') },
    paths,
  );
  return c.json(skillResult, skillResult.ok ? 200 : 400);
});

app.get('/api/skills/patches', async (c) => {
  const status = learningCandidateStatus(c.req.query('status'));
  if (c.req.query('status') && !status) {
    return c.json(
      {
        ok: false,
        action: 'skill_patch_list',
        changed: false,
        message: `Invalid candidate status "${c.req.query('status')}".`,
      },
      400,
    );
  }
  if (c.req.query('limit') && !boundedQueryLimit(c.req.query('limit'), 100)) {
    return c.json(
      {
        ok: false,
        action: 'skill_patch_list',
        changed: false,
        message: `Invalid patch limit "${c.req.query('limit')}".`,
      },
      400,
    );
  }
  return c.json(
    await listSkillPatchCandidates(
      {
        status,
        skillId: c.req.query('skillId') || undefined,
        limit: boundedQueryLimit(c.req.query('limit'), 100),
      },
      paths,
    ),
  );
});

app.post('/api/skills/patches/:id/apply', async (c) => {
  const result = await applySkillPatchCandidate(
    { ...(await safeJsonObject(c)), id: c.req.param('id') },
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/skills/patches/:id/reject', async (c) => {
  const result = await rejectSkillPatchCandidate(
    { ...(await safeJsonObject(c)), id: c.req.param('id') },
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

app.post('/api/github/prs/event-state', async (c) => {
  const result = await getGitHubPrEventState(
    (await safeJsonBody(c)) as Parameters<typeof getGitHubPrEventState>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/github/prs/review-threads', async (c) => {
  const result = await getGitHubPrReviewThreads(
    (await safeJsonBody(c)) as Parameters<typeof getGitHubPrReviewThreads>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/github/prs/requested-changes', async (c) => {
  const result = await getGitHubPrRequestedChanges(
    (await safeJsonBody(c)) as Parameters<
      typeof getGitHubPrRequestedChanges
    >[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/github/prs/branch-permissions', async (c) => {
  const result = await getGitHubPrBranchPermissions(
    (await safeJsonBody(c)) as Parameters<
      typeof getGitHubPrBranchPermissions
    >[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.post('/api/github/prs/comment', async (c) => {
  const result = await postGitHubPrComment(
    (await safeJsonBody(c)) as Parameters<typeof postGitHubPrComment>[0],
    paths,
  );
  return c.json(result, result.ok ? 200 : 400);
});

app.use('/api/flue/agents/display-assistant/*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  const sessionId = displayAssistantSessionId(c.req.path);
  await next();
  if (!sessionId || method !== 'POST' || c.res.status >= 400) return;

  void recordConversationTurnAndMaybeQueueLearning(sessionId, paths, {
    async invokeConversationReview(input) {
      return invoke(reviewConversationForLearningWorkflow, { input });
    },
    async invokeCurationReview(input) {
      return invoke(curateLearningStoreWorkflow, { input });
    },
  }).catch((error) => {
    console.error('[neondeck] failed to queue learning review', error);
  });
});

app.use('/api/flue/runs', requireFlueRunInspectionToken);
app.use('/api/flue/runs/*', requireFlueRunInspectionToken);
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

function learningReviewResultId(event: FlueObservation) {
  if (!('result' in event)) return undefined;
  const result = event.result;
  if (!result || typeof result !== 'object') return undefined;

  const action = (result as { action?: unknown }).action;
  if (
    action !== 'learning_review_conversation' &&
    action !== 'learning_curate' &&
    action !== 'learning_review_pr_batch'
  ) {
    return undefined;
  }
  const reviewId = (result as { reviewId?: unknown }).reviewId;
  return typeof reviewId === 'string' ? reviewId : undefined;
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
    value === 'local' ||
    value === 'project' ||
    value === 'session' ||
    value === 'watch'
  ) {
    return value;
  }

  return undefined;
}

function memoryStatus(value: string | undefined) {
  if (value === 'active' || value === 'archived') return value;
  return undefined;
}

function learningCandidateStatus(value: string | undefined) {
  if (
    value === 'proposed' ||
    value === 'applied' ||
    value === 'rejected' ||
    value === 'archived'
  ) {
    return value;
  }

  return undefined;
}

function learningReviewKind(value: string | undefined) {
  if (
    value === 'conversation' ||
    value === 'curation' ||
    value === 'pr-batch'
  ) {
    return value;
  }
  return undefined;
}

function learningReviewStatus(value: string | undefined) {
  if (value === 'running' || value === 'completed' || value === 'failed') {
    return value;
  }
  return undefined;
}

function displayAssistantSessionId(path: string) {
  const prefix = '/api/flue/agents/display-assistant/';
  if (!path.startsWith(prefix)) return undefined;
  const remainder = path.slice(prefix.length);
  if (!remainder || remainder.includes('/')) return undefined;
  return decodeURIComponent(remainder);
}

function boundedQueryLimit(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
  return limit;
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

function queryNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function queryBoolean(value: string | undefined) {
  if (!value) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

function kiloSessionQuery(c: Context) {
  return {
    limit: queryNumber(c.req.query('limit')),
    offset: queryNumber(c.req.query('offset')),
    maxBytes: queryNumber(c.req.query('maxBytes')),
    includeFullTranscript: queryBoolean(c.req.query('includeFullTranscript')),
    includeToolOutput: queryBoolean(c.req.query('includeToolOutput')),
    includeDiff: queryBoolean(c.req.query('includeDiff')),
    requesterSurface: c.req.query('requesterSurface') ?? 'dashboard',
    readReason: c.req.query('readReason') ?? 'dashboard-kilo-session-read',
  };
}

function preparedDiffHttpStatus(result: {
  ok: boolean;
  error?: { code?: string };
}) {
  if (result.ok) return 200;
  if (result.error?.code === 'PREPARED_DIFF_NOT_FOUND') return 404;
  return 400;
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
    autopilot:
      'Autopilot notifications use deterministic source ids by prepared diff/workflow and state: review-fix, ci-fix, verify, push-blocked, pushed, comment-result, and failed-workflow. Repeated retries reconcile in place; state changes create separate actionable records with recovery metadata.',
    kilo: 'Kilo notifications reconcile by delegated task and state: started, progress, waiting-approval, completed, failed, timed-out, needs-review, verified, promote-blocked, and promoted. Progress updates replace one task progress row; result workflow states create separate actionable records linked to the task.',
  };
}
