import { isDeepStrictEqual } from 'node:util';
import type {
  DeliveryPipeline,
  DeliveryCommand,
} from '../../../shared/factory-delivery';
import {
  available,
  sameDeliveryRevision,
  sameScope,
  currentPasses,
  spentExecution,
  unresolvedEffects,
} from './delivery-aggregate';

/** Mutates one validated aggregate. Returns false for exact replay. The caller
 * owns the transaction and supplies its publication ownership check. */
export function applyDeliveryCommand(
  r: DeliveryPipeline,
  a: DeliveryCommand['action'],
  assertPublicationOwnership: () => void,
): boolean {
  switch (a.type) {
    case 'bind-effect-receipt': {
      const effect = r.effects.find((e) => e.id === a.id);
      if (!effect || effect.state !== 'in-flight' || effect.receiptRef !== null)
        throw new Error('Effect receipt already bound or not running');
      effect.receiptRef = a.receiptRef;
      break;
    }
    case 'record-feedback': {
      available(r);
      if (
        !sameDeliveryRevision(a.feedback.revision, r.revision) ||
        !r.commits.some(
          (c) =>
            sameDeliveryRevision(c.revision, r.revision) &&
            c.publishedHeadSha === a.feedback.publishedHeadSha,
        )
      )
        throw new Error('Stale feedback revision');
      const prior = r.feedback.find(
        (f) =>
          f.id === a.feedback.id || f.fingerprint === a.feedback.fingerprint,
      );
      if (prior) {
        const {
          classification: _classification,
          repairRequestId: _repairRequestId,
          ...observation
        } = prior;
        if (!isDeepStrictEqual(observation, a.feedback))
          throw new Error('Conflicting feedback replay');
        return false;
      }
      r.feedback.push({
        ...a.feedback,
        classification: null,
        repairRequestId: null,
      });
      break;
    }
    case 'classify-feedback': {
      available(r);
      const feedback = r.feedback.find((f) => f.id === a.id);
      const effect = r.effects.find((e) => e.id === a.effectId);
      if (
        !feedback ||
        !sameDeliveryRevision(feedback.revision, r.revision) ||
        r.feedback.findLast((f) => sameDeliveryRevision(f.revision, r.revision))
          ?.id !== feedback.id ||
        !feedback.hasReviewFeedback ||
        feedback.classification ||
        !effect ||
        effect.id !== `feedback-review:${feedback.fingerprint}` ||
        effect.kind !== 'feedback-review' ||
        effect.state !== 'delivered' ||
        effect.receiptRef !== a.evidenceRef ||
        !sameDeliveryRevision(effect.revision, feedback.revision)
      )
        throw new Error('Feedback classification receipt missing');
      feedback.classification = {
        effectId: a.effectId,
        result: a.result,
        evidenceRef: a.evidenceRef,
      };
      if (a.result === 'scope-change')
        r.interventions.push({
          id: `feedback:${a.id}`,
          kind: 'scope',
          reason: 'External feedback changes authorized scope',
          revision: r.revision,
          resolution: null,
        });
      break;
    }
    case 'set-coordinator':
      if (
        r.coordinator.watchId &&
        a.coordinator.watchId !== r.coordinator.watchId
      )
        throw new Error('Watch identity immutable');
      r.coordinator = a.coordinator;
      break;
    case 'bind-commit': {
      if (a.treeSha !== r.revision.treeSha)
        throw new Error('Commit changed authorized candidate content');
      if (
        !r.effects.some(
          (x) =>
            x.kind === 'commit' &&
            ['in-flight', 'uncertain'].includes(x.state) &&
            sameDeliveryRevision(x.revision, r.revision),
        )
      )
        throw new Error('Commit reservation required');
      const previous = r.commits.find((c) =>
        sameDeliveryRevision(c.revision, r.revision),
      );
      if (previous) {
        if (
          previous.publishedHeadSha !== a.publishedHeadSha ||
          previous.treeSha !== a.treeSha ||
          previous.evidenceRef !== a.evidenceRef
        )
          throw new Error('Conflicting commit receipt');
        return false;
      }
      r.commits.push({
        revision: r.revision,
        publishedHeadSha: a.publishedHeadSha,
        treeSha: a.treeSha,
        evidenceRef: a.evidenceRef,
      });
      break;
    }
    case 'record-evidence': {
      if (!sameDeliveryRevision(a.evidence.revision, r.revision))
        throw new Error('Stale evidence revision');
      if (
        [r.revision.runId, r.revision.attemptId].includes(a.evidence.producerId)
      )
        throw new Error('Independent evidence required');
      const prior = r.evidence.find((e) => e.id === a.evidence.id);
      if (prior) {
        if (!isDeepStrictEqual(prior, a.evidence))
          throw new Error('Conflicting evidence replay');
        return false;
      }
      if (r.evidence.some((e) => e.effectId === a.evidence.effectId))
        throw new Error('Effect evidence already bound');
      r.evidence.push(a.evidence);
      break;
    }
    case 'finish-repair': {
      const repair = r.repairs.find(
        (x) => x.runId === a.runId && x.attemptId === a.attemptId,
      );
      if (!repair || repair.status !== 'reserved')
        throw new Error('Repair reservation missing');
      if (
        a.revision &&
        (a.revision.runId !== repair.runId ||
          a.revision.attemptId !== repair.attemptId ||
          !sameScope(r.revision, a.revision))
      )
        throw new Error('Repair changed authorized scope');
      repair.status = a.revision ? 'candidate' : 'failed';
      repair.revision = a.revision;
      repair.executionMs = a.executionMs;
      if (a.revision) r.revision = a.revision;
      if (a.executionMs !== null && a.executionMs > repair.reservedExecutionMs)
        r.interventions.push({
          id: `budget:${repair.runId}`,
          kind: 'budget',
          reason: 'Repair exceeded reserved execution budget',
          revision: r.revision,
          resolution: null,
        });
      break;
    }
    case 'plan-effect': {
      available(r);
      if (['commit', 'push', 'create-pr', 'update-pr'].includes(a.kind))
        currentPasses(r);
      const prior = r.effects.find((x) => x.id === a.id);
      if (prior) {
        if (
          prior.kind !== a.kind ||
          !sameDeliveryRevision(prior.revision, r.revision)
        )
          throw new Error('Conflicting effect replay');
        return false;
      }
      if (unresolvedEffects(r))
        throw new Error('External operation unresolved');
      if (
        !['verification', 'review', 'feedback-review'].includes(a.kind) &&
        r.effects.some(
          (x) =>
            x.kind === a.kind && sameDeliveryRevision(x.revision, r.revision),
        )
      )
        throw new Error('Effect already planned for revision');
      if (
        ['verification', 'review', 'feedback-review'].includes(a.kind) &&
        !a.maxExecutionMs
      )
        throw new Error('Verification execution reservation required');
      if (
        !['verification', 'review', 'feedback-review'].includes(a.kind) &&
        a.maxExecutionMs !== undefined
      )
        throw new Error('Unexpected execution reservation');
      if (
        spentExecution(r) + (a.maxExecutionMs ?? 0) >
        r.authorization.totalExecutionMs
      )
        throw new Error('Execution budget exhausted');
      if (a.kind === 'create-pr' && r.pr) throw new Error('PR already bound');
      if (a.kind === 'update-pr' && !r.pr) throw new Error('PR not bound');
      r.effects.push({
        id: a.id,
        kind: a.kind,
        revision: r.revision,
        state: 'planned',
        receiptRef: null,
        reservedExecutionMs: a.maxExecutionMs ?? null,
        executionMs: null,
      });
      break;
    }
    case 'start-effect': {
      available(r);
      if (
        ['commit', 'push', 'create-pr', 'update-pr'].includes(
          r.effects.find((x) => x.id === a.id)?.kind ?? '',
        )
      )
        currentPasses(r);
      const effect = r.effects.find((x) => x.id === a.id);
      if (
        !effect ||
        effect.state !== 'planned' ||
        !sameDeliveryRevision(effect.revision, r.revision)
      )
        throw new Error('Effect cannot start');
      if (unresolvedEffects(r))
        throw new Error('External operation unresolved');
      if (
        ['create-pr', 'update-pr'].includes(effect.kind) &&
        !r.effects.some(
          (x) =>
            x.kind === 'push' &&
            x.state === 'delivered' &&
            sameDeliveryRevision(x.revision, r.revision),
        )
      )
        throw new Error('Current push receipt required');
      if (effect.kind === 'create-pr' && !r.pr) assertPublicationOwnership();
      effect.state = 'in-flight';
      break;
    }
    case 'settle-effect':
    case 'reconcile-effect': {
      const effect = r.effects.find((x) => x.id === a.id);
      if (!effect || !['in-flight', 'uncertain'].includes(effect.state))
        throw new Error('Effect is not outstanding');
      const delivered =
        a.type === 'settle-effect'
          ? a.state === 'delivered'
          : a.observation === 'delivered';
      if (
        a.pr &&
        (!delivered || !['create-pr', 'update-pr'].includes(effect.kind))
      )
        throw new Error('Unexpected PR receipt');
      if (delivered && ['create-pr', 'update-pr'].includes(effect.kind)) {
        if (!a.pr) throw new Error('PR receipt required');
        if (r.pr && !isDeepStrictEqual(r.pr, a.pr))
          throw new Error('PR ownership mismatch');
        r.pr = a.pr;
      }
      effect.state = delivered
        ? 'delivered'
        : a.type === 'reconcile-effect'
          ? 'planned'
          : 'uncertain';
      effect.receiptRef = a.receiptRef;
      if (
        ['verification', 'review', 'feedback-review'].includes(effect.kind) &&
        delivered
      ) {
        if (
          a.executionMs === undefined ||
          (a.executionMs === null && effect.kind === 'verification')
        )
          throw new Error('Verification execution accounting required');
        effect.executionMs = a.executionMs;
        if (a.executionMs === null)
          r.interventions.push({
            id: `review-usage:${effect.id}`,
            kind: 'scope',
            reason:
              'Reviewer is terminal with unknown execution usage and certification unavailable. The full reservation remains held; return to planning.',
            revision: r.revision,
            resolution: null,
          });
        if (
          a.executionMs !== null &&
          a.executionMs > (effect.reservedExecutionMs ?? 0)
        )
          r.interventions.push({
            id: `budget:${effect.id}`,
            kind: 'budget',
            reason: 'Verification exceeded reserved execution budget',
            revision: r.revision,
            resolution: null,
          });
      } else if (a.executionMs !== undefined)
        throw new Error('Unexpected execution accounting');
      break;
    }
    case 'intervene': {
      const prior = r.interventions.find((x) => x.id === a.id);
      if (prior) {
        if (prior.kind !== a.kind || prior.reason !== a.reason)
          throw new Error('Conflicting intervention replay');
        return false;
      }
      r.interventions.push({
        id: a.id,
        kind: a.kind,
        reason: a.reason,
        revision: r.revision,
        resolution: null,
      });
      break;
    }
    case 'resolve-intervention': {
      const intervention = r.interventions.find((x) => x.id === a.id);
      if (!intervention || intervention.resolution)
        throw new Error('Open intervention missing');
      if (['scope', 'budget', 'authority'].includes(intervention.kind))
        throw new Error('New exact authorization required');
      if (unresolvedEffects(r))
        throw new Error('External operation unresolved');
      intervention.resolution = a.resolution;
      break;
    }
    case 'finish':
      if (
        unresolvedEffects(r) ||
        r.repairs.some((x) => x.status === 'reserved')
      )
        throw new Error(
          'Outstanding work must reconcile before terminal outcome',
        );
      if (['merged', 'closed'].includes(a.outcome) && !r.pr)
        throw new Error('PR outcome requires bound PR');
      r.outcome = a.outcome;
      r.outcomeRef = a.evidenceRef;
      break;
  }

  return true;
}
