import * as v from 'valibot';
import {
  deliveryProgressBindingSchema,
  deliveryProgressResultSchema,
} from './factory-progress';
import { progressEvidencePacketSchema } from './factory-progress-packet';
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const progressReviewRequestSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  binding: deliveryProgressBindingSchema,
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  thinkingLevel: v.optional(
    v.picklist(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  ),
  packet: progressEvidencePacketSchema,
  maxDurationMs: v.pipe(natural, v.minValue(1), v.maxValue(180000)),
  deadlineAt: v.pipe(natural, v.minValue(1)),
  maxTokens: v.optional(
    v.pipe(natural, v.minValue(1), v.maxValue(32000)),
    16000,
  ),
});
export type ProgressReviewRequest = v.InferOutput<
  typeof progressReviewRequestSchema
>;

export const progressReviewResultSchema = v.strictObject({
  ...deliveryProgressResultSchema.entries,
  submissionId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  totalTokens: v.pipe(natural, v.minValue(1)),
  durationMs: natural,
  completedAt: v.pipe(v.string(), v.isoTimestamp()),
});
