import * as v from 'valibot';
import { saveSpecSchema } from './factory';
const text = (max = 2000) => v.pipe(v.string(), v.maxLength(max));
const id = v.pipe(text(240), v.minLength(1));
export const triageResultSchema = v.strictObject({
  disposition: v.picklist([
    'implement',
    'investigate',
    'clarify',
    'duplicate',
    'defer',
    'decline',
  ]),
  summary: text(),
  priority: v.picklist(['low', 'normal', 'high']),
  missingInformation: v.pipe(v.array(text(500)), v.maxLength(12)),
  candidateIds: v.pipe(v.array(id), v.maxLength(10)),
});
export const planningInputSchema = v.strictObject({
  requestKey: id,
  expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  message: v.pipe(text(12000), v.trim(), v.minLength(1)),
});
export const questionInputSchema = v.strictObject({
  ...saveSpecSchema.entries,
  question: v.strictObject({
    id,
    question: text(240),
    blocking: v.boolean(),
    answer: v.nullable(text()),
  }),
});
export const planningStateSchema = v.strictObject({
  sessionId: v.nullable(id),
  plannerStarted: v.boolean(),
  contextCapturedAt: v.nullable(id),
  model: v.nullable(id),
  contextStale: v.boolean(),
  triage: v.nullable(triageResultSchema),
  triageModel: v.nullable(id),
  triageSubmissionId: v.nullable(id),
  activity: v.picklist(['idle', 'pending', 'completed', 'failed']),
  error: v.nullable(text()),
  submissionId: v.nullable(id),
});
export type FactoryPlanningState = v.InferOutput<typeof planningStateSchema>;
