import { assertProgressRepair } from './progress-domain';
export {
  reserveDeliveryProgress,
  updateDeliveryProgress,
} from './progress-store';
export { deliveryProgressEvidenceDigest } from './progress-domain';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { withImmediateTransaction } from '../../lib/sqlite';
import {
  codingRunRecordSchema,
  type CodingRunRecord,
} from '../../../shared/coding-runs';
import {
  deliveryPipelineSchema,
  deliveryReservationSchema,
  deliveryCommandSchema,
  deliveryListSchema,
  deliveryRepairReservationSchema,
  type DeliveryPipeline,
} from '../../../shared/factory-delivery';
import {
  database,
  decode,
  get,
  save,
  label,
  type Paths,
} from './delivery-persistence';
import {
  identity,
  assertRecord,
  active,
  available,
  sameDeliveryRevision,
  spentExecution,
  unresolvedEffects,
  getPendingDeliveryFeedback,
} from './delivery-aggregate';
import { applyDeliveryCommand } from './delivery-commands';
import { assertNoLegacyOwnerInTransaction } from './delivery-ownership';

// Public persistence boundary. Internal helpers are deliberately not barrel exports.
export {
  sameDeliveryRevision,
  deliveryValidationContractDigest,
  deliveryBudget,
  getPendingDeliveryFeedback,
} from './delivery-aggregate';
export {
  getFactoryDeliveryOwnership,
  isFactoryOwnedWatch,
  isFactoryOwnedWatchInTransaction,
} from './delivery-ownership';

