import { AgentRunError, init } from '@flue/runtime';
import { runtimePaths, type RuntimePaths } from '../../../runtime-home';
import {
  prepareConversationReflection,
  prepareMemoryCurationReview,
  preparePrBatchLearningReview,
} from './prepare';
import type {
  ConversationReviewInput,
  CurationReviewInput,
  FailedLearningReview,
  LearningReviewKind,
  PrBatchReviewInput,
  PreparedLearningReview,
} from './schemas';
import {
  attachLearningReviewSubmission,
  claimLearningReviewAdmissionIntent,
  failLearningReview,
  getLearningReview,
  listPendingLearningReviewAdmissionIntents,
  listRecoverableLearningReviews,
  markLearningReviewAdmissionIntentAdmitted,
  persistPreparedLearningReview,
  recordLearningReviewAdmissionIntentError,
  recordLearningReviewDispatchError,
  resetProcessingLearningReviewAdmissionIntents,
} from './store';

export type LearningReviewAdmission = {
  ok: true;
  reviewId: string;
  agentId: string;
  submissionId: string;
  activityUrl: string;
};

export type AdmissionDependencies = {
  dispatch?: (
    prepared: PreparedLearningReview,
    agentId: string,
  ) => Promise<{ submissionId: string }>;
  readSettlement?: typeof readLearningReviewSettlement;
  settlementRetryDelayMs?: number;
  reviewId?: string;
};

const settlementWatchers = new Map<string, Promise<void>>();

export async function admitConversationLearningReview(
  input: ConversationReviewInput = {},
  paths = runtimePaths(),
  dependencies: AdmissionDependencies = {},
): Promise<LearningReviewAdmission | FailedLearningReview> {
  const prepared = await prepareConversationReflection(input, paths, {
    reviewId: dependencies.reviewId,
  });
  return prepared.ok
    ? admitPreparedLearningReview(prepared, paths, dependencies)
    : prepared;
}

export async function admitCurationLearningReview(
  input: CurationReviewInput = {},
  paths = runtimePaths(),
  dependencies: AdmissionDependencies = {},
): Promise<LearningReviewAdmission | FailedLearningReview> {
  const prepared = await prepareMemoryCurationReview(input, paths, {
    reviewId: dependencies.reviewId,
  });
  return prepared.ok
    ? admitPreparedLearningReview(prepared, paths, dependencies)
    : prepared;
}

export async function admitPrBatchLearningReview(
  input: PrBatchReviewInput = {},
  paths = runtimePaths(),
  dependencies: AdmissionDependencies = {},
): Promise<LearningReviewAdmission | FailedLearningReview> {
  const prepared = await preparePrBatchLearningReview(input, paths, {
    reviewId: dependencies.reviewId,
  });
  return prepared.ok
    ? admitPreparedLearningReview(prepared, paths, dependencies)
    : prepared;
}

export async function admitPreparedLearningReview(
  prepared: PreparedLearningReview,
  paths = runtimePaths(),
  dependencies: AdmissionDependencies = {},
): Promise<LearningReviewAdmission> {
  const agentId = `learning-review:${prepared.reviewId}`;
  persistPreparedLearningReview(prepared, agentId, paths);
  try {
    const receipt = await (
      dependencies.dispatch ?? dispatchPreparedLearningReview
    )(prepared, agentId);
    attachLearningReviewSubmission(
      { reviewId: prepared.reviewId, submissionId: receipt.submissionId },
      paths,
    );
    watchLearningReviewSettlement(
      prepared.reviewId,
      agentId,
      receipt.submissionId,
      paths,
      dependencies,
    );
    return {
      ok: true,
      reviewId: prepared.reviewId,
      agentId,
      submissionId: receipt.submissionId,
      activityUrl: `/activity?submissionId=${encodeURIComponent(receipt.submissionId)}`,
    };
  } catch (error) {
    recordLearningReviewDispatchError(
      prepared.reviewId,
      error instanceof Error ? error.message : String(error),
      paths,
    );
    throw error;
  }
}

export async function dispatchPreparedLearningReview(
  prepared: PreparedLearningReview,
  agentId: string,
) {
  const { LearningReviewAgent } =
    await import('../../../agents/learning-review-agent');
  const handle = init(LearningReviewAgent, { id: agentId });
  return handle.dispatch({
    initialData: prepared,
    idempotencyKey: prepared.reviewId,
    message: {
      kind: 'signal',
      type: 'neondeck.learning-review.requested',
      body: prepared.prompt,
      attributes: {
        reviewId: prepared.reviewId,
        reviewKind: prepared.kind,
      },
    },
  });
}

export async function readLearningReviewSettlement(
  agentId: string,
  submissionId: string,
) {
  const { LearningReviewAgent } =
    await import('../../../agents/learning-review-agent');
  const handle = init(LearningReviewAgent, { id: agentId });
  try {
    await handle.read(submissionId);
    return { failed: false as const };
  } catch (error) {
    if (error instanceof AgentRunError) {
      return { failed: true as const, error: error.message };
    }
    throw error;
  }
}

