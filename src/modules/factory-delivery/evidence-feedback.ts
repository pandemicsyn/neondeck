import * as v from 'valibot';
import {
  deliveryFeedbackContentSchema,
  type DeliveryFeedbackContent,
} from '../../../shared/factory-delivery-evidence';
import type {
  DeliveryPipeline,
  DeliveryFeedback,
} from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { codingDigest } from '../factory';
import { sameDeliveryRevision } from './store';
import {
  candidateFeedbackResultSchema,
  reviewerFeedbackSchema,
} from './reviewer-contract';
import {
  readRetainedEvidenceReceipt,
  sanitizeEvidenceText,
  renderEvidenceFindings,
} from './evidence-content';

// Observation arrays are opaque digest inputs, never execution authority.
// The displayed packet must match the bounded feedbackBody consumed by review.
const observationReceiptSchema = v.strictObject({
  headSha:
    deliveryFeedbackContentSchema.entries.feedback.entries.publishedHeadSha,
  checks: v.array(v.unknown()),
  statuses: v.array(v.unknown()),
  reviews: v.array(v.unknown()),
  inlineComments: v.array(v.unknown()),
  issueComments: v.array(v.unknown()),
  ciFailed: v.boolean(),
  hasReviewFeedback: v.boolean(),
  fingerprint: reviewerFeedbackSchema.entries.fingerprint,
  feedbackBody: reviewerFeedbackSchema.entries.body,
});
export async function readFeedbackContent(
  p: DeliveryPipeline,
  f: DeliveryFeedback,
  paths: RuntimePaths,
): Promise<DeliveryFeedbackContent> {
  const observation = v.parse(
    observationReceiptSchema,
    await readRetainedEvidenceReceipt(p, f.evidenceRef, paths),
  );
  const {
    ciFailed,
    hasReviewFeedback,
    fingerprint,
    feedbackBody,
    ...normalized
  } = observation;
  if (
    codingDigest(normalized) !== f.fingerprint ||
    fingerprint !== f.fingerprint ||
    normalized.headSha !== f.publishedHeadSha ||
    ciFailed !== f.ciFailed ||
    hasReviewFeedback !== f.hasReviewFeedback ||
    feedbackBody !==
      JSON.stringify({
        reviews: normalized.reviews,
        inlineComments: normalized.inlineComments,
        issueComments: normalized.issueComments,
      })
  )
    throw new Error('Feedback observation binding mismatch');
  const effect = p.effects.find(
    (e) => e.id === `feedback-review:${f.fingerprint}`,
  );
  if (
    effect &&
    (effect.kind !== 'feedback-review' ||
      !sameDeliveryRevision(effect.revision, f.revision))
  )
    throw new Error('Feedback effect revision mismatch');
  const settled = effect?.state === 'delivered';
  const accounted =
    settled &&
    effect.executionMs !== null &&
    effect.reservedExecutionMs !== null &&
    effect.executionMs <= effect.reservedExecutionMs;
  let summary =
    'Retained external feedback. Classification is not settled; these observations do not certify the candidate.';
  let classification: DeliveryFeedbackContent['feedback']['classification'] =
    null;
  let findings: DeliveryFeedbackContent['findings'] = [];
  let truncated = false;
  if (settled && effect.executionMs !== null) {
    if (!effect.receiptRef) throw new Error('Missing classifier receipt');
    const report = v.parse(
      candidateFeedbackResultSchema,
      await readRetainedEvidenceReceipt(p, effect.receiptRef, paths),
    );
    if (
      report.feedbackFingerprint !== f.fingerprint ||
      report.evidenceDigest !== f.revision.candidateDigest ||
      report.revision !== f.revision.treeSha ||
      report.durationMs !== effect.executionMs ||
      (report.outcome === 'no-action' && report.findings.length !== 0) ||
      (report.outcome === 'scoped-repair' && report.findings.length === 0) ||
      (f.classification &&
        (f.classification.effectId !== effect.id ||
          f.classification.evidenceRef !== effect.receiptRef ||
          f.classification.result !== report.outcome))
    )
      throw new Error('Feedback classification binding mismatch');
    const rendered = sanitizeEvidenceText(report.summary, paths);
    const renderedReport = renderEvidenceFindings(report.findings, paths);
    summary = rendered.text;
    findings = renderedReport.findings;
    truncated = rendered.truncated || renderedReport.truncated;
    classification = {
      result: report.outcome,
      bound: f.classification !== null,
    };
  } else if (f.classification)
    throw new Error('Classification is missing settled usage');
  else if (settled)
    summary =
      'Classifier is terminal with unknown execution usage. Its reservation remains held; no classification is available.';
  // Sanitize decoded values before JSON escaping, so quoted credentials and
  // Windows home paths inside comments cannot evade display redaction.
  let packetValueTruncated = false;
  const safePacket = JSON.stringify(
    {
      reviews: normalized.reviews,
      inlineComments: normalized.inlineComments,
      issueComments: normalized.issueComments,
    },
    (_key: string, value: unknown) => {
      if (typeof value !== 'string') return value;
      const rendered = sanitizeEvidenceText(value, paths, 16000);
      packetValueTruncated ||= rendered.truncated;
      return rendered.text;
    },
  );
  const packet = {
    text: safePacket.slice(0, 12000),
    truncated: packetValueTruncated || safePacket.length > 12000,
  };
  return v.parse(deliveryFeedbackContentSchema, {
    deliveryId: p.pipelineId,
    evidenceId: f.id,
    kind: 'feedback',
    result: classification?.result ?? 'observed',
    revision: f.revision,
    currentRevision: p.revision,
    isCurrent: sameDeliveryRevision(f.revision, p.revision),
    effect: {
      state: effect?.state ?? 'unplanned',
      settled,
      accounted,
      eligible: false,
      eligibilityReason: 'external-observation',
    },
    summary,
    findings,
    checks: [],
    acceptanceCriteria: [],
    acceptanceCriteriaRole: 'review-inputs',
    feedback: {
      fingerprint,
      publishedHeadSha: f.publishedHeadSha,
      ciFailed,
      hasReviewFeedback,
      packet: packet.text,
      packetTruncated: packet.truncated,
      classification,
    },
    truncated: truncated || packet.truncated,
  });
}