/** Admission service establishes exact human authority and authenticates the candidate before calling. */
export function reserveDeliveryPipeline(
  input: unknown,
  paths: Paths,
): DeliveryPipeline {
  const request = v.parse(deliveryReservationSchema, input);
  if (
    !sameDeliveryRevision(
      request.initialRevision,
      request.authorization.revision,
    ) ||
    request.repoId !== request.authorization.repoId
  )
    throw new Error('Delivery authorization mismatch');
  return database(paths, (db) =>
    withImmediateTransaction(db, () => {
      const rows = db
        .prepare(
          "SELECT * FROM factory_delivery_pipelines WHERE release_id=? OR initial_run_id=? OR initial_attempt_id=? OR json_extract(record_json,'$.authorization.id')=?",
        )
        .all(
          request.initialRevision.releaseId,
          request.initialRevision.runId,
          request.initialRevision.attemptId,
          request.authorization.id,
        );
      if (rows.length) {
        const prior = decode(rows[0]).record;
        if (
          rows.length !== 1 ||
          prior.repoId !== request.repoId ||
          prior.workItemId !== request.workItemId ||
          !sameDeliveryRevision(
            prior.initialRevision,
            request.initialRevision,
          ) ||
          !isDeepStrictEqual(prior.authorization, request.authorization)
        )
          throw new Error('Conflicting delivery replay');
        return prior;
      }
      const key = identity(request.repoId, request.initialRevision);
      const now = new Date().toISOString();
      const r = v.parse(deliveryPipelineSchema, {
        ...request,
        pipelineId: key,
        version: 1,
        revision: request.initialRevision,
        branch: `agent/factory-${key}`,
        prIdentity: `neondeck-factory:${key}`,
        pr: null,
        repairs: [],
        evidence: [],
        effects: [],
        feedback: [],
        interventions: [],
        commits: [],
        coordinator: {
          candidateRef: null,
          watchId: null,
          observationFingerprint: null,
          terminalObservedAt: null,
        },
        outcome: null,
        outcomeRef: null,
        createdAt: now,
        updatedAt: now,
      });
      assertRecord(r);
      db.prepare(
        'INSERT INTO factory_delivery_pipelines (pipeline_id,release_id,initial_run_id,initial_attempt_id,work_item_id,repo_id,branch,record_json) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        r.pipelineId,
        r.initialRevision.releaseId,
        r.initialRevision.runId,
        r.initialRevision.attemptId,
        r.workItemId,
        r.repoId,
        r.branch,
        JSON.stringify(r),
      );
      return r;
    }),
  );
}
export function getDeliveryPipeline(id: unknown, paths: Paths) {
  return database(paths, (db) => get(db, v.parse(label, id)));
}
export function listDeliveryPipelines(input: unknown, paths: Paths) {
  const page = v.parse(deliveryListSchema, input);
  return database(paths, (db) => {
    const where = page.workItemId === undefined ? '' : ' AND work_item_id=?';
    const args: (string | number)[] = [page.after];
    if (page.workItemId !== undefined) args.push(page.workItemId);
    args.push(page.limit);
    return db
      .prepare(
        `SELECT * FROM factory_delivery_pipelines WHERE sequence>?${where} ORDER BY sequence LIMIT ?`,
      )
      .all(...args)
      .map(decode);
  });
}
/** Atomic budget + writer admission. Callback must insert a fresh run in this transaction, never launch compute. */
export function reserveDeliveryRepair(
  input: unknown,
  paths: Paths,
  createRun: (
    db: DatabaseSync,
    input: { parentRunId: string; requestId: string; maxWallTimeMs: number },
  ) => CodingRunRecord,
) {
  const cmd = v.parse(deliveryRepairReservationSchema, input);
  return database(paths, (db) =>
    withImmediateTransaction(db, () => {
      const r = get(db, cmd.pipelineId);
      if (!r) throw new Error('Delivery missing');
      const replay = r.repairs.find((x) => x.requestId === cmd.requestId);
      if (replay) {
        if (
          replay.progressAssessmentId !== cmd.progressAssessmentId ||
          replay.progressInputDigest !== cmd.progressInputDigest ||
          replay.progressEvidenceDigest !== cmd.progressEvidenceDigest ||
          replay.reason !== cmd.reason ||
          replay.reservedExecutionMs !== cmd.maxWallTimeMs
        )
          throw new Error('Conflicting repair replay');
        const row = db
          .prepare('SELECT record_json FROM coding_runs WHERE run_id=?')
          .get(replay.runId);
        const value = v.parse(v.strictObject({ record_json: v.string() }), row);
        const run = v.parse(
          codingRunRecordSchema,
          JSON.parse(value.record_json),
        );
        if (run.runId !== replay.runId || run.attemptId !== replay.attemptId)
          throw new Error('Repair run mismatch');
        return { pipeline: r, run };
      }
      if (r.version !== cmd.expectedVersion)
        throw new Error('Delivery version conflict');
      available(r);
      if (unresolvedEffects(r))
        throw new Error('External operation unresolved');
      const feedback = getPendingDeliveryFeedback(r);
      if (
        !feedback &&
        !r.evidence.some(
          (e) =>
            e.result === 'failed' &&
            sameDeliveryRevision(e.revision, r.revision) &&
            r.evidence.findLast(
              (x) =>
                x.kind === e.kind &&
                sameDeliveryRevision(x.revision, r.revision),
            )?.id === e.id,
        )
      )
        throw new Error('Current failed evidence required for repair');
      assertProgressRepair(r, cmd);
      const spent = spentExecution(r);
      if (
        r.repairs.length >= r.authorization.maxRepairAttempts ||
        spent + cmd.maxWallTimeMs > r.authorization.totalExecutionMs
      )
        throw new Error('Repair budget exhausted; intervention required');
      const run = v.parse(
        codingRunRecordSchema,
        createRun(db, {
          parentRunId: r.revision.runId,
          requestId: cmd.requestId,
          maxWallTimeMs: cmd.maxWallTimeMs,
        }),
      );
      if (
        run.status !== 'reserved' ||
        run.snapshot.requestId !== cmd.requestId ||
        run.snapshot.repoId !== r.repoId ||
        run.snapshot.workItemId !== r.workItemId ||
        run.snapshot.releaseId !== r.revision.releaseId ||
        run.snapshot.specVersion !== r.revision.specVersion ||
        run.snapshot.specHash !== r.revision.specHash ||
        run.snapshot.baseSha !== r.revision.baseSha
      )
        throw new Error('Repair run authority mismatch');
      if (feedback) feedback.repairRequestId = cmd.requestId;
      r.repairs.push({
        runId: run.runId,
        attemptId: run.attemptId,
        requestId: cmd.requestId,
        reason: cmd.reason,
        reservedExecutionMs: cmd.maxWallTimeMs,
        executionMs: null,
        fromRevision: r.revision,
        progressAssessmentId: cmd.progressAssessmentId,
        progressInputDigest: cmd.progressInputDigest,
        progressEvidenceDigest: cmd.progressEvidenceDigest,
        status: 'reserved',
        revision: null,
      });
      return { pipeline: save(db, r), run };
    }),
  );
}
export function updateDeliveryPipeline(
  input: unknown,
  paths: Paths,
): DeliveryPipeline {
  const cmd = v.parse(deliveryCommandSchema, input);
  return database(paths, (db) =>
    withImmediateTransaction(db, () => {
      const r = get(db, cmd.pipelineId);
      if (!r || r.version !== cmd.expectedVersion)
        throw new Error('Delivery version conflict');
      active(r);
      const a = cmd.action;
      if (
        !applyDeliveryCommand(r, a, () =>
          assertNoLegacyOwnerInTransaction(db, r),
        )
      )
        return r;
      return save(db, r);
    }),
  );
}
