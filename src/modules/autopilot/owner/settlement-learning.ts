import type { RuntimePaths } from '../../../runtime-home';
import {
  recordHandledPrEventAndMaybeQueueLearning,
  type LearningReviewAdmission,
  type PrBatchReviewInput,
} from '../../learning';
import type { PrWatch } from '../../watches';
import type { OwnerSettlementOutcome } from './settlement-decision';

export type OwnerSettlementLearningDependencies = {
  invokePrBatchReview?: (
    input: PrBatchReviewInput,
  ) => Promise<LearningReviewAdmission>;
  recordHandledPr?: typeof recordHandledPrEventAndMaybeQueueLearning;
};

export type OwnerSettlementContext = {
  correlationKind: string;
  eventFingerprint?: string;
  learningMemoryIds: string[];
  memorySnapshotAvailable: boolean;
  memorySnapshotReason: string;
  mode: PrWatch['autopilotMode'];
  source: string;
  turnId: string;
};

export async function recordOwnerOutcomeQuietly(
  watch: PrWatch,
  context: OwnerSettlementContext,
  outcome: OwnerSettlementOutcome,
  paths: RuntimePaths,
  dependencies: OwnerSettlementLearningDependencies,
) {
  const turnFingerprint = context.turnId;
  const sourceId = ['autopilot-owner', watch.id, turnFingerprint].join(':');
  try {
    await (
      dependencies.recordHandledPr ?? recordHandledPrEventAndMaybeQueueLearning
    )(
      {
        eventType: outcome.eventType,
        source: 'pr-autopilot-owner',
        sourceId,
        repoId: watch.repoId,
        repoFullName: watch.repoFullName,
        prNumber: watch.prNumber,
        summary: outcome.summary,
        data: {
          watchId: watch.id,
          ownerInstanceId: watch.ownerInstanceId,
          turnFingerprint,
          outcome: outcome.outcome,
          commitSha: outcome.commitSha ?? null,
          mode: context.mode,
          source: context.source,
          correlationKind: context.correlationKind,
          memoryIds: context.learningMemoryIds,
          memorySnapshot: {
            available: context.memorySnapshotAvailable,
            ids: context.learningMemoryIds,
            reason: context.memorySnapshotReason,
          },
        },
      },
      paths,
      dependencies.invokePrBatchReview
        ? { invokePrBatchReview: dependencies.invokePrBatchReview }
        : {},
    );
  } catch (error) {
    console.error(
      '[neondeck] failed to record Autopilot owner learning event',
      error,
    );
  }
}
