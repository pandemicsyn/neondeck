import {
  observe,
  type FlueEventContext,
  type FlueObservation,
  type FlueObservationSubscriber,
} from '@flue/runtime';
import type { MiddlewareHandler } from 'hono';
import { addNotification } from '../modules/app-state';
import { settleAutopilotOwnerObservation } from '../modules/autopilot/owner/settlement';
import { settleBriefingObservation } from '../modules/briefings';
import { recordFlueObservation } from '../modules/learning';
import {
  recordConversationTurnAndMaybeQueueLearning,
  recordHandledPrFromOperationResult,
  recordHumanReviewSubmittedEvidence,
  type HumanReviewSubmittedEvidenceInput,
} from '../modules/learning/reviews';
import { settleScheduledTaskSubmission } from '../modules/scheduled-tasks';
import type { RuntimePaths } from '../runtime-home';

type ObservationInstallDependencies = {
  observe?: (subscriber: FlueObservationSubscriber) => () => void;
  recordFlueObservation?: typeof recordFlueObservation;
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

  const unsubscribe = observeFn(async (event, context) => {
    const contextHome = flueContextRuntimeHome(context);
    if (contextHome && contextHome !== paths.home) return;

    await recordObservation(event, paths).catch((error) => {
      console.error('[neondeck] failed to record Flue activity', error);
    });

    if (event.type === 'submission_settled') {
      void settleBriefingObservation(event, paths).catch((error) => {
        console.error('[neondeck] failed to settle briefing submission', error);
      });
      void settleScheduledTaskSubmission(
        {
          submissionId: event.submissionId,
          failed: event.outcome !== 'completed',
        },
        paths,
      ).catch((error) => {
        console.error(
          '[neondeck] failed to settle scheduled instruction submission',
          error,
        );
      });
    }

    if (event.type === 'submission_settled') {
      void settleAutopilotOwnerObservation(event, paths).catch((error) => {
        console.error(
          '[neondeck] failed to settle Autopilot owner turn',
          error,
        );
      });
    }

    if (event.type === 'submission_settled' && event.outcome !== 'completed') {
      void recordSubmissionFailure(event, paths).catch((error) => {
        console.error('[neondeck] failed to record submission failure', error);
      });
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
            operationId: event.operationId,
            submissionId: event.submissionId ?? null,
            durationMs: event.durationMs,
            detailUrl: event.submissionId
              ? `/activity?submissionId=${encodeURIComponent(event.submissionId)}`
              : null,
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

function recordSubmissionFailure(
  event: Extract<FlueObservation, { type: 'submission_settled' }>,
  paths: RuntimePaths,
) {
  const label = event.agentName ?? 'Flue submission';
  return addNotification(
    {
      level: 'attention',
      title: 'Agent submission failed',
      message: `${label} ${event.outcome}.`,
      source: 'flue',
      sourceId: event.submissionId,
      data: {
        submissionId: event.submissionId,
        agentName: event.agentName ?? null,
        instanceId: event.instanceId ?? null,
        outcome: event.outcome,
        errorType: event.error?.type ?? event.error?.name ?? null,
        detailUrl: `/activity?submissionId=${encodeURIComponent(event.submissionId)}`,
      },
    },
    paths,
  );
}

function flueContextRuntimeHome(context: FlueEventContext | undefined) {
  const value = context?.env?.NEONDECK_HOME;
  return typeof value === 'string' && value ? value : undefined;
}

export function recordHandledPrApiResult(
  paths: RuntimePaths,
  workflow: string,
  result: unknown,
  dependencies: {
    recordHandledPr?: typeof recordHandledPrFromOperationResult;
  } = {},
) {
  return Promise.resolve()
    .then(() =>
      (dependencies.recordHandledPr ?? recordHandledPrFromOperationResult)(
        { operation: workflow, result },
        paths,
      ),
    )
    .catch((error) => {
      console.error(
        '[neondeck] failed to record handled PR learning event',
        error,
      );
      return null;
    });
}

export function recordHumanReviewSubmittedApiEvidence(
  paths: RuntimePaths,
  evidence: HumanReviewSubmittedEvidenceInput,
  dependencies: {
    recordEvidence?: typeof recordHumanReviewSubmittedEvidence;
  } = {},
) {
  return Promise.resolve()
    .then(() =>
      (dependencies.recordEvidence ?? recordHumanReviewSubmittedEvidence)(
        evidence,
        paths,
      ),
    )
    .catch((error) => {
      console.error(
        '[neondeck] failed to record submitted-review learning evidence',
        error,
      );
      return null;
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

    void recordConversationTurnAndMaybeQueueLearning(sessionId, paths).catch(
      (error) => {
        console.error('[neondeck] failed to record learning turn', error);
      },
    );
  };
}

function displayAssistantSessionId(path: string) {
  const prefix = '/api/flue/agents/display-assistant/';
  if (!path.startsWith(prefix)) return undefined;
  const remainder = path.slice(prefix.length);
  if (!remainder || remainder.includes('/')) return undefined;
  return decodeURIComponent(remainder);
}
