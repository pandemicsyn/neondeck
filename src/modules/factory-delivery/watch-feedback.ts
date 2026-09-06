import {
  closeSync,
  constants,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { codingDigest } from '../factory';
import * as v from 'valibot';
import type {
  DeliveryPipeline,
  DeliveryFeedback,
} from '../../../shared/factory-delivery';
import { renderFactorySpec } from '../../../shared/factory';
import type { RuntimePaths } from '../../runtime-home';
import { codingHandle } from '../factory';
import { assertDeliveryAuthority } from './authority';
import { deliveryBudget, sameDeliveryRevision } from './store';
import {
  changeDelivery,
  deliveryReceipt,
  interveneDelivery,
  requireDelivery,
} from './service-records';
import { captureCandidateEvidence } from './evidence';
import { classifyFactoryFeedback } from './reviewer-feedback';
import {
  reviewerChecksSchema,
  reviewerFeedbackSchema,
  candidateReviewRequestSchema,
  candidateFeedbackResultSchema,
  validateReviewerChecks,
} from './reviewer-contract';
import { settleReviewerFailure } from './service-review-failure';

/** Only retained content-addressed receipts; reads never allocate beyond the cap. */
function readFeedbackReceipt(
  ref: string,
  pipelineId: string,
  paths: RuntimePaths,
): unknown {
  const root = join(paths.home, 'factory-delivery', pipelineId);
  if (
    !ref.startsWith(`${root}/`) ||
    !/^[a-f0-9]{64}\.json$/.test(ref.slice(root.length + 1)) ||
    realpathSync(ref) !== join(realpathSync(root), ref.slice(root.length + 1))
  )
    throw new Error('Feedback report is not a retained receipt');
  const fd = openSync(ref, constants.O_RDONLY | constants.O_NOFOLLOW);
  let body: string;
  try {
    const buffer = Buffer.alloc(1048577);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > 1048576) throw new Error('Feedback report exceeds bound');
    body = buffer.subarray(0, bytes).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const raw: unknown = JSON.parse(body);
  if (ref !== join(root, `${codingDigest(raw)}.json`))
    throw new Error('Feedback report content address mismatch');
  return raw;
}

/** Complete the settle-to-classify crash boundary without dispatching work. */
export function bindSettledFeedback(
  pipelineId: string,
  feedbackId: string,
  paths: RuntimePaths,
): boolean {
  const p = requireDelivery(pipelineId, paths);
  const feedback = p.feedback.find((f) => f.id === feedbackId);
  if (!feedback) throw new Error('Feedback observation missing');
  const effect = p.effects.find(
    (e) => e.id === `feedback-review:${feedback.fingerprint}`,
  );
  if (
    !effect ||
    effect.state !== 'delivered' ||
    !effect.receiptRef ||
    effect.executionMs === null
  )
    return false;
  if (feedback.classification) {
    if (
      feedback.classification.effectId !== effect.id ||
      feedback.classification.evidenceRef !== effect.receiptRef
    )
      throw new Error('Conflicting feedback classification');
    return true;
  }
  const raw = readFeedbackReceipt(effect.receiptRef, pipelineId, paths);
  const report = v.parse(candidateFeedbackResultSchema, raw);
  if (
    !sameDeliveryRevision(effect.revision, feedback.revision) ||
    report.feedbackFingerprint !== feedback.fingerprint ||
    report.evidenceDigest !== feedback.revision.candidateDigest ||
    report.revision !== feedback.revision.treeSha ||
    report.durationMs !== effect.executionMs ||
    (report.outcome === 'no-action' && report.findings.length !== 0) ||
    (report.outcome === 'scoped-repair' && report.findings.length === 0)
  )
    throw new Error('Feedback report revision binding mismatch');
  changeDelivery(
    pipelineId,
    {
      type: 'classify-feedback',
      id: feedbackId,
      effectId: effect.id,
      result: report.outcome,
      evidenceRef: effect.receiptRef,
    },
    paths,
  );
  return true;
}

export async function classifyFeedback(
  p: DeliveryPipeline,
  feedback: DeliveryFeedback,
  paths: RuntimePaths,
) {
  const effectId = `feedback-review:${feedback.fingerprint}`;
  const existing = p.effects.find((e) => e.id === effectId);
  if (existing?.state === 'delivered') {
    bindSettledFeedback(p.pipelineId, feedback.id, paths);
    return;
  }
  // Only a durable planned effect is proven unstarted (or explicitly reconciled).
  // In-flight and uncertain admission belong to submission recovery.
  if (existing && existing.state !== 'planned') return;
  const remaining =
    existing?.reservedExecutionMs ?? deliveryBudget(p).remainingExecutionMs;
  if (remaining <= 0) {
    interveneDelivery(
      p.pipelineId,
      'budget',
      'No execution budget remains for feedback review.',
      paths,
    );
    return;
  }
  const context = assertDeliveryAuthority(p, paths);
  const handle = codingHandle(context.run, paths);
  const evidence = await captureCandidateEvidence(handle);
  const started = Date.now();
  const maxDurationMs = Math.min(180000, remaining);
  let request: v.InferOutput<typeof candidateReviewRequestSchema> & {
    feedback: v.InferOutput<typeof reviewerFeedbackSchema>;
  };
  try {
    const observation = v.parse(
      v.object({ feedbackBody: reviewerFeedbackSchema.entries.body }),
      readFeedbackReceipt(feedback.evidenceRef, p.pipelineId, paths),
    );
    const checked = p.evidence.findLast(
      (e) =>
        e.kind === 'verification' &&
        e.result === 'passed' &&
        sameDeliveryRevision(e.revision, p.revision),
    );
    if (!checked) throw new Error('Passed verification required');
    const checks = v.parse(
      v.object({ details: reviewerChecksSchema }),
      readFeedbackReceipt(checked.evidenceRef, p.pipelineId, paths),
    ).details;
    const packet = v.parse(reviewerFeedbackSchema, {
      fingerprint: feedback.fingerprint,
      body: observation.feedbackBody,
    });
    const parsed = v.parse(candidateReviewRequestSchema, {
      id: `${p.pipelineId}:${effectId}`,
      model: context.reviewerModel,
      thinkingLevel: context.reviewerThinkingLevel,
      evidence,
      checks,
      brief: renderFactorySpec(context.authority.revision.spec),
      maxTokens: 16000,
      maxDurationMs,
      deadlineAt: started + maxDurationMs,
      feedback: packet,
    });
    validateReviewerChecks(parsed);
    if (
      evidence.evidenceDigest !== p.revision.candidateDigest ||
      evidence.treeSha !== p.revision.treeSha ||
      evidence.attemptId !== p.revision.attemptId
    )
      throw new Error('Feedback candidate binding changed');
    request = { ...parsed, feedback: packet };
  } catch {
    interveneDelivery(
      p.pipelineId,
      'scope',
      'External feedback or its review inputs exceed the bounded contract or failed validation; inspect them before continuing.',
      paths,
    );
    return;
  }
  // Validate the complete packet before reserving budget or admitting a model.
  const current = requireDelivery(p.pipelineId, paths);
  if (current.version !== p.version) return;
  assertDeliveryAuthority(current, paths);
  if (!existing)
    changeDelivery(
      p.pipelineId,
      {
        type: 'plan-effect',
        id: effectId,
        kind: 'feedback-review',
        maxExecutionMs: Math.min(2700000, remaining),
      },
      paths,
    );
  changeDelivery(p.pipelineId, { type: 'start-effect', id: effectId }, paths);
  try {
    const result = await classifyFactoryFeedback(request, handle, {
      assertAuthority: () => {
        assertDeliveryAuthority(requireDelivery(p.pipelineId, paths), paths);
      },
      onDispatched: async (submissionId) => {
        changeDelivery(
          p.pipelineId,
          {
            type: 'bind-effect-receipt',
            id: effectId,
            receiptRef: deliveryReceipt(
              p.pipelineId,
              {
                kind: 'feedback-review',
                submissionId,
                request,
                feedbackId: feedback.id,
                startedAt: new Date(started).toISOString(),
              },
              paths,
            ),
          },
          paths,
        );
      },
    });
    assertDeliveryAuthority(requireDelivery(p.pipelineId, paths), paths);
    const receipt = deliveryReceipt(p.pipelineId, result, paths);
    changeDelivery(
      p.pipelineId,
      {
        type: 'settle-effect',
        id: effectId,
        state: 'delivered',
        receiptRef: receipt,
        executionMs: result.durationMs,
      },
      paths,
    );
    bindSettledFeedback(p.pipelineId, feedback.id, paths);
  } catch (error) {
    const latest = requireDelivery(p.pipelineId, paths);
    const outstanding = latest.effects.find((e) => e.id === effectId);
    if (outstanding && settleReviewerFailure(latest, outstanding, error, paths))
      return;
    if (outstanding?.state === 'in-flight')
      changeDelivery(
        p.pipelineId,
        {
          type: 'settle-effect',
          id: effectId,
          state: 'uncertain',
          receiptRef:
            outstanding.receiptRef ??
            deliveryReceipt(
              p.pipelineId,
              { effectId, unknownAdmission: true },
              paths,
            ),
        },
        paths,
      );
  }
}
