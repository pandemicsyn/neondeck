import * as v from 'valibot';
import { deliveryRevisionSchema } from './factory-delivery-revision';
export { deliveryRevisionSchema } from './factory-delivery-revision';
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const version = v.pipe(natural, v.minValue(1));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const time = v.pipe(v.string(), v.isoTimestamp());
const instructions = v.pipe(v.string(), v.minLength(1), v.maxLength(20000));
export const deliveryProgressBindingSchema = v.strictObject({
  assessmentId: label,
  grantId: label,
  revision: deliveryRevisionSchema,
  repairOrdinal: v.pipe(version, v.maxValue(2)),
  requestId: label,
  inputDigest: hash,
  evidenceDigest: hash,
});
export const deliveryProgressResultSchema = v.pipe(
  v.strictObject({
    ...deliveryProgressBindingSchema.entries,
    decision: v.picklist(['continue', 'change-approach', 'escalate']),
    rationale: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
    evidenceRefs: v.pipe(v.array(label), v.minLength(1), v.maxLength(100)),
    nextInstructions: v.nullable(instructions),
  }),
  v.check((r) =>
    r.decision === 'change-approach'
      ? r.nextInstructions !== null
      : r.nextInstructions === null,
  ),
);
export const deliveryProgressAssessmentSchema = v.strictObject({
  ...deliveryProgressBindingSchema.entries,
  evidenceRefs: v.pipe(v.array(label), v.minLength(1), v.maxLength(100)),
  instructions,
  state: v.picklist(['reserved', 'in-flight', 'uncertain', 'settled']),
  sourceVersion: version,
  remainingExecutionMs: version,
  reservedAt: time,
  deadlineAt: time,
  reservedExecutionMs: v.pipe(version, v.maxValue(180000)),
  executionMs: v.nullable(natural),
  completedAt: v.nullable(time),
  submissionId: v.nullable(label),
  resultId: v.nullable(label),
  result: v.nullable(deliveryProgressResultSchema),
});
export const deliveryProgressStateSchema = v.strictObject({
  limits: v.strictObject({
    maxAssessments: v.literal(2),
    maxAssessmentsPerRepair: v.literal(1),
    maxAssessmentMs: v.literal(180000),
  }),
  assessments: v.pipe(
    v.array(deliveryProgressAssessmentSchema),
    v.maxLength(2),
  ),
});
export const deliveryProgressReservationSchema = v.strictObject({
  pipelineId: label,
  expectedVersion: version,
  ...deliveryProgressBindingSchema.entries,
  instructions,
  evidenceRefs: v.pipe(v.array(label), v.minLength(1), v.maxLength(100)),
});
export const deliveryProgressCommandSchema = v.strictObject({
  pipelineId: label,
  expectedVersion: version,
  assessmentId: label,
  action: v.variant('type', [
    v.strictObject({ type: v.literal('start') }),
    v.strictObject({ type: v.literal('bind-submission'), submissionId: label }),
    v.strictObject({ type: v.literal('uncertain') }),
    v.strictObject({
      type: v.literal('settle'),
      submissionId: label,
      resultId: label,
      executionMs: v.nullable(natural),
      completedAt: v.nullable(time),
      result: v.nullable(deliveryProgressResultSchema),
    }),
  ]),
});
export type DeliveryProgressBinding = v.InferOutput<
  typeof deliveryProgressBindingSchema
>;
export type DeliveryProgressResult = v.InferOutput<
  typeof deliveryProgressResultSchema
>;
export type DeliveryProgressAssessment = v.InferOutput<
  typeof deliveryProgressAssessmentSchema
>;
export type DeliveryProgressReservation = v.InferOutput<
  typeof deliveryProgressReservationSchema
>;
