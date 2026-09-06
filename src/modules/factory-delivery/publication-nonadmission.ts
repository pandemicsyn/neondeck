import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import type {
  DeliveryPipeline,
  DeliveryEffect,
} from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { codingDigest } from '../factory';
import {
  changeDelivery,
  deliveryReceipt,
  interveneDelivery,
  requireDelivery,
} from './service-records';

/** Raised only before Git push is invoked, never from Git or post-push checks. */
export class PublicationPushNotAttemptedError extends Error {
  constructor() {
    super(
      'The final publication guard rejected this push before Git was invoked.',
    );
  }
}
const receiptSchema = v.strictObject({
  kind: v.literal('publication-push-not-attempted'),
  effectId: v.string(),
  candidateDigest: v.string(),
});
export function recoverPushNonadmission(
  p: DeliveryPipeline,
  effect: DeliveryEffect,
  paths: RuntimePaths,
) {
  if (effect.kind !== 'push' || !effect.receiptRef) return false;
  if (statSync(effect.receiptRef).size > 4096) return false;
  const raw: unknown = JSON.parse(readFileSync(effect.receiptRef, 'utf8'));
  const parsed = v.safeParse(receiptSchema, raw);
  if (!parsed.success) return false;
  if (
    effect.receiptRef !==
      join(
        paths.home,
        'factory-delivery',
        p.pipelineId,
        `${codingDigest(raw)}.json`,
      ) ||
    parsed.output.effectId !== effect.id ||
    parsed.output.candidateDigest !== effect.revision.candidateDigest
  )
    throw new Error('Push nonadmission receipt binding mismatch');
  interveneDelivery(
    p.pipelineId,
    'scope',
    'Git push was not attempted because its final publication guard rejected admission. Review the existing PR and delivery authority in planning; the retained candidate has not been published.',
    paths,
  );
  changeDelivery(
    p.pipelineId,
    {
      type: 'reconcile-effect',
      id: effect.id,
      observation: 'not-delivered',
      receiptRef: effect.receiptRef,
    },
    paths,
  );
  return true;
}
export function settlePushNonadmission(
  p: DeliveryPipeline,
  effect: DeliveryEffect,
  error: unknown,
  paths: RuntimePaths,
) {
  if (
    !(error instanceof PublicationPushNotAttemptedError) ||
    effect.kind !== 'push'
  )
    return false;
  const current = requireDelivery(p.pipelineId, paths);
  const actual = current.effects.find((e) => e.id === effect.id);
  if (!actual || actual.state !== 'in-flight' || actual.receiptRef !== null)
    throw new Error('Push nonadmission claim is not current');
  const ref = deliveryReceipt(
    p.pipelineId,
    {
      kind: 'publication-push-not-attempted',
      effectId: effect.id,
      candidateDigest: effect.revision.candidateDigest,
    },
    paths,
  );
  const bound = changeDelivery(
    p.pipelineId,
    { type: 'bind-effect-receipt', id: effect.id, receiptRef: ref },
    paths,
  );
  return recoverPushNonadmission(
    bound,
    bound.effects.find((e) => e.id === effect.id)!,
    paths,
  );
}
