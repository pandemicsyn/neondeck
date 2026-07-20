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
  coordinateAutopilotAdmission,
  recordAutopilotStageTerminalObservation,
  recordAutopilotOwnerTerminalObservation,
  type AutopilotConcurrencyPolicy,
  type AutopilotWorkflowInvoker,
} from '../modules/autopilot';
import { invokeScheduledWorkflow } from '../modules/scheduler';
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
  invokeAutopilotWorkflow?: AutopilotWorkflowInvoker;
  autopilotConcurrency?: AutopilotConcurrencyPolicy;
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
  const invokeAutopilotWorkflow =
    dependencies.invokeAutopilotWorkflow ?? defaultAutopilotWorkflowInvoker;
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
          if (!terminalFact) return;
          const settled = await recordAutopilotStageTerminalObservation(
            { runId: event.runId, observation: terminalFact },
            paths,
          );
          if (settled.status !== 'settled' || !settled.admission) return;
          await coordinateAutopilotAdmission(
            {
              admissionId: settled.admission.id,
              invokeWorkflow: invokeAutopilotWorkflow,
              limits: dependencies.autopilotConcurrency,
              enableOwnerDispatch: true,
            },
            paths,
          );
        })
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
      const ownerTerminal = autopilotOwnerTerminalFact(event);
      if (ownerTerminal) {
        void recordAutopilotOwnerTerminalObservation(ownerTerminal, paths)
          .then(async (settled) => {
            if (settled.status !== 'settled' || !settled.admission) return;
            await coordinateAutopilotAdmission(
              {
                admissionId: settled.admission.id,
                invokeWorkflow: invokeAutopilotWorkflow,
                limits: dependencies.autopilotConcurrency,
                enableOwnerDispatch: true,
              },
              paths,
            );
            if (settled.queuedAdmissionId) {
              await coordinateAutopilotAdmission(
                {
                  admissionId: settled.queuedAdmissionId,
                  invokeWorkflow: invokeAutopilotWorkflow,
                  limits: dependencies.autopilotConcurrency,
                  enableOwnerDispatch: true,
                },
                paths,
              );
            }
          })
          .catch((error) => {
            console.error(
              '[neondeck] failed to settle PR-owner observation',
              error,
            );
          });
      }
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

export function autopilotOwnerTerminalFact(
  event: Extract<
    FlueObservation,
    { type: 'agent_end' | 'operation' | 'submission_settled' }
  >,
) {
  if (!event.dispatchId) return null;
  const record = event as unknown as Record<string, unknown>;
  if (
    record.taskId ||
    record.parentSession ||
    (typeof record.agentName === 'string' &&
      record.agentName !== 'pr-autopilot-owner')
  ) {
    return null;
  }
  if (
    event.type === 'operation' &&
    (event.operationKind !== 'prompt' || !event.isError)
  ) {
    return null;
  }
  const instanceId =
    typeof record.instanceId === 'string' ? record.instanceId : null;
  if (!instanceId) return null;
  const failed =
    event.type === 'operation'
      ? event.isError
      : event.type === 'submission_settled'
        ? event.outcome !== 'completed'
        : false;
  let error: string | null = null;
  if (failed) {
    if (event.type === 'submission_settled') {
      error = event.error?.message ?? `Owner submission ${event.outcome}.`;
    } else if (event.type === 'operation') {
      error =
        event.error instanceof Error
          ? event.error.message
          : typeof event.error === 'string'
            ? event.error
            : (event.errorInfo?.message ?? 'Owner model operation failed.');
    }
  }
  return {
    agent: 'pr-autopilot-owner' as const,
    instanceId,
    dispatchId: event.dispatchId,
    failed,
    error,
    source: event.type,
  };
}

const defaultAutopilotWorkflowInvoker: AutopilotWorkflowInvoker = (
  workflow,
  input,
) => {
  return invokeScheduledWorkflow(workflow, input);
};

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
  const failure = terminalActionFailure(event);
  const failed = Boolean(failure);
  if (workflow === 'triage-pr-event') {
    return {
      workflow,
      failed,
      shouldPrepare: !failed && triageRequestsPrepare(event),
      ...failure,
    } as const;
  }
  if (workflow === 'prepare-pr-worktree') {
    return {
      workflow,
      failed,
      worktreeId: failed ? undefined : prepareWorktreeId(event),
      ...failure,
    } as const;
  }
  if (
    workflow === 'verify-pr-worktree' ||
    workflow === 'push-pr-autofix' ||
    workflow === 'comment-pr-autofix-result' ||
    workflow === 'cleanup-autopilot-worktree'
  ) {
    return {
      workflow,
      failed,
      artifact: failed ? undefined : autopilotResultArtifact(event),
      ...failure,
    } as const;
  }
  return undefined;
}

function autopilotResultArtifact(
  event: Extract<FlueObservation, { type: 'run_end' }>,
) {
  const result =
    'result' in event && event.result && typeof event.result === 'object'
      ? (event.result as Record<string, unknown>)
      : {};
  const data =
    result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>)
      : {};
  const prepared =
    data.preparedDiff && typeof data.preparedDiff === 'object'
      ? (data.preparedDiff as Record<string, unknown>)
      : {};
  const verification =
    data.preparedDiffVerification &&
    typeof data.preparedDiffVerification === 'object'
      ? (data.preparedDiffVerification as Record<string, unknown>)
      : {};
  return {
    preparedDiffId:
      typeof prepared.id === 'string'
        ? prepared.id
        : typeof verification.id === 'string'
          ? verification.id
          : undefined,
    pushedCommitSha:
      typeof prepared.pushedCommitSha === 'string'
        ? prepared.pushedCommitSha
        : undefined,
    cleanupDeleted: data.cleanupDeleted === true,
    cleanupFailed: data.cleanupFailed === true,
    cleanupError:
      typeof data.cleanupError === 'string' ? data.cleanupError : undefined,
    commentDelivered:
      data.comment && typeof data.comment === 'object'
        ? (data.comment as Record<string, unknown>).ok === true
        : false,
  };
}

function terminalActionFailure(
  event: Extract<FlueObservation, { type: 'run_end' }>,
) {
  if (event.isError) {
    return {
      errorCode: 'workflow-run-error',
      error: `${workflowLabel(event)} failed before returning an action result.`,
    };
  }
  if (!('result' in event)) return undefined;
  const result = event.result;
  if (
    !result ||
    typeof result !== 'object' ||
    (result as { ok?: unknown }).ok !== false
  ) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const error =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : undefined;
  const errorFromList = Array.isArray(record.errors)
    ? firstBoundedError(record.errors)
    : undefined;
  return {
    errorCode:
      boundedStringValue(error?.code, 128) ??
      boundedStringValue(record.code, 128) ??
      'action-failed',
    error:
      boundedStringValue(error?.message) ??
      boundedStringValue(record.message) ??
      errorFromList ??
      `${workflowLabel(event)} returned an unsuccessful action result.`,
  };
}

function boundedStringValue(value: unknown, maxLength = 4_096) {
  if (typeof value !== 'string' || !value) return undefined;
  return value.slice(0, maxLength);
}

function firstBoundedError(errors: unknown[]) {
  for (const value of errors.slice(0, 8)) {
    const error = boundedStringValue(value);
    if (error) return error;
  }
  return undefined;
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
