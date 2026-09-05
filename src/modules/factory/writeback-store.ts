import * as v from 'valibot';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  writebackRepairSchema,
  writebackPolicySchema,
  writebackEffectSchema,
  writebackStatusSchema,
  publicApprovalSchema,
  writebackApprovalSchema,
  publicStatusBody,
  type WritebackEffect,
} from '../../../shared/factory-writeback';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { dbRun, detail, FactoryError, type FactoryActor } from './service';
import {
  connectionFingerprint,
  factoryConnections,
  readyConnection,
} from './github-config';
import { githubDigest } from './github-store';
export const schemas = {
  policy: writebackPolicySchema,
  effect: writebackEffectSchema,
  status: writebackStatusSchema,
  approval: publicApprovalSchema,
  repair: writebackRepairSchema,
};
export function rows<K extends keyof typeof schemas>(
  db: DatabaseSync,
  kind: K,
): v.InferOutput<(typeof schemas)[K]>[] {
  return db
    .prepare(
      'SELECT record FROM factory_writeback_records WHERE kind=? ORDER BY rowid',
    )
    .all(kind)
    .map(
      (row) =>
        v.parse(schemas[kind], JSON.parse(String(row.record))) as v.InferOutput<
          (typeof schemas)[K]
        >,
    );
}
export function put<K extends keyof typeof schemas>(
  db: DatabaseSync,
  kind: K,
  value: v.InferOutput<(typeof schemas)[K]>,
) {
  const record = v.parse(schemas[kind], value);
  db.prepare(
    'INSERT INTO factory_writeback_records(id,kind,work_id,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record',
  ).run(
    record.id,
    kind,
    'workId' in record ? record.workId : null,
    JSON.stringify(record),
  );
}
export function policy(db: DatabaseSync, connectionId: string) {
  return (
    rows(db, 'policy').find((p) => p.id === `policy:${connectionId}`) ?? {
      id: `policy:${connectionId}`,
      enabled: false,
      epoch: '',
      connectionFingerprint: '',
      actor: '',
      approvedAt: '',
    }
  );
}
export function invalidateWriteback(db: DatabaseSync, connectionId: string) {
  const p = policy(db, connectionId);
  put(db, 'policy', { ...p, enabled: false, epoch: randomUUID() });
  for (const e of rows(db, 'effect').filter(
    (e) =>
      e.connectionId === connectionId &&
      ['pending', 'failed'].includes(e.state),
  ))
    put(db, 'effect', {
      ...e,
      state: e.kind === 'status' && e.approvalId ? 'repair' : 'cancelled',
      error: 'Writeback authorization was revoked. Review and approve again.',
    });
}
export function setWritebackPolicy(
  connectionId: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  if (actor.kind !== 'human')
    throw new FactoryError(403, 'Human consent required.');
  const value = v.parse(
    v.strictObject({
      enabled: v.boolean(),
      expectedEpoch: v.string(),
      expectedFingerprint: v.string(),
    }),
    input,
  );
  return dbRun(paths, (db) => {
    const connection = factoryConnections(paths).find(
      (c) => c.id === connectionId,
    );
    if (!connection) throw new FactoryError(404, 'Connection not found.');
    const old = policy(db, connectionId);
    if (
      old.epoch !== value.expectedEpoch ||
      connectionFingerprint(connection) !== value.expectedFingerprint
    )
      throw new FactoryError(
        409,
        'Writeback setup changed. Review current policy before saving.',
      );
    if (value.enabled) readyConnection(connectionId, paths);
    invalidateWriteback(db, connectionId);
    const next = {
      ...old,
      enabled: value.enabled,
      epoch: randomUUID(),
      connectionFingerprint: connectionFingerprint(connection),
      actor: actor.id,
      approvedAt: new Date().toISOString(),
    };
    put(db, 'policy', next);
    return next;
  });
}
export function context(
  db: DatabaseSync,
  workId: string,
  paths: RuntimePaths,
  requireConsent = true,
) {
  const d = detail(db, workId, paths),
    remote = d.source.remote;
  if (!remote) throw new FactoryError(409, 'This task has no GitHub source.');
  const connection = requireConsent
    ? readyConnection(remote.connectionId, paths)
    : factoryConnections(paths).find((c) => c.id === remote.connectionId);
  if (
    !connection ||
    connection.repositoryId !== remote.repositoryId ||
    connection.repoId !== d.work.repoId
  )
    throw new FactoryError(409, 'Restore the admitted source mapping.');
  const p = policy(db, connection.id);
  if (
    requireConsent &&
    (!p.enabled ||
      p.connectionFingerprint !== connectionFingerprint(connection))
  )
    throw new FactoryError(
      403,
      'GitHub writeback is off. Enable its explicit policy first.',
    );
  return { d, remote, connection, p };
}
export function stateInDb(
  db: DatabaseSync,
  workId: string,
  paths: RuntimePaths,
) {
  const { d, connection, remote, p } = context(db, workId, paths, false);
  const approvals = rows(db, 'approval').filter((a) => a.workId === workId);
  const approved = approvals
    .filter(
      (a) =>
        a.kind === 'summary' &&
        a.specVersion === d.work.specVersion &&
        a.specHash === d.revisions.at(-1)!.hash &&
        a.sourceVersion === d.source.version &&
        a.repoFingerprint === d.repoFingerprint &&
        d.revisions.at(-1)!.repoFingerprint === d.repoFingerprint &&
        a.epoch === p.epoch,
    )
    .at(-1);
  return {
    policy: p,
    connectionFingerprint: connectionFingerprint(connection),
    target: remote.url,
    template: publicStatusBody(
      (d.work.lifecycle === 'queued' && !d.eligible) ||
        d.revisions.at(-1)!.repoFingerprint !== d.repoFingerprint
        ? 'review'
        : d.work.lifecycle,
      approved?.body,
    ),
    approvals,
    effects: rows(db, 'effect').filter((e) => e.workId === workId),
    status: rows(db, 'status').find((s) => s.workId === workId) ?? null,
  };
}
export const getWritebackState = (workId: string, paths = runtimePaths()) =>
  dbRun(paths, (db) => stateInDb(db, workId, paths));
