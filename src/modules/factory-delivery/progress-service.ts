import {
  withFactorySpan,
  deliveryCorrelation,
  bindFactorySpanCorrelation,
} from '../factory-observability';
import * as v from 'valibot';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { DeliveryProgressAssessment } from '../../../shared/factory-progress';
import type { RuntimePaths } from '../../runtime-home';
import { codingDigest } from '../factory';
import {
  assertDeliveryAuthority,
  pipelineValidationContext,
} from './authority';
import { captureCandidateEvidence } from './evidence';
import { codingHandle, requireCodingRun } from '../factory';
import {
  deliveryBudget,
  deliveryProgressEvidenceDigest,
  reserveDeliveryProgress,
  updateDeliveryProgress,
} from './store';
import {
  requireDelivery,
  interveneDelivery,
  saveDeliveryIntent,
} from './service-records';
import { gatherDeliveryProgressPacket } from './progress-evidence';
import { progressEvidenceRefs } from './progress-evidence-contract';
import {
  progressReviewRequestSchema,
  progressReviewInputDigest,
} from './progress-reviewer-contract';
import { reviewFactoryProgress } from './progress-reviewer';
import {
  recoverDeliveryProgress,
  settleDeliveryProgress,
  failDeliveryProgress,
} from './progress-recovery';

export const progressIO = {
  packet: gatherDeliveryProgressPacket,
  model: (p: DeliveryPipeline, paths: RuntimePaths) => {
    const context = pipelineValidationContext(p, paths);
    return {
      model: context.reviewerModel,
      thinkingLevel: context.reviewerThinkingLevel,
    };
  },
  async assert(p: DeliveryPipeline, paths: RuntimePaths) {
    assertDeliveryAuthority(p, paths);
    const evidence = await captureCandidateEvidence(
      codingHandle(requireCodingRun(p.revision.runId, paths), paths),
    );
    if (evidence.evidenceDigest !== p.revision.candidateDigest)
      throw new Error('Progress candidate changed');
    const latest = requireDelivery(p.pipelineId, paths);
    if (latest.version !== p.version)
      throw new Error('Progress claim changed during capture');
    assertDeliveryAuthority(latest, paths);
  },
  review: reviewFactoryProgress,
};
export type ProgressIO = typeof progressIO;

export async function assertProgressCurrent(
  p: DeliveryPipeline,
  assessment: DeliveryProgressAssessment,
  paths: RuntimePaths,
  io: Pick<ProgressIO, 'assert'> = progressIO,
) {
  const current = requireDelivery(p.pipelineId, paths);
  if (
    current.authorization.id !== assessment.grantId ||
    codingDigest(current.revision) !== codingDigest(assessment.revision) ||
    deliveryProgressEvidenceDigest(current) !== assessment.evidenceDigest
  )
    throw new Error('Progress evidence or authority changed');
  await io.assert(current, paths);
  const latest = requireDelivery(p.pipelineId, paths);
  if (
    latest.version !== current.version ||
    latest.outcome ||
    latest.interventions.some((i) => !i.resolution) ||
    deliveryProgressEvidenceDigest(latest) !== assessment.evidenceDigest
  )
    throw new Error('Progress claim changed during evidence capture');
}

/** The single checkpoint shared by local failures and actionable PR feedback.
 * A retained ordinal is observed, never sent to a new model submission. */
