import * as v from 'valibot';

export const prReviewAssistInputSchema = v.object({
  reviewId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  attemptId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  watchId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  ref: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  repo: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const reviewSeveritySchema = v.picklist(['critical', 'major', 'minor', 'nit']);
const reviewSideSchema = v.picklist(['RIGHT', 'LEFT']);
const reviewAnchorSchema = v.variant('kind', [
  v.object({
    kind: v.literal('inline'),
    side: reviewSideSchema,
    line: v.pipe(v.number(), v.integer(), v.minValue(1)),
    startLine: v.optional(
      v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
    ),
    startSide: v.optional(v.nullable(reviewSideSchema)),
  }),
  v.object({
    kind: v.literal('report-only'),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  }),
]);

export const reviewAssistFindingSchema = v.object({
  severity: reviewSeveritySchema,
  path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  anchor: reviewAnchorSchema,
  summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
  suggestedFix: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(4_000),
  ),
  confidence: v.optional(v.picklist(['high', 'medium', 'low'])),
});

export const reviewAssistStructuredOutputSchema = v.object({
  overview: v.object({
    summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000)),
    changeMap: v.array(
      v.object({
        path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
        summary: v.pipe(
          v.string(),
          v.trim(),
          v.minLength(1),
          v.maxLength(2_000),
        ),
        risk: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1_000))),
      }),
    ),
    risks: v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
      v.maxLength(20),
    ),
    checks: v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
      v.maxLength(20),
    ),
  }),
  findings: v.pipe(v.array(reviewAssistFindingSchema), v.maxLength(100)),
});

export const prReviewAssistOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.literal('pr_review_assist'),
  changed: v.boolean(),
  message: v.string(),
});

export type PrReviewAssistInput = v.InferInput<
  typeof prReviewAssistInputSchema
>;
export type ReviewAssistStructuredOutput = v.InferOutput<
  typeof reviewAssistStructuredOutputSchema
>;
export type ReviewAssistFinding = v.InferOutput<
  typeof reviewAssistFindingSchema
>;
