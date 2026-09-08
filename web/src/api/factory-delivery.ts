import { validationPolicySchema } from '../../../shared/factory-delivery';
import { deliveryEvidenceContentSchema } from '../../../shared/factory-delivery-evidence';
import * as v from 'valibot';
import {
  publicationSetupInputSchema,
  publicationSetupResultSchema,
  reviewedDiffSchema,
  publicationReadinessSchema,
  publicationGrantInputSchema,
  deliveryDetailSchema,
  deliveryStateSchema,
  deliveryControlInputSchema,
} from '../../../shared/factory-delivery-api';
import type {
  DeliveryRevision,
  DeliveryEvidence,
  DeliveryFeedback,
} from '../../../shared/factory-delivery';
import { getJson, postJson, type ApiRequestOptions } from './http';

// Validate each HTTP boundary with the canonical contract, avoiding schema drift.
export { deliveryDetailSchema };
export type { DeliveryRevision };
export type DeliveryDetail = v.InferOutput<typeof deliveryDetailSchema>;
const prefix = '/api/factory-delivery';
export async function getFactoryDeliveryState(options: ApiRequestOptions = {}) {
  return v.parse(
    deliveryStateSchema,
    await getJson<unknown>(`${prefix}/state`, options),
  );
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

export async function getFactoryPublication(
  id: string,
  options: ApiRequestOptions = {},
) {
  const result = v.parse(
    publicationReadinessSchema,
    await getJson<unknown>(
      `${prefix}/deliveries/${encodeURIComponent(id)}/publication`,
      options,
    ),
  );
  if (result.preview && result.preview.pipelineId !== id)
    throw new Error('Publication preview belongs to another task.');
  return result;
}
export async function grantFactoryPublication(
  input: v.InferOutput<typeof publicationGrantInputSchema>,
) {
  const body = v.parse(publicationGrantInputSchema, input);
  const result = matchDelivery(
    v.parse(
      deliveryDetailSchema,
      await postJson<unknown>(
        `${prefix}/deliveries/${encodeURIComponent(body.preview.pipelineId)}/publication-grants`,
        body,
      ),
    ),
    body.preview.pipelineId,
  );
  const receipt = result.pipeline.publication;
  if (
    !receipt ||
    receipt.requestId !== body.requestId ||
    receipt.evidenceFingerprint !== body.preview.evidenceFingerprint ||
    receipt.configFingerprint !== body.preview.configFingerprint ||
    JSON.stringify(receipt.revision) !==
      JSON.stringify(body.preview.revision) ||
    JSON.stringify(receipt.target) !== JSON.stringify(body.preview.target)
  )
    throw new Error('Publication receipt does not match this approval.');
  return result;
}

export async function getFactoryValidationPolicy(
  repoId: string,
  options: ApiRequestOptions = {},
) {
  return v.parse(
    validationPolicySchema,
    await getJson<unknown>(
      `${prefix}/validation-policy/${encodeURIComponent(repoId)}`,
      options,
    ),
  );
}

export async function setupFactoryPublication(
  repoId: string,
  tokenEnv: string,
) {
  const result = v.parse(
    publicationSetupResultSchema,
    await postJson<unknown>(
      `${prefix}/publication-setup/${encodeURIComponent(repoId)}`,
      v.parse(publicationSetupInputSchema, { tokenEnv }),
    ),
  );
  if (
    result.publication[0].repoId !== repoId ||
    result.publication[0].tokenEnv !== tokenEnv
  )
    throw new Error(
      'Publication setup receipt does not match this repository and credential reference.',
    );
  return result;
}

export async function getFactoryReviewedDiff(
  id: string,
  options: ApiRequestOptions = {},
) {
  const result = v.parse(
    reviewedDiffSchema,
    await getJson<unknown>(
      `${prefix}/deliveries/${encodeURIComponent(id)}/reviewed-diff`,
      options,
    ),
  );
  if (result.pipelineId !== id)
    throw new Error('Reviewed diff belongs to another delivery.');
  return result;
}
