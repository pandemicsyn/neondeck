import { isDeepStrictEqual } from 'node:util';
import * as v from 'valibot';
import {
  deliveryProgressReservationSchema,
  deliveryProgressCommandSchema,
} from '../../../shared/factory-progress';
import { withImmediateTransaction } from '../../lib/sqlite';
import { database, get, save, type Paths } from './delivery-persistence';
import {
  available,
  spentExecution,
  unresolvedEffects,
  sameDeliveryRevision,
  getPendingDeliveryFeedback,
  settledEvidence,
} from './delivery-aggregate';
import {
  deliveryProgressEvidenceDigest,
  sameProgressBinding,
} from './progress-domain';

/** Reserve before calling the model. A recorded start may never be replaced after uncertainty. */
export function reserveDeliveryProgress(input: unknown, paths: Paths) {
  const cmd = v.parse(deliveryProgressReservationSchema, input);
  return database(paths, (db) =>
    withImmediateTransaction(db, () => {
      const r = get(db, cmd.pipelineId);
      if (!r) throw new Error('Delivery missing');
      const prior = r.progress.assessments.find(
        (a) => a.assessmentId === cmd.assessmentId,
      );
      if (prior) {
        if (
          !sameProgressBinding(prior, cmd) ||
          prior.instructions !== cmd.instructions ||
          !isDeepStrictEqual(prior.evidenceRefs, cmd.evidenceRefs)
        )
          throw new Error('Conflicting progress replay');
        return { pipeline: r, assessment: prior, replayed: true };
      }
      if (r.version !== cmd.expectedVersion)
        throw new Error('Delivery version conflict');
      available(r);
      if (
        unresolvedEffects(r) ||
        r.progress.assessments.some((a) => a.state !== 'settled')
      )
        throw new Error('External operation unresolved');
      if (
        cmd.grantId !== r.authorization.id ||
        !sameDeliveryRevision(cmd.revision, r.revision) ||
        cmd.repairOrdinal !== r.repairs.length + 1 ||
        cmd.evidenceDigest !== deliveryProgressEvidenceDigest(r)
      )
        throw new Error('Progress authority or evidence mismatch');
      if (
        !getPendingDeliveryFeedback(r) &&
        !r.evidence.some(
          (e) =>
            e.result === 'failed' &&
            sameDeliveryRevision(e.revision, r.revision) &&
            settledEvidence(r, e) &&
            r.evidence.findLast(
              (x) =>
                x.kind === e.kind &&
                sameDeliveryRevision(x.revision, r.revision),
            )?.id === e.id,
        )
      )
        throw new Error('Current failed evidence required for progress');
      const remaining = r.authorization.totalExecutionMs - spentExecution(r);
      if (
        r.repairs.length >= r.authorization.maxRepairAttempts ||
        remaining <= 0 ||
        r.progress.assessments.length >= r.progress.limits.maxAssessments ||
        r.progress.assessments.some(
          (a) => a.repairOrdinal === cmd.repairOrdinal,
        )
      )
        throw new Error('Progress budget exhausted');
      const reservedExecutionMs = Math.min(
        r.progress.limits.maxAssessmentMs,
        remaining,
      );
      const now = Date.now();
      const {
        pipelineId: _pipelineId,
        expectedVersion: _version,
        ...binding
      } = cmd;
      const assessment = {
        ...binding,
        state: 'reserved' as const,
        sourceVersion: r.version,
        remainingExecutionMs: remaining,
        reservedAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + reservedExecutionMs).toISOString(),
        reservedExecutionMs,
        executionMs: null,
        completedAt: null,
        submissionId: null,
        resultId: null,
        result: null,
      };
      r.progress.assessments.push(assessment);
      return { pipeline: save(db, r), assessment, replayed: false };
    }),
  );
}
export function updateDeliveryProgress(input: unknown, paths: Paths) {
  const cmd = v.parse(deliveryProgressCommandSchema, input);
  return database(paths, (db) =>
    withImmediateTransaction(db, () => {
      const r = get(db, cmd.pipelineId);
      if (!r) throw new Error('Delivery missing');
      const a = r.progress.assessments.find(
        (a) => a.assessmentId === cmd.assessmentId,
      );
      if (!a) throw new Error('Progress assessment missing');
      const action = cmd.action;
      // Exact duplicate receipts are idempotent even after subsequent pipeline updates.
      if (action.type === 'settle' && a.state === 'settled') {
        if (
          a.submissionId !== action.submissionId ||
          a.resultId !== action.resultId ||
          a.executionMs !== action.executionMs ||
          a.completedAt !== action.completedAt ||
          !isDeepStrictEqual(a.result, action.result)
        )
          throw new Error('Conflicting progress settlement');
        return r;
      }
      if (
        action.type === 'bind-submission' &&
        a.submissionId === action.submissionId
      )
        return r;
      if (action.type === 'uncertain' && a.state === 'uncertain') return r;
      if (r.version !== cmd.expectedVersion)
        throw new Error('Delivery version conflict');
      switch (action.type) {
        case 'start':
          available(r);
          if (
            a.state !== 'reserved' ||
            Date.now() >= Date.parse(a.deadlineAt) ||
            a.evidenceDigest !== deliveryProgressEvidenceDigest(r)
          )
            throw new Error('Progress cannot start');
          a.state = 'in-flight';
          break;
        case 'bind-submission':
          if (
            !['in-flight', 'uncertain'].includes(a.state) ||
            a.submissionId !== null
          )
            throw new Error('Progress submission conflict');
          a.submissionId = action.submissionId;
          break;
        case 'uncertain':
          if (!['reserved', 'in-flight'].includes(a.state))
            throw new Error('Progress not outstanding');
          a.state = 'uncertain';
          break;
        case 'settle': {
          // Recheck authority in the transaction: a pause or terminal outcome
          // can arrive after the coordinator's final read. Accounting-only
          // receipts must remain recordable after authority is withdrawn.
          if (action.result && action.result.decision !== 'escalate')
            available(r);
          if (
            !['in-flight', 'uncertain'].includes(a.state) ||
            (a.submissionId !== null && a.submissionId !== action.submissionId)
          )
            throw new Error('Progress submission conflict');
          if (
            action.result &&
            (!sameProgressBinding(a, action.result) ||
              action.result.evidenceRefs.some(
                (ref) => !a.evidenceRefs.includes(ref),
              ))
          )
            throw new Error('Progress result binding mismatch');
          if (
            action.result &&
            action.result.decision !== 'escalate' &&
            (action.completedAt === null ||
              Date.parse(action.completedAt) < Date.parse(a.reservedAt) ||
              Date.parse(action.completedAt) > Date.parse(a.deadlineAt) ||
              action.executionMs === null ||
              action.executionMs > a.reservedExecutionMs ||
              a.evidenceDigest !== deliveryProgressEvidenceDigest(r))
          )
            throw new Error('Progress approval stale or usage invalid');
          a.state = 'settled';
          a.submissionId = action.submissionId;
          a.resultId = action.resultId;
          a.result = action.result;
          a.executionMs = action.executionMs;
          a.completedAt = action.completedAt;
          if (
            !action.result ||
            action.result.decision === 'escalate' ||
            action.executionMs === null ||
            action.executionMs > a.reservedExecutionMs
          )
            r.interventions.push({
              id: `progress:${a.assessmentId}`,
              kind: 'scope',
              reason:
                'Progress supervision requires an explicit human planning decision. Existing budgets remain consumed.',
              revision: a.revision,
              resolution: null,
            });
          break;
        }
      }
      return save(db, r);
    }),
  );
}
