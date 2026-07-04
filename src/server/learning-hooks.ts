import { invoke, observe, type FlueObservation } from '@flue/runtime';
import type { MiddlewareHandler } from 'hono';
import { addNotification, setWorkflowSummaryRunId } from '../modules/app-state';
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

export function installFlueObservationHandlers(paths: RuntimePaths) {
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

function displayAssistantSessionId(path: string) {
  const prefix = '/api/flue/agents/display-assistant/';
  if (!path.startsWith(prefix)) return undefined;
  const remainder = path.slice(prefix.length);
  if (!remainder || remainder.includes('/')) return undefined;
  return decodeURIComponent(remainder);
}
