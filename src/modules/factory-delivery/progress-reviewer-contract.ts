import * as v from 'valibot';
import {
  deliveryProgressBindingSchema,
  deliveryProgressResultSchema,
} from '../../../shared/factory-progress';
import {
  validateProgressPacket,
  progressDigest,
  progressEvidenceRefs,
  type ProgressEvidencePacket,
} from './progress-evidence-contract';
import {
  progressReviewRequestSchema,
  progressReviewResultSchema,
  type ProgressReviewRequest,
} from '../../../shared/factory-progress-review';
export * from '../../../shared/factory-progress-review';
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export function progressReviewInputDigest(
  packet: ProgressEvidencePacket,
  model: string,
  thinkingLevel?: ProgressReviewRequest['thinkingLevel'],
) {
  return progressDigest({
    packet: validateProgressPacket(packet),
    model,
    thinkingLevel: thinkingLevel ?? null,
  });
}
export function validateProgressRequest(raw: unknown) {
  const request = v.parse(progressReviewRequestSchema, raw);
  const packet = validateProgressPacket(request.packet);
  const b = request.binding;
  if (
    b.grantId !== packet.grantId ||
    b.requestId !== packet.requestId ||
    b.repairOrdinal !== packet.repairOrdinal ||
    progressDigest(b.revision) !== progressDigest(packet.revision) ||
    b.inputDigest !==
      progressReviewInputDigest(packet, request.model, request.thinkingLevel) ||
    request.maxDurationMs > packet.remainingBudget.durationMs ||
    packet.remainingBudget.repairs < 1
  )
    throw new Error('Progress request binding or remaining budget mismatch');
  return { ...request, packet };
}
export function validateProgressDecision(
  raw: unknown,
  request: ProgressReviewRequest,
) {
  const result = v.parse(deliveryProgressResultSchema, raw);
  const binding = v.parse(
    v.object(deliveryProgressBindingSchema.entries),
    result,
  );
  if (progressDigest(binding) !== progressDigest(request.binding))
    throw new Error('Progress verdict binding mismatch');
  const refs = progressEvidenceRefs(request.packet);
  if (
    new Set(result.evidenceRefs).size !== result.evidenceRefs.length ||
    result.evidenceRefs.some((ref) => !refs.includes(ref))
  )
    throw new Error('Progress verdict cites unavailable evidence');
  if (
    result.decision !== 'escalate' &&
    (request.packet.missingEvidence.length > 0 ||
      request.packet.omittedEvidence.length > 0 ||
      request.packet.candidates.some(
        (c) => c.diff === null || c.observations.length === 0,
      ))
  )
    throw new Error('Incomplete progress evidence cannot authorize repair');
  if (
    result.decision !== 'escalate' &&
    !result.evidenceRefs.includes(
      `candidate:${request.packet.revision.candidateDigest}`,
    )
  )
    throw new Error('Progress verdict must cite the current candidate');
  return result;
}
const replyMetadataSchema = v.object({
  startedAt: natural,
  completedAt: natural,
  totalTokens: v.pipe(natural, v.minValue(1)),
  requestDigest: v.string(),
});
export function validateProgressReviewerReply(
  rawReply: unknown,
  raw: ProgressReviewRequest,
) {
  const reply = v.parse(
    v.object({
      submissionId: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
      data: v.record(v.string(), v.array(v.unknown())),
      metadata: replyMetadataSchema,
    }),
    rawReply,
  );
  const request = validateProgressRequest(raw);
  const metadata = v.parse(replyMetadataSchema, reply.metadata);
  if (
    !reply.submissionId ||
    reply.data.factoryProgressReview?.length !== 1 ||
    metadata.requestDigest !== progressDigest(request) ||
    metadata.totalTokens > request.maxTokens ||
    metadata.startedAt < request.deadlineAt - request.maxDurationMs ||
    metadata.completedAt < metadata.startedAt ||
    metadata.completedAt > request.deadlineAt ||
    metadata.completedAt - metadata.startedAt > request.maxDurationMs
  )
    throw new Error('Missing, over-budget, or unbound progress usage');
  return {
    ...validateProgressDecision(reply.data.factoryProgressReview[0], request),
    submissionId: reply.submissionId,
    totalTokens: metadata.totalTokens,
    durationMs: metadata.completedAt - metadata.startedAt,
    completedAt: new Date(metadata.completedAt).toISOString(),
  };
}

export function validateProgressReport(
  raw: unknown,
  request: ProgressReviewRequest,
) {
  const result = v.parse(progressReviewResultSchema, raw);
  const { submissionId, totalTokens, durationMs, completedAt, ...decision } =
    result;
  validateProgressDecision(decision, validateProgressRequest(request));
  if (
    totalTokens > request.maxTokens ||
    durationMs > request.maxDurationMs ||
    Date.parse(completedAt) > request.deadlineAt ||
    Date.parse(completedAt) - durationMs <
      request.deadlineAt - request.maxDurationMs
  )
    throw new Error('Progress result exceeds reserved usage');
  return { ...decision, submissionId, totalTokens, durationMs, completedAt };
}
