import { deliveryEvidenceContentSchema } from '../../../shared/factory-delivery-evidence';
import * as v from 'valibot';
import {
  deliveryDetailSchema,
  deliveryStateSchema,
  deliveryGrantPreviewSchema,
  deliveryGrantInputSchema,
  deliveryControlInputSchema,
  type DeliveryGrantPreview,
} from '../../../shared/factory-delivery-api';
import type {
  DeliveryRevision,
  DeliveryEvidence,
  DeliveryFeedback,
} from '../../../shared/factory-delivery';
import { getJson, postJson, type ApiRequestOptions } from './http';

// Validate each HTTP boundary with the canonical contract, avoiding schema drift.
export {
  deliveryDetailSchema,
  deliveryGrantInputSchema,
  deliveryGrantPreviewSchema,
};
export type { DeliveryGrantPreview, DeliveryRevision };
export type DeliveryDetail = v.InferOutput<typeof deliveryDetailSchema>;
const prefix = '/api/factory-delivery';
export async function getFactoryDeliveryState(options: ApiRequestOptions = {}) {
  return v.parse(
    deliveryStateSchema,
    await getJson<unknown>(`${prefix}/state`, options),
  );
}
export async function getFactoryDeliveryPreview(
  runId: string,
  options: ApiRequestOptions = {},
) {
  const result = v.parse(
    deliveryGrantPreviewSchema,
    await getJson<unknown>(
      `${prefix}/candidates/${encodeURIComponent(runId)}`,
      options,
    ),
  );
  if (result.revision.runId !== runId)
    throw new Error('Candidate identity does not match this request.');
  return result;
}
export async function getFactoryDelivery(
  id: string,
  options: ApiRequestOptions = {},
) {
  return matchDelivery(
    v.parse(
      deliveryDetailSchema,
      await getJson<unknown>(
        `${prefix}/deliveries/${encodeURIComponent(id)}`,
        options,
      ),
    ),
    id,
  );
}
export async function grantFactoryDelivery(
  request: v.InferOutput<typeof deliveryGrantInputSchema>,
) {
  const body = v.parse(deliveryGrantInputSchema, request);
  const result = v.parse(
    deliveryDetailSchema,
    await postJson<unknown>(`${prefix}/grants`, body),
  );
  const authorization = result.pipeline.authorization;
  const preview = body.preview;
  if (
    result.pipeline.repoId !== preview.repoId ||
    authorization.repoId !== preview.repoId ||
    JSON.stringify(authorization.revision) !==
      JSON.stringify(preview.revision) ||
    JSON.stringify(authorization.target) !== JSON.stringify(preview.target) ||
    JSON.stringify(authorization.checkCommands) !==
      JSON.stringify(preview.checkCommands) ||
    authorization.configFingerprint !== preview.configFingerprint ||
    authorization.initialExecutionMs !== preview.initialExecutionMs ||
    authorization.totalExecutionMs !== preview.totalExecutionMs ||
    authorization.maxRepairAttempts !== preview.maxRepairAttempts ||
    result.pipeline.workItemId !== body.preview.workItemId ||
    JSON.stringify(result.pipeline.initialRevision) !==
      JSON.stringify(body.preview.revision)
  )
    throw new Error('Delivery grant receipt does not match the candidate.');
  return result;
}
export async function controlFactoryDelivery(
  id: string,
  action: 'revoke' | 'reconcile',
  expectedVersion: number,
  reason: string,
) {
  return matchDelivery(
    v.parse(
      deliveryDetailSchema,
      await postJson<unknown>(
        `${prefix}/deliveries/${encodeURIComponent(id)}/${action}`,
        v.parse(deliveryControlInputSchema, { expectedVersion, reason }),
      ),
    ),
    id,
  );
}
function matchDelivery(detail: DeliveryDetail, id: string) {
  if (detail.pipeline.pipelineId !== id)
    throw new Error('Delivery identity does not match this request.');
  return detail;
}

export async function getFactoryDeliveryEvidence(
  deliveryId: string,
  expected: DeliveryEvidence | DeliveryFeedback,
  options: ApiRequestOptions = {},
) {
  const result = v.parse(
    deliveryEvidenceContentSchema,
    await getJson<unknown>(
      `${prefix}/deliveries/${encodeURIComponent(deliveryId)}/evidence/${encodeURIComponent(expected.id)}`,
      options,
    ),
  );
  if (result.deliveryId !== deliveryId || result.evidenceId !== expected.id)
    throw new Error('Evidence identity does not match this request.');
  // Receipt references and bundle provenance are validated by the backend;
  // the public content contract exposes only these immutable binding fields.
  const sameRevision = Object.keys(expected.revision).every(
    (key) =>
      expected.revision[key as keyof DeliveryRevision] ===
      result.revision[key as keyof DeliveryRevision],
  );
  const matches =
    'kind' in expected
      ? result.kind === expected.kind && result.result === expected.result
      : result.kind === 'feedback' &&
        result.feedback.fingerprint === expected.fingerprint &&
        result.feedback.publishedHeadSha === expected.publishedHeadSha &&
        result.feedback.ciFailed === expected.ciFailed &&
        result.feedback.hasReviewFeedback === expected.hasReviewFeedback;
  if (!sameRevision || !matches)
    throw new Error('Evidence content does not match the selected record.');
  return result;
}
