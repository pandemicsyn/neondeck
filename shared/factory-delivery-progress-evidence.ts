import * as v from 'valibot';
import {
  deliveryProgressAssessmentSchema,
  deliveryRevisionSchema,
} from './factory-progress';
const text = (max: number) => v.pipe(v.string(), v.maxLength(max));
const label = v.pipe(text(500), v.minLength(1));
export const deliveryProgressEvidenceContentSchema = v.strictObject({
  kind: v.literal('progress'),
  deliveryId: label,
  evidenceId: label,
  currentRevision: deliveryRevisionSchema,
  isCurrent: v.boolean(),
  assessment: deliveryProgressAssessmentSchema,
  releasedBrief: text(8000),
  candidates: v.pipe(
    v.array(
      v.strictObject({
        revision: deliveryRevisionSchema,
        diff: v.nullable(text(12000)),
        diffTruncated: v.boolean(),
        observations: v.pipe(
          v.array(
            v.strictObject({
              ref: label,
              kind: v.picklist(['verification', 'review', 'feedback']),
              body: text(4000),
              truncated: v.boolean(),
            }),
          ),
          v.maxLength(30),
        ),
      }),
    ),
    v.maxLength(3),
  ),
  priorRepairs: v.pipe(
    v.array(
      v.strictObject({
        ordinal: v.pipe(
          v.number(),
          v.safeInteger(),
          v.minValue(1),
          v.maxValue(2),
        ),
        revision: deliveryRevisionSchema,
        instructions: text(4000),
      }),
    ),
    v.maxLength(2),
  ),
  missingEvidence: v.pipe(v.array(label), v.maxLength(100)),
  omittedEvidence: v.pipe(v.array(label), v.maxLength(100)),
  truncated: v.boolean(),
});
export type DeliveryProgressEvidenceContent = v.InferOutput<
  typeof deliveryProgressEvidenceContentSchema
>;
