import { candidateVerificationSchema } from './verification-contract';
import * as v from 'valibot';
import { candidateEvidenceSchema, type CandidateEvidence } from './evidence';
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(4000));
export const candidateReviewSchema = v.strictObject({
  evidenceDigest: candidateEvidenceSchema.entries.evidenceDigest,
  revision: candidateEvidenceSchema.entries.revision,
  outcome: v.picklist(['pass', 'findings', 'scope_change']),
  summary: text,
  feedbackFingerprint: v.optional(
    candidateEvidenceSchema.entries.evidenceDigest,
  ),
  findings: v.pipe(
    v.array(
      v.strictObject({
        severity: v.picklist(['critical', 'high', 'medium', 'low']),
        path: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
        line: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        description: text,
      }),
    ),
    v.maxLength(50),
  ),
});
export const candidateReviewResultSchema = v.strictObject({
  ...candidateReviewSchema.entries,
  submissionId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  totalTokens: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  durationMs: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});
export const candidateFeedbackResultSchema = v.strictObject({
  ...candidateReviewResultSchema.entries,
  outcome: v.picklist(['no-action', 'scoped-repair', 'scope-change']),
  feedbackFingerprint: candidateEvidenceSchema.entries.evidenceDigest,
});
export const reviewerChecksSchema = v.strictObject({
  ...candidateVerificationSchema.entries,
  checks: v.pipe(candidateVerificationSchema.entries.checks, v.minLength(1)),
});
export const reviewerFeedbackSchema = v.strictObject({
  fingerprint: candidateEvidenceSchema.entries.evidenceDigest,
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(16000)),
});
export const candidateReviewRequestSchema = v.strictObject({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  thinkingLevel: v.optional(
    v.picklist(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']),
  ),
  evidence: candidateEvidenceSchema,
  checks: reviewerChecksSchema,
  feedback: v.optional(reviewerFeedbackSchema),
  brief: v.pipe(v.string(), v.minLength(1), v.maxLength(32000)),
  maxDurationMs: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.maxValue(180000),
  ),
  deadlineAt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  maxTokens: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(32000)),
    16000,
  ),
});
export type CandidateReviewRequest = v.InferOutput<
  typeof candidateReviewRequestSchema
>;
export function validateCandidateReview(
  raw: unknown,
  evidence: CandidateEvidence,
) {
  const result = v.parse(candidateReviewSchema, raw);
  if (
    result.evidenceDigest !== evidence.evidenceDigest ||
    result.revision !== evidence.revision
  )
    throw new Error('Reviewer revision binding mismatch');
  if (result.outcome === 'pass' && result.findings.length !== 0)
    throw new Error('Reviewer pass contradicts findings');
  if (result.outcome === 'findings' && result.findings.length === 0)
    throw new Error('Reviewer findings are missing');
  return result;
}

export function validateReviewerChecks(request: CandidateReviewRequest) {
  const checks = v.parse(reviewerChecksSchema, request.checks);
  if (
    checks.evidenceDigest !== request.evidence.evidenceDigest ||
    checks.revision !== request.evidence.revision ||
    !checks.passed ||
    checks.checks.some(
      (c) =>
        !c.passed ||
        c.exitCode !== 0 ||
        c.truncated ||
        !c.evidenceRef ||
        !c.outputHash,
    )
  )
    throw new Error('Reviewer requires complete bound executed checks');
}
