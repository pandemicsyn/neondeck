import {
  invoke,
  observe,
  type FlueEventContext,
  type FlueObservation,
  type FlueObservationSubscriber,
} from '@flue/runtime';
import type { MiddlewareHandler } from 'hono';
import { addNotification, setWorkflowSummaryRunId } from '../modules/app-state';
import { settleScheduledTaskWorkflowRun } from '../modules/scheduled-tasks';
import {
  beginAutopilotAdmissionPrepare,
  failAutopilotAdmission,
  recordAutopilotAdmissionRun,
  settleAutopilotAdmissionTriage,
} from '../modules/autopilot';
import {
  attachLearningReviewRunId,
  recordConversationTurnAndMaybeQueueLearning,
  recordHandledPrFromWorkflowResult,
} from '../modules/learning/reviews';
import type { RuntimePaths } from '../runtime-home';
import { recordFlueObservation } from '../modules/learning';
import curateLearningStoreWorkflow from '../workflows/curate_learning_store';
import reviewConversationForLearningWorkflow from '../workflows/review_conversation_for_learning';
import reviewPrBatchForLearningWorkflow from '../workflows/review_pr_batch_for_learning';

type ObservationInstallDependencies = {
  observe?: (subscriber: FlueObservationSubscriber) => () => void;
};

const observationHandlerUnsubscribers = new Map<string, () => void>();

export function installFlueObservationHandlers(
  paths: RuntimePaths,
  dependencies: ObservationInstallDependencies = {},
) {
  if (observationHandlerUnsubscribers.has(paths.home)) return;
  const observeFn = dependencies.observe ?? observe;
  const unsubscribe = observeFn((event, context) => {
    const contextHome = flueContextRuntimeHome(context);
    if (contextHome && contextHome !== paths.home) return;

    if (event.type === 'run_end') {
      void recordFlueObservation(event, paths)
        .then(() =>
          Promise.all([
            settleScheduledTaskWorkflowRun(
              { workflowRunId: event.runId, failed: event.isError },
              paths,
            ),
            settleAutopilotAdmissionTriage(
              { runId: event.runId, failed: event.isError },
              paths,
            ),
          ]),
        )
        .then(() => startPrepareAfterTriage(event, paths))
        .catch((error) => {
          console.error(
            '[neondeck] failed to record or settle Flue observation',
            error,
          );
        });
      void attachCommandRunSummaryRunId(event, paths).catch((error) => {
        console.error('[neondeck] failed to attach Flue run id', error);
      });
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

    void recordFlueObservation(event, paths).catch((error) => {
      console.error('[neondeck] failed to record Flue observation', error);
    });

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
  observationHandlerUnsubscribers.set(paths.home, unsubscribe);
}

export function resetFlueObservationHandlersForTests() {
  for (const unsubscribe of observationHandlerUnsubscribers.values()) {
    unsubscribe();
  }
  observationHandlerUnsubscribers.clear();
}

function flueContextRuntimeHome(context: FlueEventContext | undefined) {
  const value = context?.env?.NEONDECK_HOME;
  return typeof value === 'string' && value ? value : undefined;
}

async function startPrepareAfterTriage(
  event: Extract<FlueObservation, { type: 'run_end' }>,
  paths: RuntimePaths,
) {
  if (event.isError || !triageRequestsPrepare(event)) return;
  const admission = await beginAutopilotAdmissionPrepare(event.runId, paths);
  if (!admission) return;
  try {
    const workflow = await import('../workflows/prepare-pr-worktree');
    const { runId } = await invoke(workflow.default, {
      input: {
        repoId: admission.repoId,
        prNumber: admission.prNumber,
        eventId: admission.eventFingerprint,
        lock: false,
      },
    });
    await recordAutopilotAdmissionRun({ id: admission.id, runId }, paths);
  } catch (error) {
    await failAutopilotAdmission(
      {
        id: admission.id,
        error: error instanceof Error ? error.message : String(error),
      },
      paths,
    );
  }
}

function triageRequestsPrepare(
  event: Extract<FlueObservation, { type: 'run_end' }>,
) {
  if (workflowLabel(event) !== 'triage-pr-event' || !('result' in event)) {
    return false;
  }
  const result = event.result;
  if (!result || typeof result !== 'object') return false;
  const data = (result as Record<string, unknown>).data;
  return Boolean(
    data &&
    typeof data === 'object' &&
    (data as Record<string, unknown>).shouldPrepareWorktree === true,
  );
}

export function recordHandledPrApiResult(
  paths: RuntimePaths,
  workflow: string,
  result: unknown,
) {
  void Promise.resolve()
    .then(() =>
      recordHandledPrFromWorkflowResult(
        {
          workflow,
          result,
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

export function displayAssistantLearningMiddleware(
  paths: RuntimePaths,
): MiddlewareHandler {
  return async (c, next) => {
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
  };
}

export async function attachCommandRunSummaryRunId(
  event: FlueObservation,
  paths: RuntimePaths,
) {
  const link = commandRunSummaryLink(event);
  if (!link) return;
  await setWorkflowSummaryRunId(link.summaryId, link.runId, paths);
}

function commandRunSummaryLink(event: FlueObservation) {
  if (!('result' in event)) return undefined;
  const result = event.result;
  if (!result || typeof result !== 'object') return undefined;

  const summary = (result as { workflowSummary?: unknown }).workflowSummary;
  if (!summary || typeof summary !== 'object') return undefined;

  const id = (summary as { id?: unknown }).id;
  if (typeof id !== 'string') return undefined;
  const summaryWorkflow = stringField(summary, 'workflow');
  const runId =
    summaryWorkflow === 'ci_fix_run'
      ? stringField(event, 'runId')
      : (objectStringField(result, 'data', 'runId') ??
        stringField(summary, 'runId') ??
        stringField(event, 'runId'));
  if (!runId) return undefined;

  return {
    summaryId: id,
    runId,
  };
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

function objectStringField(
  value: object,
  objectKey: string,
  stringKey: string,
) {
  if (!(objectKey in value)) return undefined;
  const nested = (value as Record<string, unknown>)[objectKey];
  if (!nested || typeof nested !== 'object') return undefined;
  return stringField(nested, stringKey);
}

function stringField(value: object, key: string) {
  if (!(key in value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field : undefined;
}

function displayAssistantSessionId(path: string) {
  const prefix = '/api/flue/agents/display-assistant/';
  if (!path.startsWith(prefix)) return undefined;
  const remainder = path.slice(prefix.length);
  if (!remainder || remainder.includes('/')) return undefined;
  return decodeURIComponent(remainder);
}
