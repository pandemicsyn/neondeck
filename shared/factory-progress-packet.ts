import * as v from 'valibot';
import { deliveryRevisionSchema } from './factory-progress';
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const text = v.pipe(v.string(), v.maxLength(128000));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const progressEvidenceInputSchema = v.strictObject({
  version: v.literal(1),
  grantId: label,
  requestId: label,
  revision: deliveryRevisionSchema,
  repairOrdinal: v.pipe(natural, v.minValue(1), v.maxValue(2)),
  releasedBrief: v.pipe(v.string(), v.minLength(1), v.maxLength(64000)),
  proposedInstructions: v.pipe(v.string(), v.minLength(1), v.maxLength(20000)),
  candidates: v.pipe(
    v.array(
      v.strictObject({
        revision: deliveryRevisionSchema,
        diff: v.nullable(text),
        observations: v.pipe(
          v.array(
            v.strictObject({
              ref: label,
              kind: v.picklist(['verification', 'review', 'feedback']),
              body: text,
              fingerprint: hash,
            }),
          ),
          v.maxLength(30),
        ),
      }),
    ),
    v.minLength(1),
    v.maxLength(3),
  ),
  priorRepairs: v.pipe(
    v.array(
      v.strictObject({
        ordinal: v.pipe(natural, v.minValue(1), v.maxValue(2)),
        revision: deliveryRevisionSchema,
        instructions: v.pipe(v.string(), v.minLength(1), v.maxLength(20000)),
      }),
    ),
    v.maxLength(2),
  ),
  remainingBudget: v.strictObject({
    durationMs: natural,
    repairs: v.pipe(natural, v.maxValue(2)),
  }),
  missingEvidence: v.pipe(v.array(label), v.maxLength(100)),
  omittedEvidence: v.pipe(v.array(label), v.maxLength(100)),
});
export const progressEvidencePacketSchema = v.strictObject({
  ...progressEvidenceInputSchema.entries,
  fingerprints: v.pipe(
    v.array(
      v.strictObject({
        revision: deliveryRevisionSchema,
        candidate: hash,
        failures: hash,
      }),
    ),
    v.maxLength(3),
  ),
  evidenceDigest: hash,
});
export type ProgressEvidencePacket = v.InferOutput<
  typeof progressEvidencePacketSchema
>;
