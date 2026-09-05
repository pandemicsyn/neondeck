import * as v from 'valibot';
import {
  factoryDetailSchema,
  revisionSchema,
  manualIntakeSchema,
  saveSpecSchema,
  releaseInputSchema,
  transitionSchema,
  updateSourceSchema,
} from './factory';
// Internal planning snapshots may omit revisions. Renderable API views may not.
export const factoryDetailViewSchema = v.strictObject({
  ...factoryDetailSchema.entries,
  revisions: v.pipe(v.array(revisionSchema), v.minLength(1)),
});
export const factoryAcceptedSchema = v.object({ accepted: v.literal(true) });
export const factoryPlanningAdmissionSchema = v.object({
  sessionId: v.pipe(v.string(), v.minLength(1)),
  intentId: v.pipe(v.string(), v.minLength(1)),
});
export const factoryAbortSchema = v.object({ aborted: v.boolean() });
export type FactoryMutationArgs =
  | [action: 'create', input: v.InferOutput<typeof manualIntakeSchema>]
  | [action: 'spec', input: v.InferOutput<typeof saveSpecSchema>]
  | [action: 'release', input: v.InferOutput<typeof releaseInputSchema>]
  | [action: 'transition', input: v.InferOutput<typeof transitionSchema>]
  | [action: 'source', input: v.InferOutput<typeof updateSourceSchema>];
