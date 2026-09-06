import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import {
  codingRunRecordSchema,
  type CodingRunRecord,
} from '../../../shared/coding-runs';
import {
  deliveryPipelineSchema,
  deliveryReservationSchema,
  deliveryCommandSchema,
  deliveryListSchema,
  deliveryOwnershipSchema,
  deliveryRepairReservationSchema,
  type DeliveryPipeline,
  type DeliveryRevision,
} from '../../../shared/factory-delivery';

type Paths = Pick<RuntimePaths, 'neondeckDatabase'>;
const label = v.pipe(v.string(), v.minLength(1), v.maxLength(500));
const integer = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const rowSchema = v.strictObject({
  sequence: integer,
  pipeline_id: label,
  initial_run_id: label,
  initial_attempt_id: label,
  work_item_id: label,
  repo_id: label,
  branch: label,
  pr_number: v.nullable(integer),
  record_json: v.string(),
});
function database<T>(paths: Paths, fn: (db: DatabaseSync) => T): T {
  const db = openDb(
    v.parse(v.pipe(v.string(), v.minLength(1)), paths.neondeckDatabase),
  );
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function decode(input: unknown) {
  const row = v.parse(rowSchema, input);
  const record = v.parse(deliveryPipelineSchema, JSON.parse(row.record_json));
  if (
    row.pipeline_id !== record.pipelineId ||
    row.initial_run_id !== record.initialRevision.runId ||
    row.initial_attempt_id !== record.initialRevision.attemptId ||
    row.work_item_id !== record.workItemId ||
    row.repo_id !== record.repoId ||
    row.branch !== record.branch ||
    row.pr_number !== (record.pr?.number ?? null)
  )
    throw new Error('Corrupt delivery identity');
  assertRecord(record);
  return { sequence: row.sequence, record };
}
function get(db: DatabaseSync, id: string) {
  const row = db
    .prepare('SELECT * FROM factory_delivery_pipelines WHERE pipeline_id=?')
    .get(id);
  return row ? decode(row).record : null;
}
export function sameDeliveryRevision(a: DeliveryRevision, b: DeliveryRevision) {
  return isDeepStrictEqual(a, b);
}
function sameScope(a: DeliveryRevision, b: DeliveryRevision) {
  return (
    a.releaseId === b.releaseId &&
    a.specVersion === b.specVersion &&
    a.specHash === b.specHash &&
    a.baseSha === b.baseSha
  );
}
function identity(repoId: string, r: DeliveryRevision) {
  return createHash('sha256')
    .update(JSON.stringify([repoId, r.runId, r.attemptId, r.candidateDigest]))
    .digest('hex');
}
function assertRecord(r: DeliveryPipeline) {
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
    new Set(r.interventions.map((x) => x.id)).size !== r.interventions.length
  )
    throw new Error('Inconsistent delivery record');
  for (const effect of r.effects) {
    if (
      !sameScope(effect.revision, r.initialRevision) ||
      ['verification', 'review'].includes(effect.kind) !==
        (effect.reservedExecutionMs !== null) ||
      (effect.state === 'delivered' && effect.receiptRef === null) ||
      (['verification', 'review'].includes(effect.kind) &&
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
    if (
      !sameScope(evidence.revision, r.initialRevision) ||
      [evidence.revision.runId, evidence.revision.attemptId].includes(
        evidence.producerId,
      )
    )
      throw new Error('Corrupt evidence provenance');
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
      (repair.status === 'reserved') !== (repair.executionMs === null) ||
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
function save(db: DatabaseSync, r: DeliveryPipeline) {
  r.version++;
  r.updatedAt = new Date().toISOString();
  const valid = v.parse(deliveryPipelineSchema, r);
  assertRecord(valid);
  db.prepare(
    'UPDATE factory_delivery_pipelines SET record_json=?,pr_number=? WHERE pipeline_id=?',
  ).run(JSON.stringify(valid), valid.pr?.number ?? null, valid.pipelineId);
  return valid;
}
function active(r: DeliveryPipeline) {
  if (r.outcome) throw new Error('Delivery is terminal');
}
function available(r: DeliveryPipeline) {
  active(r);
  if (r.interventions.some((x) => x.resolution === null))
    throw new Error('Delivery needs intervention');
  if (r.repairs.some((x) => x.status === 'reserved'))
    throw new Error('Repair already reserved');
}
function currentPasses(r: DeliveryPipeline) {
  const latest = (kind: 'verification' | 'review') =>
    r.evidence.findLast(
      (e) => e.kind === kind && sameDeliveryRevision(e.revision, r.revision),
    );
  const verification = latest('verification');
  const review = latest('review');
  if (
    verification?.result !== 'passed' ||
    review?.result !== 'passed' ||
    verification.producerId === review.producerId
  )
    throw new Error('Current independent verification and review required');
}
function spentExecution(r: DeliveryPipeline) {
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
function unresolvedEffects(r: DeliveryPipeline) {
  return r.effects.some(
    (x) => x.state === 'in-flight' || x.state === 'uncertain',
  );
}
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
          'SELECT * FROM factory_delivery_pipelines WHERE initial_run_id=? OR initial_attempt_id=?',
        )
        .all(request.initialRevision.runId, request.initialRevision.attemptId);
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
        'INSERT INTO factory_delivery_pipelines (pipeline_id,initial_run_id,initial_attempt_id,work_item_id,repo_id,branch,record_json) VALUES (?,?,?,?,?,?,?)',
      ).run(
        r.pipelineId,
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
export function getFactoryDeliveryOwnership(input: unknown, paths: Paths) {
  const q = v.parse(deliveryOwnershipSchema, input);
  return database(paths, (db) => {
    const clauses = ['repo_id=?'];
    const args: (string | number)[] = [q.repoId];
    if (q.branch !== undefined) {
      clauses.push('branch=?');
      args.push(q.branch);
    }
    if (q.prNumber !== undefined) {
      clauses.push('pr_number=?');
      args.push(q.prNumber);
    }
    const row = db
      .prepare(
        `SELECT * FROM factory_delivery_pipelines WHERE ${clauses.join(' AND ')}`,
      )
      .get(...args);
    return row ? decode(row).record : null;
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
      if (
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
      r.repairs.push({
        runId: run.runId,
        attemptId: run.attemptId,
        requestId: cmd.requestId,
        reason: cmd.reason,
        reservedExecutionMs: cmd.maxWallTimeMs,
        executionMs: null,
        fromRevision: r.revision,
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
      switch (a.type) {
        case 'set-coordinator':
          if (
            r.coordinator.watchId &&
            a.coordinator.watchId !== r.coordinator.watchId
          )
            throw new Error('Watch identity immutable');
          r.coordinator = a.coordinator;
          break;
        case 'bind-commit': {
          available(r);
          if (a.treeSha !== r.revision.treeSha)
            throw new Error('Commit changed authorized candidate content');
          if (
            !r.effects.some(
              (x) =>
                x.kind === 'commit' &&
                x.state === 'in-flight' &&
                sameDeliveryRevision(x.revision, r.revision),
            )
          )
            throw new Error('Commit reservation required');
          r.commits.push({
            revision: r.revision,
            publishedHeadSha: a.publishedHeadSha,
            treeSha: a.treeSha,
            evidenceRef: a.evidenceRef,
          });
          break;
        }
        case 'record-evidence': {
          available(r);
          if (!sameDeliveryRevision(a.evidence.revision, r.revision))
            throw new Error('Stale evidence revision');
          if (
            [r.revision.runId, r.revision.attemptId].includes(
              a.evidence.producerId,
            )
          )
            throw new Error('Independent evidence required');
          const prior = r.evidence.find((e) => e.id === a.evidence.id);
          if (prior) {
            if (!isDeepStrictEqual(prior, a.evidence))
              throw new Error('Conflicting evidence replay');
            return r;
          }
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
          if (a.executionMs > repair.reservedExecutionMs)
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
            return r;
          }
          if (unresolvedEffects(r))
            throw new Error('External operation unresolved');
          if (
            r.effects.some(
              (x) =>
                x.kind === a.kind &&
                sameDeliveryRevision(x.revision, r.revision),
            )
          )
            throw new Error('Effect already planned for revision');
          if (['verification', 'review'].includes(a.kind) && !a.maxExecutionMs)
            throw new Error('Verification execution reservation required');
          if (
            !['verification', 'review'].includes(a.kind) &&
            a.maxExecutionMs !== undefined
          )
            throw new Error('Unexpected execution reservation');
          if (
            spentExecution(r) + (a.maxExecutionMs ?? 0) >
            r.authorization.totalExecutionMs
          )
            throw new Error('Execution budget exhausted');
          if (a.kind === 'create-pr' && r.pr)
            throw new Error('PR already bound');
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
          if (['verification', 'review'].includes(effect.kind) && delivered) {
            if (a.executionMs === undefined)
              throw new Error('Verification execution accounting required');
            effect.executionMs = a.executionMs;
            if (a.executionMs > (effect.reservedExecutionMs ?? 0))
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
            return r;
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
      return save(db, r);
    }),
  );
}

/** Includes terminal retained ownership, preventing legacy writers from adopting the PR. */
export function isFactoryOwnedWatch(watchId: unknown, paths: Paths): boolean {
  const id = v.parse(label, watchId);
  return database(paths, (db) => {
    const row = db
      .prepare(
        'SELECT d.* FROM factory_delivery_pipelines d JOIN pr_watches w ON w.repo_id=d.repo_id AND w.pr_number=d.pr_number WHERE w.id=?',
      )
      .get(id);
    if (!row) return false;
    decode(row);
    return true;
  });
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
