import type { JsonValue } from '@flue/runtime';
import * as v from 'valibot';

export type SkillPatchMutationSource = 'user' | 'neon' | 'workflow';

export type SkillPatchCandidateRecord = {
  id: string;
  target: 'skill';
  status: 'proposed' | 'applied' | 'rejected' | 'archived';
  action: 'patch';
  skillId: string;
  patch: JsonValue;
  reason: string | null;
  reviewId: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const skillPatchOperationSchema = v.variant('type', [
  v.object({
    type: v.literal('append-section'),
    heading: nonEmptyStringSchema,
    content: nonEmptyStringSchema,
  }),
  v.object({
    type: v.literal('replace-file'),
    afterContent: nonEmptyStringSchema,
  }),
]);
export const skillPatchProposeInputSchema = v.object({
  skillId: nonEmptyStringSchema,
  summary: v.optional(v.string()),
  reason: v.optional(v.string()),
  reviewId: v.optional(nonEmptyStringSchema),
  operation: skillPatchOperationSchema,
});
export const skillPatchListInputSchema = v.object({
  status: v.optional(
    v.picklist(['proposed', 'applied', 'rejected', 'archived']),
  ),
  skillId: v.optional(nonEmptyStringSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const skillPatchDecideInputSchema = v.object({
  id: nonEmptyStringSchema,
  reason: v.optional(v.string()),
  actor: v.optional(v.picklist(['user', 'neon', 'workflow'])),
});
export const skillPatchRestoreInputSchema = v.object({
  id: nonEmptyStringSchema,
  confirm: v.literal(true),
  reason: v.optional(v.string()),
});
export const skillPatchActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
});
