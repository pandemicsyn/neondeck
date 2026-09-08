import { deliveryEvidenceDisplayMaxBytes } from './factory-delivery-evidence';
import { githubRepositoryIdentitySchema } from './factory-github';
import * as v from 'valibot';
import {
  deliveryAuthorizationSchema,
  deliveryPipelineSchema,
  deliveryRevisionSchema,
  validationPolicySchema,
  publicationGrantSchema,
} from './factory-delivery';

const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
export const validationGrantPreviewSchema = v.strictObject({
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
  publish: v.literal(false),
  validationPolicy: validationPolicySchema,
  merge: v.literal(false),
  deploy: v.literal(false),
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
    'awaiting-publication',
    'fresh-release-required',
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
export const validationGrantInputSchema = v.strictObject({
  requestId: label,
  confirm: v.literal(true),
  preview: validationGrantPreviewSchema,
});
export const publicationPreviewSchema = v.strictObject({
  pipelineId: label,
  expectedVersion: deliveryControlInputSchema.entries.expectedVersion,
  revision: deliveryRevisionSchema,
  evidenceFingerprint: publicationGrantSchema.entries.evidenceFingerprint,
  configFingerprint: publicationGrantSchema.entries.configFingerprint,
  target: publicationGrantSchema.entries.target,
  publish: v.literal('draft-pr-only'),
  feedbackRepairs: v.literal(true),
  merge: v.literal(false),
  deploy: v.literal(false),
});
export const publicationGrantInputSchema = v.strictObject({
  requestId: label,
  confirm: v.literal(true),
  preview: publicationPreviewSchema,
});
export const publicationReadinessSchema = v.strictObject({
  ready: v.boolean(),
  blocker: v.nullable(
    v.picklist([
      'validation-required',
      'human-intervention',
      'publication-setup',
      'authority-changed',
      'already-authorized',
    ]),
  ),
  message: label,
  preview: v.nullable(publicationPreviewSchema),
});

export const publicationSetupInputSchema = v.strictObject({
  tokenEnv: v.optional(githubRepositoryIdentitySchema.entries.tokenEnv),
});
export const publicationSetupResultSchema = v.strictObject({
  publication: v.pipe(
    v.array(
      v.strictObject({
        repoId: label,
        repositoryId: githubRepositoryIdentitySchema.entries.repositoryId,
        tokenEnv: githubRepositoryIdentitySchema.entries.tokenEnv,
      }),
    ),
    v.length(1),
  ),
});
export const reviewedDiffSchema = v.strictObject({
  pipelineId: label,
  revision: deliveryRevisionSchema,
  evidenceFingerprint: publicationGrantSchema.entries.evidenceFingerprint,
  diff: v.nullable(
    v.pipe(v.string(), v.maxLength(deliveryEvidenceDisplayMaxBytes)),
  ),
  unavailableReason: v.nullable(label),
});
