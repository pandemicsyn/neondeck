import type { CodingRunRecord } from '../../../shared/coding-runs';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { FactoryCorrelation } from '../../../shared/factory-observability';
export function codingCorrelation(run: CodingRunRecord): FactoryCorrelation {
  return {
    workItemId: run.snapshot.workItemId,
    releaseId: run.snapshot.releaseId,
    runId: run.runId,
    attemptId: run.attemptId,
  };
}
export function deliveryCorrelation(
  pipeline: DeliveryPipeline,
  effectId?: string,
): FactoryCorrelation {
  return {
    workItemId: pipeline.workItemId,
    releaseId: pipeline.revision.releaseId,
    runId: pipeline.revision.runId,
    attemptId: pipeline.revision.attemptId,
    deliveryId: pipeline.pipelineId,
    ...(effectId ? { effectId } : {}),
  };
}
