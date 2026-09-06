import * as v from 'valibot';
import { candidateFeedbackResultSchema } from './reviewer-contract';
import type { LocalAttemptHandle } from '../coding-runs';
import {
  reviewCandidateEvidence,
  recoverExistingCandidateReview,
  type CandidateReviewCallbacks,
} from './reviewer';
import type { CandidateReviewRequest } from './reviewer-contract';
type FeedbackRequest = CandidateReviewRequest & {
  feedback: { fingerprint: string; body: string };
};
function classification(
  review: Awaited<ReturnType<typeof reviewCandidateEvidence>>,
) {
  return v.parse(candidateFeedbackResultSchema, {
    ...review,
    outcome:
      review.outcome === 'pass'
        ? ('no-action' as const)
        : review.outcome === 'findings'
          ? ('scoped-repair' as const)
          : ('scope-change' as const),
  });
}
export async function classifyFactoryFeedback(
  request: FeedbackRequest,
  handle: LocalAttemptHandle,
  callbacks: CandidateReviewCallbacks,
) {
  return classification(
    await reviewCandidateEvidence(request, handle, callbacks),
  );
}
export async function recoverFactoryFeedback(
  request: FeedbackRequest,
  handle: LocalAttemptHandle,
  submissionId: string,
) {
  return classification(
    await recoverExistingCandidateReview(request, handle, submissionId),
  );
}
