import * as v from 'valibot';
import { deliveryProgressEvidenceContentSchema } from '../../../shared/factory-delivery-progress-evidence';
import { getJson, type ApiRequestOptions } from './http';
export async function getFactoryDeliveryProgressEvidence(
  deliveryId: string,
  evidenceId: string,
  options: ApiRequestOptions = {},
) {
  const value = v.parse(
    deliveryProgressEvidenceContentSchema,
    await getJson<unknown>(
      `/api/factory-delivery/deliveries/${encodeURIComponent(deliveryId)}/evidence/${encodeURIComponent(evidenceId)}`,
      options,
    ),
  );
  if (
    value.deliveryId !== deliveryId ||
    value.evidenceId !== evidenceId ||
    value.assessment.assessmentId !== evidenceId
  )
    throw new Error('Progress evidence identity does not match this request.');
  return value;
}
