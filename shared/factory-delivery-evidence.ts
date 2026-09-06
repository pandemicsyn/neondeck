import * as v from 'valibot';
import {
  deliveryRevisionSchema,
  deliveryEffectSchema,
  deliveryFeedbackObservationSchema,
  deliveryFeedbackClassificationSchema,
} from './factory-delivery';
const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const label = v.pipe(text(500), v.minLength(1));
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const deliveryEvidenceReadInputSchema = v.strictObject({
  deliveryId: label,
  evidenceId: label,
});
const certificationContentSchema = v.strictObject({
  deliveryId: label,
  evidenceId: label,
  kind: v.picklist(['verification', 'review']),
  result: v.picklist(['passed', 'failed', 'blocked']),
  revision: deliveryRevisionSchema,
  currentRevision: deliveryRevisionSchema,
  isCurrent: v.boolean(),
  effect: v.strictObject({
    state: deliveryEffectSchema.entries.state,
    settled: v.boolean(),
    accounted: v.boolean(),
    eligible: v.boolean(),
    eligibilityReason: v.picklist([
      'eligible',
      'prior-revision',
      'pending',
      'unaccounted',
      'not-passed',
      'superseded',
      'inactive-delivery',
    ]),
  }),
  summary: text(4000),
  checks: v.pipe(
    v.array(
      v.strictObject({
        command: text(2000),
        passed: v.boolean(),
        exitCode: v.nullable(v.pipe(v.number(), v.safeInteger())),
        durationMs: natural,
        output: text(4096),
        truncated: v.boolean(),
      }),
    ),
    v.maxLength(16),
  ),
  findings: v.pipe(
    v.array(
      v.strictObject({
        severity: v.picklist(['critical', 'high', 'medium', 'low']),
        path: v.nullable(text(500)),
        line: v.pipe(natural, v.minValue(1)),
        description: text(2000),
      }),
    ),
    v.maxLength(20),
  ),
  acceptanceCriteria: v.pipe(
    v.array(v.strictObject({ id: text(240), text: text(240) })),
    v.maxLength(100),
  ),
  acceptanceCriteriaRole: v.literal('review-inputs'),
  truncated: v.boolean(),
});
export const deliveryFeedbackContentSchema = v.strictObject({
  ...certificationContentSchema.entries,
  kind: v.literal('feedback'),
  result: v.picklist([
    'observed',
    'no-action',
    'scoped-repair',
    'scope-change',
  ]),
  effect: v.strictObject({
    ...certificationContentSchema.entries.effect.entries,
    state: v.union([
      deliveryEffectSchema.entries.state,
      v.literal('unplanned'),
    ]),
    eligible: v.literal(false),
    eligibilityReason: v.literal('external-observation'),
  }),
  feedback: v.strictObject({
    fingerprint: deliveryFeedbackObservationSchema.entries.fingerprint,
    publishedHeadSha:
      deliveryFeedbackObservationSchema.entries.publishedHeadSha,
    ciFailed: v.boolean(),
    hasReviewFeedback: v.boolean(),
    packet: text(12000),
    packetTruncated: v.boolean(),
    classification: v.nullable(
      v.strictObject({
        result: deliveryFeedbackClassificationSchema.entries.result,
        bound: v.boolean(),
      }),
    ),
  }),
});
export const deliveryEvidenceContentSchema = v.variant('kind', [
  certificationContentSchema,
  deliveryFeedbackContentSchema,
]);
export type DeliveryFeedbackContent = v.InferOutput<
  typeof deliveryFeedbackContentSchema
>;
export type DeliveryEvidenceContent = v.InferOutput<
  typeof deliveryEvidenceContentSchema
>;
