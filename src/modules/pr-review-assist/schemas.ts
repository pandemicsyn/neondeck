import * as v from 'valibot';
import {
  prReviewBriefingChangeMapSchema,
  prReviewBriefingRisksSchema,
  prReviewBriefingSummarySchema,
  prReviewRecommendationReasonSchema,
  prReviewRecommendationSchema,
} from '../pr-reviews/schemas';

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));

export const prReviewAssistInputSchema = v.pipe(
  v.object({
    reviewId: v.optional(nonEmptyString),
    attemptId: v.optional(nonEmptyString),
    watchId: v.optional(nonEmptyString),
    ref: v.optional(nonEmptyString),
    repo: v.optional(nonEmptyString),
    prNumber: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    repoFullName: v.optional(nonEmptyString),
    headSha: v.optional(nonEmptyString),
    baseSha: v.optional(nonEmptyString),
    baseRef: v.optional(nonEmptyString),
  }),
  v.check(
    (input) =>
      (!input.reviewId && !input.attemptId) ||
      Boolean(
        input.reviewId &&
        input.attemptId &&
        input.ref &&
        input.repoFullName &&
        input.prNumber &&
        input.headSha &&
        input.baseSha &&
        input.baseRef,
      ),
    'A durable review binding requires reviewId, attemptId, ref, repoFullName, prNumber, headSha, baseSha, and baseRef together.',
  ),
);

const prReviewAgentInitialDataEntries = {
  model: nonEmptyString,
  thinkingLevel: v.picklist([
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
  ]),
  instructions: nonEmptyString,
  prepared: v.object({
    input: prReviewAssistInputSchema,
    facts: v.unknown(),
    promptContext: v.unknown(),
  }),
  workspace: v.variant('available', [
    v.object({
      available: v.literal(true),
      repoId: nonEmptyString,
      repoFullName: nonEmptyString,
      repoPath: nonEmptyString,
      headSha: nonEmptyString,
      baseSha: v.nullable(nonEmptyString),
      mergeBase: v.nullable(nonEmptyString),
    }),
    v.object({
      available: v.literal(false),
      reason: nonEmptyString,
    }),
  ]),
  prompt: nonEmptyString,
  skills: v.optional(v.array(v.unknown())),
  tools: v.optional(v.array(v.unknown())),
  actions: v.optional(v.array(v.unknown())),
  subagents: v.optional(v.array(v.unknown())),
};

const thinkingLevelSchema = v.picklist([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const prReviewAgentInitialDataSchema = v.union([
  v.strictObject({
    ...prReviewAgentInitialDataEntries,
    schema: v.literal('neondeck.pr-review-agent-context.v2'),
    exploreModel: nonEmptyString,
    exploreThinkingLevel: thinkingLevelSchema,
  }),
  v.strictObject({
    ...prReviewAgentInitialDataEntries,
    schema: v.optional(v.literal('neondeck.pr-review-agent-context.v1')),
  }),
]);

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

const reviewAssistStructuredOutputEntries = {
  overview: v.object({
    recommendation: prReviewRecommendationSchema,
    recommendationReason: prReviewRecommendationReasonSchema,
    summary: prReviewBriefingSummarySchema,
    changeMap: prReviewBriefingChangeMapSchema,
    risks: prReviewBriefingRisksSchema,
    checks: v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000))),
      v.maxLength(20),
    ),
    nextActions: v.optional(
      v.pipe(
        v.array(
          v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000)),
        ),
        v.maxLength(20),
      ),
    ),
  }),
  findings: v.pipe(v.array(reviewAssistFindingSchema), v.maxLength(100)),
} as const;

export const reviewAssistStructuredOutputSchema = v.object(
  reviewAssistStructuredOutputEntries,
);

export const prReviewAssistOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.literal('pr_review_assist'),
  changed: v.boolean(),
  message: v.string(),
});

export type PrReviewAssistInput = v.InferOutput<
  typeof prReviewAssistInputSchema
>;
export type ReviewAssistStructuredOutput = v.InferOutput<
  typeof reviewAssistStructuredOutputSchema
>;
export type ReviewAssistFinding = v.InferOutput<
  typeof reviewAssistFindingSchema
>;
