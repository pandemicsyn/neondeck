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
  recordAutopilotAdmissionTerminalFact,
  settleAutopilotAdmissionPrepare,
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
import {
  linkBriefingWorkflowObservation,
  settleBriefingObservation,
} from '../modules/briefings';
import { attachPrReviewAttemptRun, failPrReview } from '../modules/pr-reviews';

type ObservationInstallDependencies = {
  observe?: (subscriber: FlueObservationSubscriber) => () => void;
  recordFlueObservation?: typeof recordFlueObservation;
  settleScheduledTaskWorkflowRun?: typeof settleScheduledTaskWorkflowRun;
};

const observationHandlerUnsubscribers = new Map<string, () => void>();

export function installFlueObservationHandlers(
  paths: RuntimePaths,
  dependencies: ObservationInstallDependencies = {},
) {
  if (observationHandlerUnsubscribers.has(paths.home)) return;
  const observeFn = dependencies.observe ?? observe;
  const recordObservation =
    dependencies.recordFlueObservation ?? recordFlueObservation;
  const settleScheduledWorkflow =
    dependencies.settleScheduledTaskWorkflowRun ??
    settleScheduledTaskWorkflowRun;
  const unsubscribe = observeFn((event, context) => {
    const contextHome = flueContextRuntimeHome(context);
    if (contextHome && contextHome !== paths.home) return;

    if (event.type === 'run_start') {
      try {
        linkPrReviewRunObservation(event, paths);
      } catch (error) {
        console.error('[neondeck] failed to link PR review run', error);
      }
    }

    if (event.type === 'run_end') {
      void recordObservation(event, paths).catch((error) => {
        console.error('[neondeck] failed to record Flue observation', error);
      });
      void settleScheduledWorkflow(
        { workflowRunId: event.runId, failed: event.isError },
        paths,
      ).catch((error) => {
        console.error(
          '[neondeck] failed to settle scheduled workflow run',
          error,
        );
      });
      void Promise.resolve()
        .then(async () => {
          const terminalFact = autopilotTerminalFact(event);
          if (terminalFact) {
            await recordAutopilotAdmissionTerminalFact(
              { runId: event.runId, fact: terminalFact },
              paths,
            );
          }
        })
        .then(() =>
          Promise.all([
            settleAutopilotAdmissionTriage(
              {
                runId: event.runId,
                failed: terminalActionFailed(event),
                shouldPrepare: triageRequestsPrepare(event),
              },
              paths,
            ),
            settleAutopilotAdmissionPrepare(
              {
                runId: event.runId,
                failed: terminalActionFailed(event),
                worktreeId: prepareWorktreeId(event),
              },
              paths,
            ),
          ]),
        )
        .then(() => startPrepareAfterTriage(event, paths))
        .catch((error) => {
          console.error(
            '[neondeck] failed to settle autopilot Flue observation',
            error,
          );
        });
      void attachCommandRunSummaryRunId(event, paths).catch((error) => {
        console.error('[neondeck] failed to attach Flue run id', error);
      });
      void linkBriefingWorkflowObservation(event, paths).catch((error) => {
        console.error('[neondeck] failed to link briefing workflow run', error);
      });
      void Promise.resolve()
        .then(() => settlePrReviewObservation(event, paths))
        .catch((error) => {
          console.error('[neondeck] failed to settle PR review run', error);
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

    if (
      event.type === 'agent_end' ||
      event.type === 'operation' ||
      event.type === 'submission_settled'
    ) {
      void settleBriefingObservation(event, paths).catch((error) => {
        console.error('[neondeck] failed to settle briefing submission', error);
      });
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

export function settlePrReviewObservation(
  event: Extract<FlueObservation, { type: 'run_end' }>,
  paths: RuntimePaths,
) {
  if (!event.isError) return null;
  return failPrReview(
    {
      runId: event.runId,
      allowReady: true,
      message:
        'The Flue review workflow failed. Inspect the guarded run for details.',
    },
    paths,
  );
}

export function linkPrReviewRunObservation(
  event: Extract<FlueObservation, { type: 'run_start' }>,
  paths: RuntimePaths,
) {
  if (event.workflowName !== 'review-pr-for-human') return null;
  if (!event.input || typeof event.input !== 'object') return null;
  const reviewId = stringField(event.input, 'reviewId');
  const attemptId = stringField(event.input, 'attemptId');
  if (!reviewId || !attemptId) return null;
  return attachPrReviewAttemptRun(reviewId, attemptId, event.runId, paths);
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
  const admission = await beginAutopilotAdmissionPrepare(
    { triageRunId: event.runId },
    paths,
  );
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

function prepareWorktreeId(
  event: Extract<FlueObservation, { type: 'run_end' }>,
) {
  if (
    !('result' in event) ||
    !event.result ||
    typeof event.result !== 'object'
  ) {
    return undefined;
  }
  const data = (event.result as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return undefined;
  const worktree = (data as Record<string, unknown>).worktree;
  if (!worktree || typeof worktree !== 'object') return undefined;
  const id = (worktree as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

function autopilotTerminalFact(
  event: Extract<FlueObservation, { type: 'run_end' }>,
) {
  const workflow = workflowLabel(event);
  const failed = terminalActionFailed(event);
  if (workflow === 'triage-pr-event') {
    return {
      workflow,
      failed,
      shouldPrepare: !failed && triageRequestsPrepare(event),
    } as const;
  }
  if (workflow === 'prepare-pr-worktree') {
    return {
      workflow,
      failed,
      worktreeId: failed ? undefined : prepareWorktreeId(event),
    } as const;
  }
  return undefined;
}

function terminalActionFailed(
  event: Extract<FlueObservation, { type: 'run_end' }>,
) {
  if (event.isError || !('result' in event)) return event.isError;
  const result = event.result;
  return Boolean(
    result &&
    typeof result === 'object' &&
    (result as { ok?: unknown }).ok === false,
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
