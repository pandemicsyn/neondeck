import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { Paths } from './delivery-persistence';
import {
  reserveDeliveryProgress,
  updateDeliveryProgress,
  deliveryProgressEvidenceDigest,
} from './store';

/** Synthetic trusted judge, through the real persisted admission boundary. */
export function approveTestProgress(
  r: DeliveryPipeline,
  paths: Paths,
  requestId = 'repair',
  instructions = 'failed validation',
) {
  const binding = {
    assessmentId: `assessment:${requestId}`,
    grantId: r.authorization.id,
    revision: r.revision,
    repairOrdinal: r.repairs.length + 1,
    requestId,
    inputDigest: '1'.repeat(64),
    evidenceDigest: deliveryProgressEvidenceDigest(r),
  };
  r = reserveDeliveryProgress(
    {
      pipelineId: r.pipelineId,
      expectedVersion: r.version,
      ...binding,
      instructions,
      evidenceRefs: ['synthetic:source'],
    },
    paths,
  ).pipeline;
  const update = (action: unknown) =>
    updateDeliveryProgress(
      {
        pipelineId: r.pipelineId,
        expectedVersion: r.version,
        assessmentId: binding.assessmentId,
        action,
      },
      paths,
    );
  r = update({ type: 'start' });
  r = update({
    type: 'bind-submission',
    submissionId: `submission:${requestId}`,
  });
  return update({
    type: 'settle',
    submissionId: `submission:${requestId}`,
    resultId: `result:${requestId}`,
    executionMs: 1,
    completedAt: r.progress.assessments.at(-1)!.reservedAt,
    result: {
      ...binding,
      decision: 'continue',
      rationale: 'Synthetic bounded repair',
      evidenceRefs: ['synthetic:source'],
      nextInstructions: null,
    },
  });
}
