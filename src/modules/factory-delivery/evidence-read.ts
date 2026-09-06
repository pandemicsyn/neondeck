import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  deliveryEvidenceReadInputSchema,
  deliveryEvidenceContentSchema,
  type DeliveryEvidenceContent,
} from '../../../shared/factory-delivery-evidence';
import { specSchema } from '../../../shared/factory';
import type {
  DeliveryEvidence,
  DeliveryPipeline,
} from '../../../shared/factory-delivery';
import type { RuntimePaths } from '../../runtime-home';
import { getCodingRun } from '../coding-runs';
import { codingDigest, FactoryError } from '../factory';
import { getDeliveryPipeline, sameDeliveryRevision } from './store';
import { candidateReviewResultSchema } from './reviewer-contract';
import {
  candidateVerificationSchema,
  candidateCheckLogSchema,
} from './verification-contract';
import {
  readBoundEvidenceJson,
  sanitizeEvidenceText,
  readRetainedEvidenceReceipt,
  renderEvidenceFindings,
} from './evidence-content';
import { readFeedbackContent } from './evidence-feedback';
import { readDeliveryProgressEvidence } from './evidence-progress';
import type { DeliveryProgressEvidenceContent } from '../../../shared/factory-delivery-progress-evidence';
const natural = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const envelopeSchema = v.strictObject({
  producerId: v.string(),
  result: v.picklist(['passed', 'failed', 'blocked']),
  durationMs: natural,
  details: v.unknown(),
});
function status(
  p: DeliveryPipeline,
  e: DeliveryEvidence,
): DeliveryEvidenceContent['effect'] {
  const effect = p.effects.find((x) => x.id === e.effectId);
  if (!effect) throw new Error('Evidence effect missing');
  const settled =
    effect.state === 'delivered' && effect.receiptRef === e.evidenceRef;
  const accounted =
    effect.executionMs !== null &&
    effect.reservedExecutionMs !== null &&
    effect.executionMs <= effect.reservedExecutionMs;
  const latest = p.evidence.findLast(
    (x) => x.kind === e.kind && sameDeliveryRevision(x.revision, p.revision),
  );
  const verification = p.evidence.findLast(
    (x) =>
      x.kind === 'verification' && sameDeliveryRevision(x.revision, p.revision),
  );
  const reason: DeliveryEvidenceContent['effect']['eligibilityReason'] =
    !sameDeliveryRevision(e.revision, p.revision)
      ? 'prior-revision'
      : !settled
        ? 'pending'
        : !accounted
          ? 'unaccounted'
          : e.result !== 'passed'
            ? 'not-passed'
            : latest?.id !== e.id ||
                p.effects.findLast(
                  (x) =>
                    x.kind === e.kind &&
                    sameDeliveryRevision(x.revision, p.revision),
                )?.id !== e.effectId ||
                (e.kind === 'review' &&
                  (e.verificationEvidenceId !== verification?.id ||
                    e.verificationBundleDigest !== verification?.bundleDigest))
              ? 'superseded'
              : p.outcome || p.interventions.some((i) => !i.resolution)
                ? 'inactive-delivery'
                : 'eligible';
  return {
    state: effect.state,
    settled,
    accounted,
    eligible: reason === 'eligible',
    eligibilityReason: reason,
  };
}
async function receipt(
  p: DeliveryPipeline,
  e: DeliveryEvidence,
  paths: RuntimePaths,
) {
  const raw = await readRetainedEvidenceReceipt(p, e.evidenceRef, paths);
  const value = v.parse(envelopeSchema, raw);
  if (
    value.producerId !== e.producerId ||
    value.result !== e.result ||
    codingDigest(value.details) !== e.bundleDigest
  )
    throw new Error('Evidence bundle mismatch');
  const effect = p.effects.find((x) => x.id === e.effectId)!;
  if (effect.executionMs !== null && value.durationMs !== effect.executionMs)
    throw new Error('Evidence usage mismatch');
  return value;
}
/** Reads one exact retained report. Invalid content is an explicit error, never an empty replacement. */
export async function readDeliveryEvidence(
  raw: unknown,
  paths: RuntimePaths,
): Promise<DeliveryEvidenceContent> {
  const input = v.parse(deliveryEvidenceReadInputSchema, raw);
  let p: DeliveryPipeline | null;
  try {
    p = getDeliveryPipeline(input.deliveryId, paths);
  } catch {
    throw new FactoryError(
      409,
      'Retained evidence is unavailable or failed integrity validation. Keep the previous view and retry after inspection.',
    );
  }
  if (!p) throw new FactoryError(404, 'Delivery not found.');
  const e = p.evidence.find((x) => x.id === input.evidenceId);
  const feedback = p.feedback.find((x) => x.id === input.evidenceId);
  if (!e && !feedback)
    throw new FactoryError(404, 'Evidence does not belong to this delivery.');
  try {
    if (e && feedback) throw new Error('Ambiguous evidence identity');
    if (feedback) return await readFeedbackContent(p, feedback, paths);
    if (!e) throw new Error('Evidence missing');
    const envelope = await receipt(p, e, paths);
    let summary = '';
    let truncated = false;
    const checks: DeliveryEvidenceContent['checks'] = [];
    const findings: DeliveryEvidenceContent['findings'] = [];
    if (e.kind === 'verification') {
      const report = v.parse(candidateVerificationSchema, envelope.details);
      if (
        report.evidenceDigest !== e.revision.candidateDigest ||
        report.revision !== e.revision.treeSha ||
        report.durationMs !== envelope.durationMs ||
        report.passed !== (e.result === 'passed')
      )
        throw new Error('Verification revision mismatch');
      if (
        report.passed &&
        (report.checks.length !== p.authorization.checkCommands.length ||
          report.checks.some(
            (c) =>
              !c.passed ||
              c.exitCode !== 0 ||
              c.truncated ||
              !c.evidenceRef ||
              !c.outputHash,
          ))
      )
        throw new Error('Incomplete passed verification');
      let remaining = 12000;
      for (const [index, check] of report.checks.entries()) {
        if (check.command !== p.authorization.checkCommands[index])
          throw new Error('Verification contract mismatch');
        let output = '';
        let outputTruncated = check.truncated;
        if ((check.evidenceRef === null) !== (check.outputHash === null))
          throw new Error('Missing log digest');
        if (check.evidenceRef && check.outputHash) {
          v.parse(
            v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]+$/)),
            e.revision.attemptId,
          );
          const root = join(
            await realpath(paths.home),
            'coding-attempts',
            e.revision.attemptId,
          );
          const log = v.parse(
            candidateCheckLogSchema,
            await readBoundEvidenceJson(
              check.evidenceRef,
              root,
              check.outputHash,
            ),
          );
          if (
            log.evidenceDigest !== e.revision.candidateDigest ||
            log.treeSha !== e.revision.treeSha ||
            log.command !== check.command ||
            log.exitCode !== check.exitCode ||
            log.durationMs !== check.durationMs ||
            codingDigest(log.environment ?? null) !==
              codingDigest(check.environment ?? null) ||
            (check.passed && log.mutation != null)
          )
            throw new Error('Check output binding mismatch');
          const snippet = sanitizeEvidenceText(
            [log.stdout, log.stderr].filter(Boolean).join('\n'),
            paths,
            Math.min(4096, remaining),
          );
          output = snippet.text;
          remaining -= output.length;
          outputTruncated ||=
            snippet.truncated || log.stdoutTruncated || log.stderrTruncated;
        }
        const command = sanitizeEvidenceText(check.command, paths, 2000);
        checks.push({
          command: command.text,
          passed: check.passed,
          exitCode: check.exitCode,
          durationMs: check.durationMs,
          output,
          truncated: outputTruncated || command.truncated,
        });
        truncated ||= outputTruncated || command.truncated;
      }
      summary = `${checks.filter((c) => c.passed).length} of ${checks.length} recorded checks passed. ${report.passed ? 'The configured check set completed.' : 'Verification did not establish a passing configured check set.'}`;
    } else {
      const report = v.parse(candidateReviewResultSchema, envelope.details);
      const outcome =
        report.outcome === 'pass'
          ? 'passed'
          : report.outcome === 'scope_change'
            ? 'blocked'
            : 'failed';
      if (
        report.evidenceDigest !== e.revision.candidateDigest ||
        report.revision !== e.revision.treeSha ||
        report.submissionId !== e.producerId ||
        outcome !== e.result ||
        (report.outcome === 'pass' && report.findings.length !== 0) ||
        (report.outcome === 'findings' && report.findings.length === 0)
      )
        throw new Error('Review revision mismatch');
      const rendered = sanitizeEvidenceText(report.summary, paths);
      summary = rendered.text;
      const renderedReport = renderEvidenceFindings(report.findings, paths);
      truncated = rendered.truncated || renderedReport.truncated;
      findings.push(...renderedReport.findings);
    }
    const acceptanceCriteria: DeliveryEvidenceContent['acceptanceCriteria'] =
      [];
    const run = getCodingRun(e.revision.runId, paths);
    if (run) {
      if (
        run.attemptId !== e.revision.attemptId ||
        run.snapshot.releaseId !== e.revision.releaseId ||
        run.snapshot.specVersion !== e.revision.specVersion ||
        run.snapshot.specHash !== e.revision.specHash
      )
        throw new Error('Released specification binding mismatch');
      const spec = v.parse(specSchema, JSON.parse(run.snapshot.specSnapshot));
      if (codingDigest(spec) !== e.revision.specHash)
        throw new Error('Released specification digest mismatch');
      for (const criterion of spec.acceptanceCriteria)
        acceptanceCriteria.push({
          id: sanitizeEvidenceText(criterion.id, paths, 240).text,
          text: sanitizeEvidenceText(criterion.text, paths, 240).text,
        });
    }
    return v.parse(deliveryEvidenceContentSchema, {
      deliveryId: p.pipelineId,
      evidenceId: e.id,
      kind: e.kind,
      result: e.result,
      revision: e.revision,
      currentRevision: p.revision,
      isCurrent: sameDeliveryRevision(e.revision, p.revision),
      effect: status(p, e),
      summary,
      checks,
      findings,
      acceptanceCriteria,
      acceptanceCriteriaRole: 'review-inputs',
      truncated,
    });
  } catch {
    throw new FactoryError(
      409,
      'Retained evidence is unavailable or failed integrity validation. Keep the previous view and retry after inspection.',
    );
  }
}

/** Public endpoint adapter; existing certification consumers keep their narrow contract. */
export async function readDeliveryEvidenceOrProgress(
  raw: unknown,
  paths: RuntimePaths,
): Promise<DeliveryEvidenceContent | DeliveryProgressEvidenceContent> {
  const input = v.parse(deliveryEvidenceReadInputSchema, raw);
  try {
    const pipeline = getDeliveryPipeline(input.deliveryId, paths);
    const assessment = pipeline?.progress.assessments.find(
      (a) => a.assessmentId === input.evidenceId,
    );
    if (!pipeline || !assessment) return readDeliveryEvidence(raw, paths);
    if (
      pipeline.evidence.some((e) => e.id === input.evidenceId) ||
      pipeline.feedback.some((e) => e.id === input.evidenceId)
    )
      throw new Error('Ambiguous retained evidence identity');
    return await readDeliveryProgressEvidence(
      pipeline,
      assessment.assessmentId,
      paths,
    );
  } catch {
    throw new FactoryError(
      409,
      'Retained evidence is unavailable or failed integrity validation. Keep the previous view and retry after inspection.',
    );
  }
}
