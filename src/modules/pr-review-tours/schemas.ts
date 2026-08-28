import * as v from 'valibot';
import { prReviewTourLimits } from '../../../shared/pr-review-tour';

const boundedString = (maximum: number) =>
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maximum));

const lineNumberSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(prReviewTourLimits.maxLineNumber),
);

export const prReviewTourDraftSchema = v.strictObject({
  title: boundedString(prReviewTourLimits.maxTitleLength),
  summary: boundedString(prReviewTourLimits.maxSummaryLength),
  sourceFindingId: v.optional(
    v.nullable(boundedString(prReviewTourLimits.maxSourceFindingIdLength)),
  ),
  steps: v.pipe(
    v.array(
      v.strictObject({
        key: boundedString(120),
        file: boundedString(1_000),
        side: v.picklist(['additions', 'deletions']),
        startLine: lineNumberSchema,
        endLine: lineNumberSchema,
        symbol: v.nullable(boundedString(prReviewTourLimits.maxSymbolLength)),
        explanation: boundedString(prReviewTourLimits.maxExplanationLength),
      }),
    ),
    v.minLength(1),
    v.maxLength(prReviewTourLimits.maxSteps),
  ),
});

export const prReviewTourPresentationSchema = v.variant('action', [
  v.strictObject({
    action: v.literal('tour-activated'),
    surfaceId: boundedString(240),
    tourId: boundedString(240),
    generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
    stepId: boundedString(240),
  }),
  v.strictObject({
    action: v.literal('tour-closed'),
    surfaceId: boundedString(240),
    tourId: boundedString(240),
    generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
]);

export const prReviewTourToolOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
});
