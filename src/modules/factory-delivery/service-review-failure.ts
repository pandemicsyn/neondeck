import type {
  DeliveryPipeline,
  DeliveryEffect,
} from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { ReviewerTerminalError } from './reviewer';
import {
  changeDelivery,
  deliveryReceipt,
  interveneDelivery,
  requireDelivery,
} from './service-records';

/** A known terminal failed submission cannot be retried as uncertain admission.
 * No pass evidence is minted, and unknown usage conservatively retains the
 * entire reservation before the human intervention. */
export function settleReviewerFailure(
  p: DeliveryPipeline,
  effect: DeliveryEffect,
  error: unknown,
  paths: RuntimePaths,
) {
  if (
    !(error instanceof ReviewerTerminalError) ||
    !['review', 'feedback-review'].includes(effect.kind)
  )
    return false;
  const current = requireDelivery(p.pipelineId, paths);
  const actual = current.effects.find((e) => e.id === effect.id);
  if (!actual || !['in-flight', 'uncertain'].includes(actual.state))
    return true;
  const ref = deliveryReceipt(
    p.pipelineId,
    {
      terminalOutcome: error.terminalOutcome,
      submissionId: error.submissionId,
      usageKnown: false,
      heldExecutionMs: actual.reservedExecutionMs,
    },
    paths,
  );
  changeDelivery(
    p.pipelineId,
    {
      type: 'reconcile-effect',
      id: effect.id,
      observation: 'delivered',
      receiptRef: ref,
      executionMs: null,
    },
    paths,
  );
  if (
    !requireDelivery(p.pipelineId, paths).interventions.some(
      (i) => !i.resolution,
    )
  )
    interveneDelivery(
      p.pipelineId,
      'scope',
      `Independent reviewer settled ${error.terminalOutcome} without certification. Its full execution reservation remains held because exact usage is unavailable. Return to planning before a new candidate grant.`,
      paths,
    );
  return true;
}
