export {
  ReviewerDeadlineError,
  ReviewerTerminalError,
} from './reviewer-deadline';
import { dispatch, init } from '@flue/runtime';
import * as v from 'valibot';
import { artifactHash, type LocalAttemptHandle } from '../coding-runs';
import { assertCandidateEvidenceCurrent } from './evidence';
import {
  candidateReviewRequestSchema,
  candidateReviewResultSchema,
  validateCandidateReview,
  validateReviewerChecks,
  type CandidateReviewRequest,
} from './reviewer-contract';
import {
  assertReviewerAdmissionWindow,
  admitCandidateReviewWithinDeadline,
  readCandidateReviewWithinDeadline,
} from './reviewer-deadline';
export function validateReviewerReply(
  reply: {
    submissionId: string;
    data: Record<string, unknown[]>;
    metadata?: Record<string, unknown>;
  },
  request: CandidateReviewRequest,
) {
  request = v.parse(candidateReviewRequestSchema, request);
  validateReviewerChecks(request);
  const results = reply.data.factoryReview;
  const tokens = reply.metadata?.totalTokens;
  const startedAt = reply.metadata?.startedAt;
  const completedAt = reply.metadata?.completedAt;
  if (
    typeof startedAt !== 'number' ||
    !Number.isSafeInteger(startedAt) ||
    typeof completedAt !== 'number' ||
    !Number.isSafeInteger(completedAt) ||
    startedAt < request.deadlineAt - request.maxDurationMs ||
    completedAt < startedAt ||
    completedAt > request.deadlineAt ||
    completedAt - startedAt > request.maxDurationMs ||
    !reply.submissionId ||
    results?.length !== 1 ||
    typeof tokens !== 'number' ||
    !Number.isSafeInteger(tokens) ||
    tokens <= 0 ||
    tokens > request.maxTokens ||
    reply.metadata?.evidenceDigest !== request.evidence.evidenceDigest ||
    reply.metadata?.revision !== request.evidence.revision ||
    reply.metadata?.requestDigest !== artifactHash(JSON.stringify(request))
  )
    throw new Error('Missing, over-budget, or unbound reviewer evidence/usage');
  const advisory = validateCandidateReview(results[0], request.evidence);
  if (advisory.feedbackFingerprint !== request.feedback?.fingerprint)
    throw new Error('Reviewer feedback binding mismatch');
  return v.parse(candidateReviewResultSchema, {
    ...advisory,
    submissionId: reply.submissionId,
    totalTokens: tokens,
    durationMs: completedAt - startedAt,
  });
}
export type CandidateReviewCallbacks = {
  onDispatched: (submissionId: string) => Promise<void>;
  assertAuthority?: () => void | Promise<void>;
};
export async function reviewCandidateEvidence(
  raw: CandidateReviewRequest,
  handle: LocalAttemptHandle,
  callbacks?: CandidateReviewCallbacks,
) {
  if (!callbacks?.onDispatched)
    throw new Error('Reviewer requires durable dispatch receipt persistence');
  await callbacks.assertAuthority?.();
  const request = v.parse(candidateReviewRequestSchema, raw);
  validateReviewerChecks(request);
  await assertCandidateEvidenceCurrent(handle, request.evidence);
  const { FactoryReviewer } = await import('../../agents/factory-reviewer');
  await callbacks.assertAuthority?.();
  assertReviewerAdmissionWindow(request);
  const reviewerHandle = init(FactoryReviewer, { id: request.id });
  const receipt = await admitCandidateReviewWithinDeadline(
    reviewerHandle,
    request,
    async () => {
      const dispatched = await dispatch(FactoryReviewer, {
        id: request.id,
        idempotencyKey: `factory-review:${request.id}:${request.evidence.evidenceDigest}`,
        initialData: request,
        message: {
          kind: 'signal',
          type: 'neondeck.factory.review',
          attributes: { evidenceDigest: request.evidence.evidenceDigest },
          body: 'Independently review the server-bound candidate using the read-only tools and submit structured evidence.',
        },
      });
      await callbacks.onDispatched(dispatched.submissionId);
      try {
        await callbacks.assertAuthority?.();
      } catch (error) {
        await init(FactoryReviewer, { id: request.id }).abort();
        throw error;
      }
      return dispatched;
    },
  );
  const reply = await readCandidateReviewWithinDeadline(
    reviewerHandle,
    receipt.submissionId,
    request,
  );
  await assertCandidateEvidenceCurrent(handle, request.evidence);
  return validateReviewerReply(reply, request);
}

export async function cancelCandidateReview(id: string) {
  const { FactoryReviewer } = await import('../../agents/factory-reviewer');
  await init(FactoryReviewer, { id }).abort();
}

export async function recoverExistingCandidateReview(
  raw: CandidateReviewRequest,
  handle: LocalAttemptHandle,
  submissionId: string,
) {
  if (!submissionId)
    throw new Error('Unknown reviewer receipt; retain uncertainty');
  const request = v.parse(candidateReviewRequestSchema, raw);
  validateReviewerChecks(request);
  await assertCandidateEvidenceCurrent(handle, request.evidence);
  const { FactoryReviewer } = await import('../../agents/factory-reviewer');
  const reply = await readCandidateReviewWithinDeadline(
    init(FactoryReviewer, { id: request.id }),
    submissionId,
    request,
  );
  await assertCandidateEvidenceCurrent(handle, request.evidence);
  return validateReviewerReply(reply, request);
}
