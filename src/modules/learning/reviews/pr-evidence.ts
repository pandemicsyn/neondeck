import * as v from 'valibot';
import type { RuntimePaths } from '../../../runtime-home';
import { recordHandledPrEventAndMaybeQueueLearning } from './events';
import { nonEmptyStringSchema, type PrBatchReviewInput } from './schemas';

export const humanReviewSubmittedEvidenceSchema = v.object({
  origin: v.picklist(['submission', 'reconciliation']),
  repoId: v.optional(v.nullable(nonEmptyStringSchema)),
  repoFullName: nonEmptyStringSchema,
  prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  headSha: nonEmptyStringSchema,
  reviewId: nonEmptyStringSchema,
  reviewUrl: v.optional(v.nullable(v.pipe(v.string(), v.url()))),
  verdict: v.picklist(['comment', 'approve', 'request-changes']),
});

export type HumanReviewSubmittedEvidenceInput = v.InferInput<
  typeof humanReviewSubmittedEvidenceSchema
>;

export async function recordHumanReviewSubmittedEvidence(
  input: HumanReviewSubmittedEvidenceInput,
  paths: RuntimePaths,
  dependencies: {
    invokePrBatchReview?: (input: PrBatchReviewInput) => Promise<{
      runId: string;
    }>;
  } = {},
) {
  const parsed = v.safeParse(humanReviewSubmittedEvidenceSchema, input);
  if (!parsed.success) {
    throw new Error(
      `Invalid submitted-review learning evidence: ${v.summarize(parsed.issues)}`,
    );
  }
  const evidence = parsed.output;
  return recordHandledPrEventAndMaybeQueueLearning(
    {
      eventType: 'human-review-submitted',
      source: 'api:github_pr_review_post',
      sourceId: `${evidence.repoFullName}#${evidence.prNumber}:human-review-submitted:${evidence.reviewId}`,
      repoId: evidence.repoId ?? null,
      repoFullName: evidence.repoFullName,
      prNumber: evidence.prNumber,
      summary:
        evidence.origin === 'reconciliation'
          ? `Recovered submitted PR review for ${evidence.repoFullName}#${evidence.prNumber}.`
          : `Submitted PR review for ${evidence.repoFullName}#${evidence.prNumber}.`,
      data: {
        headSha: evidence.headSha,
        reviewId: evidence.reviewId,
        reviewUrl: evidence.reviewUrl ?? null,
        verdict: evidence.verdict,
        origin: evidence.origin,
      },
    },
    paths,
    dependencies,
  );
}