export function makeEffect(
  db: DatabaseSync,
  workId: string,
  kind: 'status' | 'question',
  body: string,
  marker: string,
  approvalId: string | null,
  paths: RuntimePaths,
): WritebackEffect {
  const { d, remote, connection, p } = context(db, workId, paths);
  return {
    id: randomUUID(),
    workId,
    connectionId: connection.id,
    issueId: remote.issueId,
    number: remote.number,
    connectionFingerprint: connectionFingerprint(connection),
    epoch: p.epoch,
    kind,
    body,
    bodyHash: githubDigest(body),
    marker,
    specVersion: d.work.specVersion,
    sourceVersion: d.source.version,
    workVersion: d.work.version,
    approvalId,
    repoFingerprint: d.repoFingerprint,
    scanPage: 1,
    scanMatches: [],
    state: 'pending',
    remoteId: null,
    author: null,
    authorId: null,
    confirmedBody: null,
    confirmedUpdatedAt: null,
    error: null,
    attempts: 0,
    retryAt: 0,
    createdAt: new Date().toISOString(),
  };
}
export function approveWriteback(
  workId: string,
  input: unknown,
  actor: FactoryActor,
  paths = runtimePaths(),
) {
  if (actor.kind !== 'human')
    throw new FactoryError(403, 'Human approval required.');
  const value = v.parse(writebackApprovalSchema, input);
  return dbRun(paths, (db) => {
    const old = rows(db, 'approval').find(
      (a) => a.workId === workId && a.requestKey === value.requestKey,
    );
    if (old) {
      if (
        githubDigest(
          v.parse(v.object(writebackApprovalSchema.entries), old),
        ) !== githubDigest(value)
      )
        throw new FactoryError(
          409,
          'Approval request key was used for different content.',
        );
      return old;
    }
    const { d, remote, p } = context(db, workId, paths);
    const rev = d.revisions.at(-1)!;
    if (
      rev.repoFingerprint !== d.repoFingerprint ||
      value.expectedVersion !== d.work.version ||
      value.specVersion !== rev.version ||
      value.specHash !== rev.hash ||
      value.sourceVersion !== d.source.version ||
      value.issueId !== remote.issueId
    )
      throw new FactoryError(
        409,
        'Task or source changed. Review the exact text and current version again.',
      );
    if (
      value.decisionId &&
      !rev.spec.decisions.some((x) => x.id === value.decisionId)
    )
      throw new FactoryError(409, 'Decision does not belong to this revision.');
    const approval = {
      ...value,
      id: randomUUID(),
      workId,
      repoFingerprint: d.repoFingerprint,
      bodyHash: githubDigest(value.body),
      actor: actor.id,
      approvedAt: new Date().toISOString(),
      epoch: p.epoch,
    };
    put(db, 'approval', approval);
    if (value.kind === 'question') {
      const marker = `<!-- neon-factory-question:${randomUUID()} -->`;
      put(
        db,
        'effect',
        makeEffect(
          db,
          workId,
          'question',
          `${value.body}\n\n${marker}`,
          marker,
          approval.id,
          paths,
        ),
      );
    }
    return approval;
  });
}
/** Coalesce only work not dispatched. Never alter a dispatched payload. */
export function queueStatus(
  db: DatabaseSync,
  workId: string,
  paths: RuntimePaths,
) {
  const view = stateInDb(db, workId, paths);
  context(db, workId, paths);
  let status = view.status;
  if (!status) {
    status = {
      id: `status:${workId}`,
      workId,
      marker: `<!-- neon-factory-status:${randomUUID()} -->`,
      remoteId: null,
      author: null,
      authorId: null,
      confirmedBody: null,
      confirmedUpdatedAt: null,
      relinquished: false,
      repairRequired: false,
    };
    put(db, 'status', status);
  }
  const pendingRepair = view.effects.find(
    (e) => e.kind === 'status' && e.state === 'pending' && e.approvalId,
  );
  if (pendingRepair) {
    try {
      effectAuthorized(db, pendingRepair, paths);
      if (pendingRepair.body !== `${view.template}\n\n${pendingRepair.marker}`)
        throw new FactoryError(
          409,
          'The reviewed repair replacement changed. Review a new repair preview.',
        );
    } catch (error) {
      if (!(error instanceof FactoryError)) throw error;
      put(db, 'effect', {
        ...pendingRepair,
        state: 'repair',
        error:
          'Repair authorization or task changed. Review a new exact repair preview.',
      });
    }
    return;
  }
  if (
    status.relinquished ||
    status.repairRequired ||
    view.effects.some(
      (e) =>
        e.kind === 'status' &&
        ['sending', 'uncertain', 'repair', 'failed'].includes(e.state),
    )
  )
    return;
  const body = `${view.template}\n\n${status.marker}`;
  const pending = view.effects.filter(
    (e) => e.kind === 'status' && e.state === 'pending',
  );
  if (
    pending.length === 1 &&
    pending[0].body === body &&
    pending[0].epoch === view.policy.epoch &&
    pending[0].workVersion === context(db, workId, paths).d.work.version
  )
    return;
  for (const e of pending)
    put(db, 'effect', {
      ...e,
      state: 'cancelled',
      error: 'Superseded by current status.',
    });
  if (status.confirmedBody === body) return;
  const e = makeEffect(db, workId, 'status', body, status.marker, null, paths);
  e.remoteId = status.remoteId;
  e.author = status.author;
  e.authorId = status.authorId;
  e.confirmedBody = status.confirmedBody;
  e.confirmedUpdatedAt = status.confirmedUpdatedAt;
  put(db, 'effect', e);
}
export function effectAuthorized(
  db: DatabaseSync,
  e: WritebackEffect,
  paths: RuntimePaths,
) {
  const { d, remote, connection, p } = context(db, e.workId, paths);
  if (
    p.epoch !== e.epoch ||
    connectionFingerprint(connection) !== e.connectionFingerprint ||
    remote.issueId !== e.issueId ||
    remote.number !== e.number ||
    d.work.version !== e.workVersion ||
    d.source.version !== e.sourceVersion ||
    d.work.specVersion !== e.specVersion ||
    d.repoFingerprint !== e.repoFingerprint
  )
    throw new FactoryError(
      409,
      'Authorization or task changed before dispatch. Review again.',
    );
  return connection;
}
