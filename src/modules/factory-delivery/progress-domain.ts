import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DeliveryPipeline } from '../../../shared/factory-delivery';
import type { DeliveryProgressAssessment } from '../../../shared/factory-progress';

/** Only evidence/authority mutations invalidate approval; unrelated bookkeeping does not. */
export function deliveryProgressEvidenceDigest(r: DeliveryPipeline) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        authorization: r.authorization,
        revision: r.revision,
        evidence: r.evidence,
        effects: r.effects,
        feedback: r.feedback,
        repairs: r.repairs,
      }),
    )
    .digest('hex');
}
export function assertProgressRecord(r: DeliveryPipeline) {
  const assessments = r.progress.assessments;
  if (
    new Set(assessments.map((a) => a.assessmentId)).size !==
      assessments.length ||
    new Set(assessments.map((a) => a.repairOrdinal)).size !==
      assessments.length ||
    new Set(assessments.filter((a) => a.resultId).map((a) => a.resultId))
      .size !== assessments.filter((a) => a.resultId).length ||
    new Set(
      assessments.filter((a) => a.submissionId).map((a) => a.submissionId),
    ).size !== assessments.filter((a) => a.submissionId).length
  )
    throw new Error('Duplicate progress assessment identity');
  for (const a of assessments) {
    if (
      a.sourceVersion >= r.version ||
      a.remainingExecutionMs > r.authorization.totalExecutionMs ||
      a.reservedExecutionMs !==
        Math.min(a.remainingExecutionMs, r.progress.limits.maxAssessmentMs) ||
      a.grantId !== r.authorization.id ||
      a.repairOrdinal > r.authorization.maxRepairAttempts ||
      Date.parse(a.deadlineAt) - Date.parse(a.reservedAt) !==
        a.reservedExecutionMs ||
      (a.state === 'reserved' && a.submissionId !== null) ||
      (a.state !== 'settled' &&
        (a.result !== null ||
          a.resultId !== null ||
          a.executionMs !== null ||
          a.completedAt !== null)) ||
      (a.state === 'settled' && (!a.submissionId || !a.resultId)) ||
      (!isDeepStrictEqual(a.revision, r.initialRevision) &&
        !r.repairs.some((repair) =>
          isDeepStrictEqual(repair.revision, a.revision),
        )) ||
      (a.result &&
        (!sameProgressBinding(a, a.result) ||
          a.result.evidenceRefs.some(
            (ref) => !a.evidenceRefs.includes(ref),
          ))) ||
      (a.result &&
        a.result.decision !== 'escalate' &&
        (a.executionMs === null ||
          a.executionMs > a.reservedExecutionMs ||
          a.completedAt === null ||
          Date.parse(a.completedAt) < Date.parse(a.reservedAt) ||
          Date.parse(a.completedAt) > Date.parse(a.deadlineAt))) ||
      (a.executionMs !== null &&
        a.executionMs > a.reservedExecutionMs &&
        !r.interventions.some(
          (i) => i.id === `progress:${a.assessmentId}` && i.resolution === null,
        ))
    )
      throw new Error('Corrupt progress assessment');
  }
  for (const [index, repair] of r.repairs.entries()) {
    if (repair.progressAssessmentId === null) {
      if (
        repair.progressInputDigest !== null ||
        repair.progressEvidenceDigest !== null ||
        assessments.some((a) => a.repairOrdinal === index + 1)
      )
        throw new Error('Corrupt repair progress linkage');
      continue; // Pre-upgrade historical repairs retain their original audit evidence.
    }
    const a = assessments.find(
      (a) => a.assessmentId === repair.progressAssessmentId,
    );
    if (
      !a ||
      a.state !== 'settled' ||
      !a.result ||
      a.result.decision === 'escalate' ||
      a.executionMs === null ||
      a.repairOrdinal !== index + 1 ||
      a.requestId !== repair.requestId ||
      !isDeepStrictEqual(a.revision, repair.fromRevision) ||
      a.inputDigest !== repair.progressInputDigest ||
      a.evidenceDigest !== repair.progressEvidenceDigest ||
      repair.reason !==
        (a.result.decision === 'change-approach'
          ? a.result.nextInstructions
          : a.instructions)
    )
      throw new Error('Corrupt repair progress linkage');
  }
}
export function sameProgressBinding(
  a: DeliveryProgressAssessment,
  b: Pick<
    DeliveryProgressAssessment,
    | 'assessmentId'
    | 'grantId'
    | 'revision'
    | 'repairOrdinal'
    | 'requestId'
    | 'inputDigest'
    | 'evidenceDigest'
  >,
) {
  return (
    a.assessmentId === b.assessmentId &&
    a.grantId === b.grantId &&
    isDeepStrictEqual(a.revision, b.revision) &&
    a.repairOrdinal === b.repairOrdinal &&
    a.requestId === b.requestId &&
    a.inputDigest === b.inputDigest &&
    a.evidenceDigest === b.evidenceDigest
  );
}
export function assertProgressRepair(
  r: DeliveryPipeline,
  cmd: {
    progressAssessmentId: string;
    progressInputDigest: string;
    progressEvidenceDigest: string;
    requestId: string;
    reason: string;
  },
) {
  const a = r.progress.assessments.find(
    (a) => a.assessmentId === cmd.progressAssessmentId,
  );
  if (
    !a ||
    a.state !== 'settled' ||
    !a.result ||
    a.executionMs === null ||
    a.executionMs > a.reservedExecutionMs ||
    a.result.decision === 'escalate' ||
    a.grantId !== r.authorization.id ||
    !isDeepStrictEqual(a.revision, r.revision) ||
    a.repairOrdinal !== r.repairs.length + 1 ||
    a.requestId !== cmd.requestId ||
    a.inputDigest !== cmd.progressInputDigest ||
    a.evidenceDigest !== cmd.progressEvidenceDigest ||
    a.evidenceDigest !== deliveryProgressEvidenceDigest(r) ||
    cmd.reason !==
      (a.result.decision === 'change-approach'
        ? a.result.nextInstructions
        : a.instructions)
  )
    throw new Error('Current successful bound progress assessment required');
}
