import * as v from 'valibot';
import {
  deliveryAuthorizationSchema,
  deliveryPipelineSchema,
  deliveryRevisionSchema,
} from './factory-delivery';

const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
export const deliveryGrantPreviewSchema = v.strictObject({
  workItemId: label,
  repoId: label,
  revision: deliveryRevisionSchema,
  target: deliveryAuthorizationSchema.entries.target,
  configFingerprint: deliveryAuthorizationSchema.entries.configFingerprint,
  checkCommands: deliveryAuthorizationSchema.entries.checkCommands,
  maxRepairAttempts: v.literal(2),
  totalExecutionMs: v.literal(10800000),
  initialExecutionMs: v.pipe(natural, v.maxValue(10800000)),
  maxAttemptMs: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(2700000),
  ),
  publish: v.literal('draft-pr-only'),
  merge: v.literal(false),
  deploy: v.literal(false),
});
export const deliveryGrantInputSchema = v.strictObject({
  requestId: label,
  confirm: v.literal(true),
  preview: deliveryGrantPreviewSchema,
});
export const deliveryControlInputSchema = v.strictObject({
  expectedVersion: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  reason: label,
});
export const deliveryDetailSchema = v.strictObject({
  pipeline: deliveryPipelineSchema,
  budget: v.strictObject({
    consumedExecutionMs: natural,
    reservedExecutionMs: natural,
    remainingExecutionMs: natural,
    repairsUsed: natural,
    repairsRemaining: natural,
  }),
  plannerSessionId: v.nullable(label),
  planningWorkId: label,
  nextAction: v.picklist([
    'running',
    'human-scope',
    'human-budget',
    'human-authority',
    'reconcile',
    'complete',
  ]),
});
export const deliveryStateSchema = v.strictObject({
  deliveries: v.array(deliveryDetailSchema),
});
export type DeliveryGrantPreview = v.InferOutput<
  typeof deliveryGrantPreviewSchema
>;
