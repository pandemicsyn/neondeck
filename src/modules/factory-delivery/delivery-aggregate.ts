import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as v from 'valibot';
import {
  deliveryPipelineSchema,
  type DeliveryPipeline,
  type DeliveryRevision,
  type DeliveryEvidence,
} from '../../../shared/factory-delivery';

// Domain invariants and projections. No database or external effects live here.
export function sameDeliveryRevision(a: DeliveryRevision, b: DeliveryRevision) {
  return isDeepStrictEqual(a, b);
}
export function sameScope(a: DeliveryRevision, b: DeliveryRevision) {
  return (
    a.releaseId === b.releaseId &&
    a.specVersion === b.specVersion &&
    a.specHash === b.specHash &&
    a.baseSha === b.baseSha
  );
}
export function identity(repoId: string, r: DeliveryRevision) {
  return createHash('sha256')
    .update(JSON.stringify([repoId, r.runId, r.attemptId, r.candidateDigest]))
    .digest('hex');
}
export function assertRecord(r: DeliveryPipeline) {
  const key = identity(r.repoId, r.initialRevision);
  if (
    r.pipelineId !== key ||
    r.branch !== `agent/factory-${key}` ||
    r.prIdentity !== `neondeck-factory:${key}` ||
    !sameDeliveryRevision(r.authorization.revision, r.initialRevision) ||
    r.authorization.repoId !== r.repoId ||
    !sameScope(r.initialRevision, r.revision) ||
    r.repairs.length > r.authorization.maxRepairAttempts ||
    r.repairs.filter((x) => x.status === 'reserved').length > 1 ||
    (r.outcome === null) !== (r.outcomeRef === null) ||
    new Set(r.repairs.map((x) => x.runId)).size !== r.repairs.length ||
    new Set(r.repairs.map((x) => x.attemptId)).size !== r.repairs.length ||
    new Set(r.repairs.map((x) => x.requestId)).size !== r.repairs.length ||
    new Set(r.effects.map((x) => x.id)).size !== r.effects.length ||
    new Set(r.evidence.map((x) => x.id)).size !== r.evidence.length ||
    new Set(r.evidence.map((x) => x.effectId)).size !== r.evidence.length ||
    new Set(r.interventions.map((x) => x.id)).size !== r.interventions.length
  )
    throw new Error('Inconsistent delivery record');
  for (const effect of r.effects) {
    if (
      !sameScope(effect.revision, r.initialRevision) ||
      ['verification', 'review', 'feedback-review'].includes(effect.kind) !==
        (effect.reservedExecutionMs !== null) ||
      (effect.state === 'delivered' && effect.receiptRef === null) ||
      (['verification', 'review', 'feedback-review'].includes(effect.kind) &&
        effect.state === 'delivered' &&
        effect.executionMs === null) ||
      (effect.executionMs !== null &&
        effect.executionMs > (effect.reservedExecutionMs ?? 0) &&
        !r.interventions.some(
          (i) =>
            i.id === `budget:${effect.id}` &&
            i.kind === 'budget' &&
            i.resolution === null,
        ))
    )
      throw new Error('Inconsistent effect ledger');
  }
  for (const evidence of r.evidence) {
    const effect = r.effects.find((x) => x.id === evidence.effectId);
    if (
      !effect ||
      effect.kind !== evidence.kind ||
      !sameDeliveryRevision(effect.revision, evidence.revision) ||
      evidence.validationContractDigest !==
        deliveryValidationContractDigest(r) ||
      (effect.state === 'delivered' &&
        effect.receiptRef !== evidence.evidenceRef)
    )
      throw new Error('Corrupt evidence effect provenance');
    if (evidence.kind === 'review') {
      const verification = r.evidence.find(
        (x) => x.id === evidence.verificationEvidenceId,
      );
      if (
        !verification ||
        verification.kind !== 'verification' ||
        verification.result !== 'passed' ||
        !sameDeliveryRevision(verification.revision, evidence.revision) ||
        verification.bundleDigest !== evidence.verificationBundleDigest ||
        !settledEvidence(r, verification)
      )
        throw new Error('Corrupt review verification linkage');
    }
    if (
      !sameScope(evidence.revision, r.initialRevision) ||
      [evidence.revision.runId, evidence.revision.attemptId].includes(
        evidence.producerId,
      )
    )
      throw new Error('Corrupt evidence provenance');
  }
  if (
    new Set(r.feedback.map((f) => f.id)).size !== r.feedback.length ||
    new Set(r.feedback.map((f) => f.fingerprint)).size !== r.feedback.length
  )
    throw new Error('Duplicate feedback identity');
  for (const feedback of r.feedback) {
    if (
      !sameScope(feedback.revision, r.initialRevision) ||
      !r.commits.some(
        (c) =>
          sameDeliveryRevision(c.revision, feedback.revision) &&
          c.publishedHeadSha === feedback.publishedHeadSha,
      ) ||
      (feedback.repairRequestId !== null &&
        !r.repairs.some((x) => x.requestId === feedback.repairRequestId))
    )
      throw new Error('Corrupt feedback provenance');
    if (feedback.classification) {
      const effect = r.effects.find(
        (e) => e.id === feedback.classification?.effectId,
      );
      if (
        !effect ||
        effect.id !== `feedback-review:${feedback.fingerprint}` ||
        effect.kind !== 'feedback-review' ||
        effect.state !== 'delivered' ||
        effect.executionMs === null ||
        effect.receiptRef !== feedback.classification.evidenceRef ||
        !sameDeliveryRevision(effect.revision, feedback.revision)
      )
        throw new Error('Corrupt feedback classification');
    }
  }
  for (const commit of r.commits) {
    if (
      !sameScope(commit.revision, r.initialRevision) ||
      commit.treeSha !== commit.revision.treeSha
    )
      throw new Error('Corrupt commit provenance');
  }
  for (const repair of r.repairs) {
    if (
      repair.runId === r.initialRevision.runId ||
      repair.attemptId === r.initialRevision.attemptId ||
      !sameScope(repair.fromRevision, r.initialRevision) ||
      (repair.status === 'reserved' && repair.executionMs !== null) ||
      (repair.status === 'candidate') !== (repair.revision !== null) ||
      (repair.executionMs !== null &&
        repair.executionMs > repair.reservedExecutionMs &&
        !r.interventions.some(
          (i) =>
            i.id === `budget:${repair.runId}` &&
            i.kind === 'budget' &&
            i.resolution === null,
        )) ||
      (repair.revision &&
        (repair.revision.runId !== repair.runId ||
          repair.revision.attemptId !== repair.attemptId ||
          !sameScope(repair.revision, r.initialRevision)))
    )
      throw new Error('Inconsistent repair identity');
  }
  if (
    !sameDeliveryRevision(r.initialRevision, r.revision) &&
    !r.repairs.some(
      (x) => x.revision && sameDeliveryRevision(x.revision, r.revision),
    )
  )
    throw new Error('Unlinked delivery revision');
}
export function active(r: DeliveryPipeline) {
  if (r.outcome) throw new Error('Delivery is terminal');
}
export function available(r: DeliveryPipeline) {
  active(r);
  if (r.interventions.some((x) => x.resolution === null))
    throw new Error('Delivery needs intervention');
  if (r.repairs.some((x) => x.status === 'reserved'))
    throw new Error('Repair already reserved');
}
export function deliveryValidationContractDigest(r: DeliveryPipeline) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        r.authorization.configFingerprint,
        r.authorization.checkCommands,
        r.initialRevision.specVersion,
        r.initialRevision.specHash,
      ]),
    )
    .digest('hex');
}
export function settledEvidence(r: DeliveryPipeline, e: DeliveryEvidence) {
  const effect = r.effects.find((x) => x.id === e.effectId);
  return (
    effect?.state === 'delivered' &&
    effect.kind === e.kind &&
    sameDeliveryRevision(effect.revision, e.revision) &&
    effect.receiptRef === e.evidenceRef &&
    effect.executionMs !== null &&
    effect.reservedExecutionMs !== null &&
    e.validationContractDigest === deliveryValidationContractDigest(r)
  );
}
export function currentPasses(r: DeliveryPipeline) {
  const latest = (kind: 'verification' | 'review') =>
    r.evidence.findLast(
      (e) => e.kind === kind && sameDeliveryRevision(e.revision, r.revision),
    );
  const verification = latest('verification');
  const review = latest('review');
  if (
    verification?.result !== 'passed' ||
    review?.result !== 'passed' ||
    verification.producerId === review.producerId ||
    !settledEvidence(r, verification) ||
    !settledEvidence(r, review) ||
    review.verificationEvidenceId !== verification.id ||
    review.verificationBundleDigest !== verification.bundleDigest
  )
    throw new Error('Current independent verification and review required');
}
export function spentExecution(r: DeliveryPipeline) {
  return (
    r.authorization.initialExecutionMs +
    r.repairs.reduce(
      (n, x) => n + (x.executionMs ?? x.reservedExecutionMs),
      0,
    ) +
    r.effects.reduce(
      (n, x) => n + (x.executionMs ?? x.reservedExecutionMs ?? 0),
      0,
    )
  );
}
export function unresolvedEffects(r: DeliveryPipeline) {
  return r.effects.some(
    (x) => x.state === 'in-flight' || x.state === 'uncertain',
  );
}
export function getPendingDeliveryFeedback(r: DeliveryPipeline) {
  const latest = r.feedback.findLast((f) =>
    sameDeliveryRevision(f.revision, r.revision),
  );
  if (
    !latest ||
    latest.repairRequestId ||
    latest.classification?.result === 'scope-change'
  )
    return null;
  // Prose is only repair authority after an independent scoped classification.
  return latest.ciFailed || latest.classification?.result === 'scoped-repair'
    ? latest
    : null;
}

/** Reserved work continues to count during uncertainty; elapsed time does not release budget. */
export function deliveryBudget(input: DeliveryPipeline) {
  const r = v.parse(deliveryPipelineSchema, input);
  assertRecord(r);
  const consumedExecutionMs =
    r.authorization.initialExecutionMs +
    r.repairs.reduce((n, x) => n + (x.executionMs ?? 0), 0) +
    r.effects.reduce((n, x) => n + (x.executionMs ?? 0), 0);
  const reservedExecutionMs =
    r.repairs.reduce(
      (n, x) => n + (x.executionMs === null ? x.reservedExecutionMs : 0),
      0,
    ) +
    r.effects.reduce(
      (n, x) => n + (x.executionMs === null ? (x.reservedExecutionMs ?? 0) : 0),
      0,
    );
  return {
    consumedExecutionMs,
    reservedExecutionMs,
    remainingExecutionMs: Math.max(
      0,
      r.authorization.totalExecutionMs -
        consumedExecutionMs -
        reservedExecutionMs,
    ),
    repairsUsed: r.repairs.length,
    repairsRemaining: r.authorization.maxRepairAttempts - r.repairs.length,
  };
}
