import { getDeliveryPipeline } from './store';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as v from 'valibot';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import { deliveryProgressEvidenceContentSchema } from '../../../shared/factory-delivery-progress-evidence';
import type { RuntimePaths } from '../../runtime-home';
import { readBytesBounded } from '../coding-runs';
import { deliveryIntentPath } from './service-records';
import {
  readRetainedEvidenceReceipt,
  sanitizeEvidenceText,
} from './evidence-content';
import {
  validateProgressRequest,
  validateProgressReport,
} from './progress-reviewer-contract';
import {
  sameProgressBinding,
  deliveryProgressEvidenceDigest,
} from './progress-domain';

/** Read-only projection; no model admission, reconciliation or authority mutation. */
export async function readDeliveryProgressEvidence(
  p: DeliveryPipeline,
  assessmentId: string,
  paths: RuntimePaths,
) {
  const assessment = p.progress.assessments.find(
    (item) => item.assessmentId === assessmentId,
  );
  if (!assessment)
    throw new Error('Progress assessment does not belong to delivery');
  const root = join(paths.home, 'factory-delivery', p.pipelineId);
  const ref = deliveryIntentPath(
    p.pipelineId,
    `progress:${assessmentId}`,
    paths,
  );
  const [realRoot, realRef] = await Promise.all([
    realpath(root),
    realpath(ref),
  ]);
  if (resolve(realRoot, ref.slice(root.length + 1)) !== realRef)
    throw new Error('Progress intent traverses a symbolic link');
  const request = validateProgressRequest(
    JSON.parse((await readBytesBounded(ref, 1048576)).toString('utf8')),
  );
  if (
    !sameProgressBinding(assessment, request.binding) ||
    request.packet.proposedInstructions !== assessment.instructions ||
    request.deadlineAt !== Date.parse(assessment.deadlineAt) ||
    request.maxDurationMs !== assessment.reservedExecutionMs
  )
    throw new Error('Progress intent does not match retained assessment');
  if (assessment.state === 'settled') {
    if (!assessment.resultId || !/^[a-f0-9]{64}$/.test(assessment.resultId))
      throw new Error('Invalid progress result identity');
    const report = await readRetainedEvidenceReceipt(
      p,
      join(root, `${assessment.resultId}.json`),
      paths,
    );
    const identity = v.parse(v.object({ submissionId: v.string() }), report);
    if (identity.submissionId !== assessment.submissionId)
      throw new Error('Progress result submission mismatch');
    if (assessment.result) {
      const {
        submissionId: _submissionId,
        totalTokens: _totalTokens,
        durationMs,
        completedAt,
        ...result
      } = validateProgressReport(report, request);
      if (
        !isDeepStrictEqual(result, assessment.result) ||
        durationMs !== assessment.executionMs ||
        completedAt !== assessment.completedAt
      )
        throw new Error('Progress result does not match retained decision');
    }
  }
  let truncated = false;
  const render = (value: string, max: number) => {
    const display = sanitizeEvidenceText(value, paths, max);
    truncated ||= display.truncated;
    return display;
  };
  const packet = request.packet;
  const candidates = packet.candidates.map((candidate) => {
    const diff = candidate.diff === null ? null : render(candidate.diff, 12000);
    return {
      revision: candidate.revision,
      diff: diff?.text ?? null,
      diffTruncated: diff?.truncated ?? false,
      observations: candidate.observations.map((observation) => {
        const body = render(observation.body, 4000);
        return {
          ref: render(observation.ref, 500).text,
          kind: observation.kind,
          body: body.text,
          truncated: body.truncated,
        };
      }),
    };
  });
  const projected = {
    ...assessment,
    evidenceRefs: assessment.evidenceRefs.map((ref) => render(ref, 500).text),
    instructions: render(assessment.instructions, 20000).text,
    result: assessment.result
      ? {
          ...assessment.result,
          rationale: render(assessment.result.rationale, 4000).text,
          evidenceRefs: assessment.result.evidenceRefs.map(
            (ref) => render(ref, 500).text,
          ),
          nextInstructions:
            assessment.result.nextInstructions === null
              ? null
              : render(assessment.result.nextInstructions, 20000).text,
        }
      : null,
  };
  const releasedBrief = render(packet.releasedBrief, 8000).text;
  const priorRepairs = packet.priorRepairs.map((repair) => ({
    ...repair,
    instructions: render(repair.instructions, 4000).text,
  }));
  const missingEvidence = packet.missingEvidence.map(
    (text) => render(text, 500).text,
  );
  const omittedEvidence = packet.omittedEvidence.map(
    (text) => render(text, 500).text,
  );
  const latest = getDeliveryPipeline(p.pipelineId, paths);
  if (!latest || !isDeepStrictEqual(latest, p))
    throw new Error('Delivery changed while reading progress evidence');
  return v.parse(deliveryProgressEvidenceContentSchema, {
    kind: 'progress',
    deliveryId: p.pipelineId,
    evidenceId: assessmentId,
    currentRevision: p.revision,
    isCurrent:
      isDeepStrictEqual(assessment.revision, p.revision) &&
      assessment.grantId === p.authorization.id &&
      assessment.evidenceDigest === deliveryProgressEvidenceDigest(p),
    assessment: projected,
    releasedBrief,
    candidates,
    priorRepairs,
    missingEvidence,
    omittedEvidence,
    truncated,
  });
}