export async function checkpointDeliveryRepair(
  p: DeliveryPipeline,
  instructions: string,
  requestId: string,
  paths: RuntimePaths,
  io: ProgressIO = progressIO,
) {
  p = requireDelivery(p.pipelineId, paths);
  const ordinal = p.repairs.length + 1;
  const existing = p.progress.assessments.find(
    (a) => a.repairOrdinal === ordinal,
  );
  if (existing) {
    if (existing.state !== 'settled') {
      await recoverDeliveryProgress(p, paths);
      return null;
    }
    if (
      existing.requestId !== requestId ||
      existing.instructions !== instructions
    ) {
      interveneDelivery(
        p.pipelineId,
        'scope',
        'Repair evidence changed after its one progress assessment. Return to planning.',
        paths,
      );
      return null;
    }
    try {
      await assertProgressCurrent(p, existing, paths, io);
    } catch {
      interveneDelivery(
        p.pipelineId,
        'authority',
        'Progress permission is stale; current evidence or authority changed.',
        paths,
      );
      return null;
    }
    if (
      !existing.result ||
      existing.result.decision === 'escalate' ||
      existing.executionMs === null
    )
      return null;
    return {
      assessmentId: existing.assessmentId,
      inputDigest: existing.inputDigest,
      evidenceDigest: existing.evidenceDigest,
      instructions:
        existing.result.decision === 'change-approach'
          ? existing.result.nextInstructions!
          : instructions,
    };
  }
  const budget = deliveryBudget(p);
  if (
    budget.repairsRemaining <= 0 ||
    budget.remainingExecutionMs <= 0 ||
    p.progress.assessments.length >= p.progress.limits.maxAssessments
  ) {
    interveneDelivery(
      p.pipelineId,
      'budget',
      'Repair or progress assessment allowance is exhausted. Return to planning for a new release.',
      paths,
    );
    return null;
  }
  await io.assert(p, paths);
  let packet: Awaited<ReturnType<ProgressIO['packet']>>;
  try {
    packet = await io.packet(p, instructions, requestId, paths);
  } catch {
    interveneDelivery(
      p.pipelineId,
      'scope',
      'Progress history could not be validated. Retained evidence requires human planning before another repair.',
      paths,
    );
    return null;
  }
  await io.assert(p, paths);
  if (requireDelivery(p.pipelineId, paths).version !== p.version)
    throw new Error('Progress claim changed before admission');
  const model = io.model(p, paths);
  const inputDigest = progressReviewInputDigest(
    packet,
    model.model,
    model.thinkingLevel,
  );
  const assessmentId = `progress:${codingDigest({ grantId: p.authorization.id, ordinal })}`;
  const reserved = reserveDeliveryProgress(
    {
      pipelineId: p.pipelineId,
      expectedVersion: p.version,
      assessmentId,
      requestId,
      instructions,
      revision: p.revision,
      grantId: p.authorization.id,
      repairOrdinal: ordinal,
      inputDigest,
      evidenceDigest: deliveryProgressEvidenceDigest(p),
      evidenceRefs: progressEvidenceRefs(packet),
    },
    paths,
  );
  if (reserved.replayed) return null;
  const assessment = reserved.assessment;
  try {
    const request = v.parse(progressReviewRequestSchema, {
      id: `${p.pipelineId}:${assessmentId}`,
      binding: {
        assessmentId,
        grantId: assessment.grantId,
        revision: assessment.revision,
        repairOrdinal: assessment.repairOrdinal,
        requestId,
        inputDigest,
        evidenceDigest: assessment.evidenceDigest,
      },
      ...model,
      packet,
      maxDurationMs: assessment.reservedExecutionMs,
      deadlineAt: Date.parse(assessment.deadlineAt),
      maxTokens: 16000,
    });
    saveDeliveryIntent(
      p.pipelineId,
      `progress:${assessmentId}`,
      request,
      paths,
    );
    updateDeliveryProgress(
      {
        pipelineId: p.pipelineId,
        expectedVersion: reserved.pipeline.version,
        assessmentId,
        action: { type: 'start' },
      },
      paths,
    );
    await assertProgressCurrent(p, assessment, paths, io);
    const result = await withFactorySpan(
      paths,
      'delivery.progress',
      deliveryCorrelation(p),
      () =>
        io.review(request, {
          assertAuthority: () =>
            assertProgressCurrent(p, assessment, paths, io),
          onDispatched: async (submissionId) => {
            const current = requireDelivery(p.pipelineId, paths);
            updateDeliveryProgress(
              {
                pipelineId: p.pipelineId,
                expectedVersion: current.version,
                assessmentId,
                action: { type: 'bind-submission', submissionId },
              },
              paths,
            );
            bindFactorySpanCorrelation({ submissionId });
          },
        }),
    );
    await assertProgressCurrent(p, assessment, paths, io);
    await settleDeliveryProgress(p, assessment, result, paths);
    return checkpointDeliveryRepair(
      requireDelivery(p.pipelineId, paths),
      instructions,
      requestId,
      paths,
      io,
    );
  } catch (error) {
    failDeliveryProgress(p, assessment, error, paths);
    return null;
  }
}
