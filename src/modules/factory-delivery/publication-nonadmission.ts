import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  constructor(cause?: unknown) {
    super(
      `Git push was not invoked: ${cause instanceof Error ? cause.message : 'publication preparation rejected'}`,
    );
  }
}
export class DeliveryEffectNotDispatchedError extends Error {}
const receiptSchema = v.strictObject({
  kind: v.picklist([
    'publication-push-not-attempted',
    'delivery-effect-not-dispatched',
  ]),
  effectId: v.string(),
  candidateDigest: v.string(),
});
export function recoverEffectNonadmission(
  p: DeliveryPipeline,
  effect: DeliveryEffect,
  paths: RuntimePaths,
) {
  if (
    !effect.receiptRef ||
    dirname(effect.receiptRef) !==
      join(paths.home, 'factory-delivery', p.pipelineId)
  )
    return false;
  if (statSync(effect.receiptRef).size > 4096) return false;
  const raw: unknown = JSON.parse(readFileSync(effect.receiptRef, 'utf8'));
  const parsed = v.safeParse(receiptSchema, raw);
  if (!parsed.success) return false;
  if (
    parsed.output.kind === 'publication-push-not-attempted' &&
    effect.kind !== 'push'
  )
    throw new Error('Nonadmission effect kind mismatch');
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
    'The operation was not dispatched because preparation or authority rejected admission. Review the retained evidence and delivery authority in planning.',
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
export function settleEffectNonadmission(
  p: DeliveryPipeline,
  effect: DeliveryEffect,
  error: unknown,
  paths: RuntimePaths,
) {
  if (
    !(error instanceof DeliveryEffectNotDispatchedError) &&
    (!(error instanceof PublicationPushNotAttemptedError) ||
      effect.kind !== 'push')
  )
    return false;
  const current = requireDelivery(p.pipelineId, paths);
  const actual = current.effects.find((e) => e.id === effect.id);
  if (!actual || actual.state !== 'in-flight' || actual.receiptRef !== null)
    throw new Error('Push nonadmission claim is not current');
  const ref = deliveryReceipt(
    p.pipelineId,
    {
      kind:
        error instanceof DeliveryEffectNotDispatchedError
          ? 'delivery-effect-not-dispatched'
          : 'publication-push-not-attempted',
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
  return recoverEffectNonadmission(
    bound,
    bound.effects.find((e) => e.id === effect.id)!,
    paths,
  );
}
