import type { FactoryTimelineEntry } from '../../../../shared/factory-diagnostics';
import type { FactoryCodingRun } from '../../../../shared/factory-coding';
import {
  getFactoryCodingEvents,
  getFactoryCodingRun,
} from '../../api/factory-coding';
import { getFactoryDelivery } from '../../api/factory-delivery';
import { getFactoryDeliveryProgressEvidence } from '../../api/factory-progress';

const sameRevision = (
  a: NonNullable<FactoryTimelineEntry['revision']>,
  b: NonNullable<FactoryTimelineEntry['revision']>,
) =>
  Object.keys(a).every(
    (key) => a[key as keyof typeof a] === b[key as keyof typeof b],
  );
// Coding records expose base/head and worktree identity, but no sealed tree or
// delivery digest. Compare every available field without synthesizing a hash.
function matchesCandidate(
  run: FactoryCodingRun,
  revision: NonNullable<FactoryTimelineEntry['revision']>,
) {
  const { record } = run;
  return (
    record.runId === revision.runId &&
    record.attemptId === revision.attemptId &&
    record.snapshot.releaseId === revision.releaseId &&
    record.snapshot.specVersion === revision.specVersion &&
    record.snapshot.specHash === revision.specHash &&
    record.snapshot.baseSha === revision.baseSha &&
    record.candidate?.baseSha === revision.baseSha &&
    record.candidate.headSha === revision.headSha
  );
}
function checkWorktree(run: FactoryCodingRun) {
  if (
    run.record.candidate &&
    run.record.candidate.baseSha !== run.record.snapshot.baseSha
  )
    throw new Error(
      'Coding candidate base does not match its source snapshot.',
    );
  if (
    run.diff &&
    ((run.record.candidate !== null &&
      run.diff.worktreeId !== run.record.candidate.worktreeId) ||
      run.diff.worktreeId !== run.record.workspace?.worktreeId)
  )
    throw new Error(
      'Coding diff does not match the recorded candidate worktree.',
    );
}
export async function loadFactoryTimelineEvidence(
  entry: FactoryTimelineEntry,
  signal?: AbortSignal,
) {
  const { deliveryId, runId } = entry.correlation;

  if (deliveryId) {
    const detail = await getFactoryDelivery(deliveryId, { signal });
    if (
      detail.pipeline.pipelineId !== deliveryId ||
      detail.pipeline.workItemId !== entry.correlation.workItemId
    )
      throw new Error('Delivery task binding does not match this record.');
    if (!entry.revision)
      throw new Error(
        'This entry has no exact delivery revision binding. Its references remain reference-only.',
      );
    const revision = entry.revision;
    for (const key of [
      'runId',
      'attemptId',
      'releaseId',
      'specVersion',
      'specHash',
    ] as const) {
      if (
        entry.correlation[key] !== undefined &&
        entry.correlation[key] !== revision[key]
      )
        throw new Error(
          'Recorded delivery correlation does not match its revision binding.',
        );
    }
    if (entry.kind === 'repair') {
      const target = entry.repairTarget;
      const repair =
        target &&
        detail.pipeline.repairs.find(
          (item) =>
            entry.id === `repair:${deliveryId}:${item.runId}` &&
            item.runId === target.runId &&
            item.attemptId === target.attemptId &&
            sameRevision(item.fromRevision, revision),
        );
      if (!repair)
        throw new Error(
          'Repair target is not bound to this pipeline and historical source revision.',
        );
      const run = await getFactoryCodingRun(repair.runId, { signal });
      const snapshot = run.record.snapshot;
      if (
        run.record.attemptId !== repair.attemptId ||
        snapshot.requestId !== repair.requestId ||
        snapshot.workItemId !== detail.pipeline.workItemId ||
        snapshot.repoId !== detail.pipeline.repoId ||
        snapshot.releaseId !== revision.releaseId ||
        snapshot.specVersion !== revision.specVersion ||
        snapshot.specHash !== revision.specHash ||
        snapshot.baseSha !== revision.baseSha ||
        (repair.revision !== null && !matchesCandidate(run, repair.revision))
      )
        throw new Error(
          'Repair coding run does not match the recorded target binding.',
        );
      checkWorktree(run);
      return { kind: 'coding' as const, run, sourceRevision: revision };
    }
    if (entry.kind === 'judge') {
      const assessments = detail.pipeline.progress.assessments.filter(
        (item) =>
          entry.id === `judge-result:${item.assessmentId}` &&
          item.state === 'settled' &&
          sameRevision(item.revision, revision) &&
          (entry.correlation.submissionId === undefined ||
            entry.correlation.submissionId === item.submissionId) &&
          item.resultId !== null &&
          entry.evidenceRefs.length === 1 &&
          entry.evidenceRefs[0] === item.resultId,
      );
      if (assessments.length !== 1)
        throw new Error(
          'No settled assessment matches these recorded references. References remain reference-only.',
        );
      const assessment = assessments[0];
      const content = await getFactoryDeliveryProgressEvidence(
        deliveryId,
        assessment.assessmentId,
        { signal },
      );
      if (
        !sameRevision(content.assessment.revision, revision) ||
        content.assessment.assessmentId !== assessment.assessmentId ||
        content.assessment.state !== 'settled' ||
        content.assessment.resultId !== assessment.resultId ||
        content.assessment.submissionId !== assessment.submissionId ||
        content.assessment.inputDigest !== assessment.inputDigest ||
        content.assessment.evidenceDigest !== assessment.evidenceDigest ||
        content.assessment.grantId !== assessment.grantId ||
        content.assessment.requestId !== assessment.requestId ||
        content.assessment.repairOrdinal !== assessment.repairOrdinal ||
        (content.assessment.result !== null &&
          (content.assessment.result.assessmentId !== assessment.assessmentId ||
            !sameRevision(content.assessment.result.revision, revision) ||
            content.assessment.result.inputDigest !== assessment.inputDigest ||
            content.assessment.result.evidenceDigest !==
              assessment.evidenceDigest ||
            content.assessment.result.grantId !== assessment.grantId ||
            content.assessment.result.requestId !== assessment.requestId ||
            content.assessment.result.repairOrdinal !==
              assessment.repairOrdinal))
      )
        throw new Error('Assessment revision does not match this record.');
      return { kind: 'progress' as const, content };
    }
    const current = sameRevision(detail.pipeline.revision, revision);
    const validation = entry.kind === 'verification' || entry.kind === 'review';
    // Match the producer's complete ID and receipt reference, not a guessed
    // suffix or another validation record for the same candidate.
    const matches = validation
      ? detail.pipeline.evidence.filter(
          (item) =>
            entry.id === `evidence:${deliveryId}:${item.id}` &&
            entry.kind === item.kind &&
            entry.evidenceRefs.length === 1 &&
            entry.evidenceRefs[0] === item.evidenceRef &&
            sameRevision(item.revision, revision) &&
            (entry.correlation.effectId === undefined ||
              entry.correlation.effectId === item.effectId),
        )
      : [];
    if (
      (validation && matches.length !== 1) ||
      (!validation && entry.id.startsWith('evidence:'))
    )
      throw new Error(
        'No unique validation evidence matches this entry’s recorded ID, reference, kind, and revision. References remain reference-only.',
      );
    if (!validation) {
      const pipeline = detail.pipeline;
      const referencesMatch = (ref: string | null) =>
        entry.evidenceRefs.length === (ref ? 1 : 0) &&
        (!ref || entry.evidenceRefs[0] === ref);
      const bound =
        entry.kind === 'authorization'
          ? entry.id === `authorization:${pipeline.authorization.id}` &&
            sameRevision(pipeline.authorization.revision, revision) &&
            referencesMatch(null)
          : entry.kind === 'outcome'
            ? !!pipeline.outcome &&
              entry.id === `outcome:${deliveryId}` &&
              referencesMatch(pipeline.outcomeRef)
            : entry.kind === 'effect' &&
              pipeline.effects.some(
                (effect) =>
                  entry.id === `effect:${deliveryId}:${effect.id}` &&
                  entry.correlation.effectId === effect.id &&
                  sameRevision(effect.revision, revision) &&
                  referencesMatch(effect.receiptRef),
              );
      if (!bound)
        throw new Error('Delivery event binding does not match this record.');
    }
    if (!validation && !current)
      throw new Error(
        'The current pipeline differs from this historical revision. This entry has no exact retained validation evidence binding; references remain reference-only.',
      );
    return {
      kind: 'delivery' as const,
      detail,
      current,
      matches,
      validation,
    };
  }
  const run = await getFactoryCodingRun(runId!, { signal });
  const record = run.record;
  const expected = entry.correlation;
  if (
    record.snapshot.workItemId !== expected.workItemId ||
    (expected.attemptId !== undefined &&
      record.attemptId !== expected.attemptId) ||
    (expected.releaseId !== undefined &&
      record.snapshot.releaseId !== expected.releaseId) ||
    (expected.specVersion !== undefined &&
      record.snapshot.specVersion !== expected.specVersion) ||
    (expected.specHash !== undefined &&
      record.snapshot.specHash !== expected.specHash)
  )
    throw new Error('Coding evidence binding does not match this record.');
  if (entry.revision && !matchesCandidate(run, entry.revision))
    throw new Error('Coding candidate does not match the recorded revision.');
  if (
    entry.kind !== 'coding' ||
    entry.evidenceRefs.length !== 0 ||
    !/^coding-event:[1-9]\d*$/.test(entry.id)
  )
    throw new Error('Coding event ID does not match the timeline producer.');
  const sequence = Number(entry.id.slice('coding-event:'.length));
  if (!Number.isSafeInteger(sequence))
    throw new Error('Invalid coding event ID.');
  const events = await getFactoryCodingEvents(runId!, sequence - 1, {
    signal,
  });
  if (
    !events.items.some(
      (event) =>
        entry.id === `coding-event:${event.sequence}` &&
        event.runId === record.runId &&
        event.createdAt === entry.occurredAt,
    )
  )
    throw new Error('Coding event is not bound to this run.');
  checkWorktree(run);
  return { kind: 'coding' as const, run, sourceRevision: null };
}
