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

export const REVIEW_PRESENTATION_LIMITS = {
  slidesPerArtifact: 12,
  markdownSlidesPerArtifact: 4,
  markdownCharacters: 24_000,
} as const;

const reviewPresentationSourceSchema = v.picklist([
  'pr-facts',
  'checks',
  'risks',
  'change-map',
  'seeded-comments',
  'report-only-findings',
  'findings',
  'next-actions',
]);

const reviewPresentationSourceSlideSchema = v.object({
  kind: v.literal('source'),
  source: reviewPresentationSourceSchema,
  layout: v.picklist(['facts', 'columns', 'change-map', 'findings']),
  title: v.optional(
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  ),
});

const reviewPresentationMarkdownSlideSchema = v.object({
  kind: v.literal('markdown'),
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  markdown: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(6_000)),
  tone: v.optional(
    v.picklist(['neutral', 'correctness', 'security', 'positive']),
    'neutral',
  ),
});

const reviewPresentationArtifactSchema = v.pipe(
  v.array(
    v.variant('kind', [
      reviewPresentationSourceSlideSchema,
      reviewPresentationMarkdownSlideSchema,
    ]),
  ),
  v.maxLength(REVIEW_PRESENTATION_LIMITS.slidesPerArtifact),
  v.check(
    (slides) =>
      slides.filter((slide) => slide.kind === 'markdown').length <=
      REVIEW_PRESENTATION_LIMITS.markdownSlidesPerArtifact,
    `Presentation artifacts can include at most ${REVIEW_PRESENTATION_LIMITS.markdownSlidesPerArtifact} Markdown slides.`,
  ),
);

export const reviewPresentationPlanSchema = v.pipe(
  v.object({
    overview: reviewPresentationArtifactSchema,
    issues: reviewPresentationArtifactSchema,
  }),
  v.check(
    (plan) =>
      [plan.overview, plan.issues].every(
        (artifact) =>
          artifact.reduce(
            (total, slide) =>
              total + (slide.kind === 'markdown' ? slide.markdown.length : 0),
            0,
          ) <= REVIEW_PRESENTATION_LIMITS.markdownCharacters,
      ),
    `Each presentation artifact can include at most ${REVIEW_PRESENTATION_LIMITS.markdownCharacters} Markdown characters.`,
  ),
);

const reviewAssistStructuredOutputEntries = {
  overview: v.object({
    summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000)),
    changeMap: v.pipe(
      v.array(
        v.object({
          path: v.pipe(
            v.string(),
            v.trim(),
            v.minLength(1),
            v.maxLength(1_000),
          ),
          summary: v.pipe(
            v.string(),
            v.trim(),
            v.minLength(1),
            v.maxLength(2_000),
          ),
          risk: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(1_000))),
        }),
      ),
      v.maxLength(4_096),
    ),
    risks: v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000))),
      v.maxLength(20),
    ),
    checks: v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4_000))),
      v.maxLength(20),
    ),
  }),
  findings: v.pipe(v.array(reviewAssistFindingSchema), v.maxLength(100)),
} as const;

export const reviewAssistStructuredOutputSchema = v.looseObject({
  ...reviewAssistStructuredOutputEntries,
  presentation: v.optional(v.unknown()),
});

export function parseReviewPresentationPlan(value: unknown) {
  const result = v.safeParse(reviewPresentationPlanSchema, value);
  return result.success ? result.output : null;
}

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
export type ReviewPresentationPlan = v.InferOutput<
  typeof reviewPresentationPlanSchema
>;
export type ReviewPresentationSlide =
  ReviewPresentationPlan['overview'][number];
