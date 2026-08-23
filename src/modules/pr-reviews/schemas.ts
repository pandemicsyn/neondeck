import * as v from 'valibot';

export const prReviewRecommendationSchema = v.picklist([
  'approve',
  'needs-human',
]);

export const prReviewRecommendationReasonSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(300),
);

export const prReviewBriefingSummarySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(4_000),
);

export const prReviewBriefingChangeMapSchema = v.pipe(
  v.array(
    v.object({
      path: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1_000)),
      summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2_000)),
      risk: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1_000))),
    }),
  ),
  v.maxLength(4_096),
);

export const prReviewBriefingRisksSchema = v.pipe(
  v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000))),
  v.maxLength(20),
);

export const prReviewBriefingOverviewSchema = v.object({
  schemaVersion: v.literal(1),
  recommendation: prReviewRecommendationSchema,
  recommendationReason: prReviewRecommendationReasonSchema,
  summary: prReviewBriefingSummarySchema,
  changeMap: prReviewBriefingChangeMapSchema,
  risks: prReviewBriefingRisksSchema,
});

export type PrReviewRecommendation = v.InferOutput<
  typeof prReviewRecommendationSchema
>;
export type PrReviewBriefingOverview = v.InferOutput<
  typeof prReviewBriefingOverviewSchema
>;