export async function recoverInterruptedLearningReviews(
  paths = runtimePaths(),
  dependencies: AdmissionDependencies = {},
) {
  const recovered: string[] = [];
  const failed: Array<{ reviewId: string; error: string }> = [];
  resetProcessingLearningReviewAdmissionIntents(paths);
  const pending = await recoverPendingLearningReviewAdmissions(
    paths,
    dependencies,
  );
  recovered.push(...pending.admissions.map((admission) => admission.reviewId));
  failed.push(...pending.failed);
  for (const entry of listRecoverableLearningReviews(paths)) {
    const { prepared, review } = entry;
    const agentId = review.agentId ?? `learning-review:${review.id}`;
    try {
      let submissionId = review.submissionId;
      if (!submissionId) {
        const receipt = await (
          dependencies.dispatch ?? dispatchPreparedLearningReview
        )(prepared, agentId);
        submissionId = receipt.submissionId;
        attachLearningReviewSubmission(
          { reviewId: review.id, submissionId },
          paths,
        );
      }
      watchLearningReviewSettlement(
        review.id,
        agentId,
        submissionId,
        paths,
        dependencies,
      );
      if (!recovered.includes(review.id)) recovered.push(review.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordLearningReviewDispatchError(review.id, message, paths);
      failed.push({ reviewId: review.id, error: message });
    }
  }
  return { recovered, failed };
}

export async function recoverPendingLearningReviewAdmissions(
  paths = runtimePaths(),
  dependencies: AdmissionDependencies = {},
  sessionId?: string,
  kind?: LearningReviewKind,
) {
  const admissions: LearningReviewAdmission[] = [];
  const failed: Array<{ reviewId: string; error: string }> = [];
  const intents = listPendingLearningReviewAdmissionIntents(
    paths,
    sessionId,
  ).filter((intent) => !kind || intent.kind === kind);
  for (const intent of intents) {
    if (!claimLearningReviewAdmissionIntent(intent.id, paths)) continue;
    try {
      const admission = await admitLearningReviewIntent(
        intent,
        paths,
        dependencies,
      );
      if (admission) admissions.push(admission);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordLearningReviewAdmissionIntentError(intent.id, message, paths);
      failed.push({ reviewId: intent.id, error: message });
    }
  }
  return { admissions, failed };
}

async function admitLearningReviewIntent(
  intent: ReturnType<typeof listPendingLearningReviewAdmissionIntents>[number],
  paths: RuntimePaths,
  dependencies: AdmissionDependencies,
) {
  const existing = getLearningReview(intent.id, paths);
  if (existing?.status === 'completed' || existing?.status === 'failed') {
    markLearningReviewAdmissionIntentAdmitted(intent.id, paths);
    return null;
  }
  const recoverable = listRecoverableLearningReviews(paths).find(
    (entry) => entry.review.id === intent.id,
  );
  if (recoverable) {
    if (recoverable.review.submissionId) {
      watchLearningReviewSettlement(
        recoverable.review.id,
        recoverable.review.agentId ??
          `learning-review:${recoverable.review.id}`,
        recoverable.review.submissionId,
        paths,
        dependencies,
      );
      markLearningReviewAdmissionIntentAdmitted(intent.id, paths);
      return null;
    }
    const admission = await admitPreparedLearningReview(
      recoverable.prepared,
      paths,
      dependencies,
    );
    markLearningReviewAdmissionIntentAdmitted(intent.id, paths);
    return admission;
  }

  const intentDependencies = { ...dependencies, reviewId: intent.id };
  const result =
    intent.kind === 'conversation'
      ? await admitConversationLearningReview(
          intent.input as ConversationReviewInput,
          paths,
          intentDependencies,
        )
      : intent.kind === 'curation'
        ? await admitCurationLearningReview(
            intent.input as CurationReviewInput,
            paths,
            intentDependencies,
          )
        : await admitPrBatchLearningReview(
            intent.input as PrBatchReviewInput,
            paths,
            intentDependencies,
          );
  if (!result.ok) throw new Error(result.message);
  markLearningReviewAdmissionIntentAdmitted(intent.id, paths);
  return result;
}

function watchLearningReviewSettlement(
  reviewId: string,
  agentId: string,
  submissionId: string,
  paths: RuntimePaths,
  dependencies: AdmissionDependencies,
) {
  const key = `${paths.home}:${reviewId}:${submissionId}`;
  if (settlementWatchers.has(key)) return;
  const watcher = (async () => {
    let delayMs = dependencies.settlementRetryDelayMs ?? 1_000;
    while (getLearningReview(reviewId, paths)?.status === 'running') {
      try {
        const settlement = await (
          dependencies.readSettlement ?? readLearningReviewSettlement
        )(agentId, submissionId);
        if (settlement.failed) {
          failLearningReview(
            reviewId,
            settlement.error ?? 'Learning review submission failed.',
            paths,
          );
          return;
        }
        if (getLearningReview(reviewId, paths)?.status === 'running') {
          failLearningReview(
            reviewId,
            'Learning review submission settled without a validated result.',
            paths,
          );
        }
        return;
      } catch (error) {
        recordLearningReviewDispatchError(
          reviewId,
          error instanceof Error ? error.message : String(error),
          paths,
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(Math.max(delayMs * 2, 1), 30_000);
      }
    }
  })()
    .catch((error) => {
      recordLearningReviewDispatchError(
        reviewId,
        error instanceof Error ? error.message : String(error),
        paths,
      );
    })
    .finally(() => settlementWatchers.delete(key));
  settlementWatchers.set(key, watcher);
}

export function resetLearningReviewSettlementWatchersForTests() {
  settlementWatchers.clear();
}
