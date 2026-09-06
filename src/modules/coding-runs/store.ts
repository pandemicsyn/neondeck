import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import type { RuntimePaths } from '../../runtime-home';
import {
  codingLabelSchema,
  codingTimeSchema,
  sameCodingHostIdentity,
  codingRunCommandSchema,
  codingRunEventSchema,
  codingRunPageSchema,
  codingRunListSchema,
  codingRunRecordSchema,
  codingRunSnapshotSchema,
  type CodingRunRecord,
} from '../../../shared/coding-runs';
import { codingRunRowSchema } from './schemas';

type Paths = Pick<RuntimePaths, 'neondeckDatabase'>;
const terminal = (r: CodingRunRecord) =>
  ['candidate', 'failed', 'cancelled'].includes(r.status);
function db<T>(paths: Paths, operation: (database: DatabaseSync) => T): T {
  const path = v.parse(
    v.pipe(v.string(), v.minLength(1)),
    paths.neondeckDatabase,
  );
  const database = openDb(path);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
function decode(row: unknown) {
  const stored = v.parse(codingRunRowSchema, row);
  const record = v.parse(codingRunRecordSchema, JSON.parse(stored.record_json));
  if (
    stored.run_id !== record.runId ||
    stored.attempt_id !== record.attemptId ||
    stored.worktree_id !== (record.workspace?.worktreeId ?? null) ||
    stored.request_id !== record.snapshot.requestId ||
    stored.work_item_id !== record.snapshot.workItemId ||
    stored.release_id !== record.snapshot.releaseId ||
    (stored.writer_slot === null) !== terminal(record)
  )
    throw new Error('Corrupt coding run identity');
  return { sequence: stored.sequence, record };
}
function get(database: DatabaseSync, id: string) {
  const row = database
    .prepare('SELECT * FROM coding_runs WHERE run_id = ?')
    .get(id);
  return row ? decode(row).record : null;
}
function event(database: DatabaseSync, record: CodingRunRecord, type: string) {
  database
    .prepare(
      'INSERT INTO coding_run_events (run_id, version, type, status, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(record.runId, record.version, type, record.status, record.updatedAt);
}
/** Caller must validate current admission authority before reservation. No resources are created here. */
export function reserveCodingRun(
  input: unknown,
  paths: Paths,
): CodingRunRecord {
  const snapshot = v.parse(codingRunSnapshotSchema, input);
  return db(paths, (database) =>
    withImmediateTransaction(database, () => {
      const existing = database
        .prepare(
          'SELECT * FROM coding_runs WHERE request_id = ? OR release_id = ?',
        )
        .all(snapshot.requestId, snapshot.releaseId);
      if (existing.length) {
        const record = decode(existing[0]).record;
        if (
          existing.length !== 1 ||
          !isDeepStrictEqual(record.snapshot, snapshot)
        )
          throw new Error('Conflicting coding run replay');
        return record;
      }
      if (
        database
          .prepare('SELECT run_id FROM coding_runs WHERE writer_slot = 1')
          .get()
      )
        throw new Error('Coding writer already reserved');
      const now = new Date().toISOString();
      const record = v.parse(codingRunRecordSchema, {
        runId: randomUUID(),
        attemptId: randomUUID(),
        ownershipToken: randomUUID(),
        version: 1,
        snapshot,
        status: 'reserved',
        host: null,
        workspace: null,
        providerSessionId: null,
        cancelRequestedAt: null,
        cancelReason: null,
        reason: null,
        deadProof: null,
        candidate: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        cleanupAttentionAt: null,
        evidenceRetainUntil: null,
      });
      database
        .prepare(
          'INSERT INTO coding_runs (run_id, attempt_id, request_id, release_id, work_item_id, writer_slot, record_json) VALUES (?, ?, ?, ?, ?, 1, ?)',
        )
        .run(
          record.runId,
          record.attemptId,
          snapshot.requestId,
          snapshot.releaseId,
          snapshot.workItemId,
          JSON.stringify(record),
        );
      event(database, record, 'reserved');
      return record;
    }),
  );
}
export function getCodingRun(runId: unknown, paths: Paths) {
  const id = v.parse(codingLabelSchema, runId);
  return db(paths, (database) => get(database, id));
}
export function listCodingRuns(input: unknown, paths: Paths) {
  const page = v.parse(codingRunListSchema, input);
  return db(paths, (database) => {
    const rows =
      page.workItemId === undefined
        ? database
            .prepare(
              'SELECT * FROM coding_runs WHERE sequence > ? ORDER BY sequence LIMIT ?',
            )
            .all(page.after, page.limit)
        : database
            .prepare(
              'SELECT * FROM coding_runs WHERE work_item_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
            )
            .all(page.workItemId, page.after, page.limit);
    return rows.map(decode);
  });
}
export function listCodingRunEvents(
  runId: unknown,
  input: unknown,
  paths: Paths,
) {
  const id = v.parse(codingLabelSchema, runId);
  const page = v.parse(codingRunPageSchema, input);
  return db(paths, (database) =>
    database
      .prepare(
        'SELECT sequence, run_id AS runId, version, type, status, created_at AS createdAt FROM coding_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
      )
      .all(id, page.after, page.limit)
      .map((row) => v.parse(codingRunEventSchema, row)),
  );
}
function assertWorkspaceOwnership(
  database: DatabaseSync,
  record: CodingRunRecord,
  identity: NonNullable<CodingRunRecord['workspace']>,
) {
  const workspace = v.safeParse(
    v.object({
      repo_id: v.string(),
      owning_workflow_run_id: v.nullable(v.string()),
      adopted: v.literal(0),
      lifecycle_status: v.picklist(['creating', 'ready', 'busy']),
      storage_kind: v.picklist(['home', 'repo-local']),
    }),
    database
      .prepare('SELECT * FROM worktrees WHERE id = ?')
      .get(identity.worktreeId),
  );
  const lock = v.safeParse(
    v.object({
      scope: v.literal('worktree'),
      scope_key: v.string(),
      worktree_id: v.string(),
      workflow_run_id: v.string(),
      repo_id: v.string(),
      expires_at: codingTimeSchema,
      released_at: v.null(),
      revoked_at: v.null(),
    }),
    database
      .prepare('SELECT * FROM worktree_locks WHERE id = ?')
      .get(identity.lockId),
  );
  if (!workspace.success || !lock.success)
    throw new Error('Workspace ownership mismatch');
  if (
    Date.parse(lock.output.expires_at) <= Date.now() ||
    workspace.output.repo_id !== record.snapshot.repoId ||
    workspace.output.owning_workflow_run_id !== record.runId ||
    lock.output.scope_key !== `worktree:${identity.worktreeId}` ||
    lock.output.worktree_id !== identity.worktreeId ||
    lock.output.workflow_run_id !== record.runId ||
    lock.output.repo_id !== record.snapshot.repoId
  )
    throw new Error('Workspace ownership mismatch');
}

/** Host observations are trusted only after host-side receipt/process/path validation.
 * A proof is an attestation from that boundary, never model output or a lease timeout.
 */
export function updateCodingRun(input: unknown, paths: Paths): CodingRunRecord {
  const command = v.parse(codingRunCommandSchema, input);
  return db(paths, (database) =>
    withImmediateTransaction(database, () => {
      const record = get(database, command.runId);
      if (
        !record ||
        record.attemptId !== command.attemptId ||
        record.ownershipToken !== command.ownershipToken ||
        record.version !== command.expectedVersion
      )
        throw new Error('Coding run ownership/version conflict');
      if (terminal(record)) throw new Error('Coding run is terminal');
      const action = command.action;
      const now = new Date().toISOString();
      switch (action.type) {
        case 'bind-host':
          if (
            record.host ||
            record.status !== 'reserved' ||
            record.cancelRequestedAt
          )
            throw new Error('Host identity already bound or launch fenced');
          record.host = action.host;
          break;
        case 'bind-workspace': {
          if (
            record.workspace ||
            record.status !== 'reserved' ||
            record.cancelRequestedAt
          )
            throw new Error('Workspace already bound or launch fenced');
          assertWorkspaceOwnership(database, record, action.workspace);
          record.workspace = action.workspace;
          break;
        }
        case 'bind-session':
          if (record.providerSessionId || !record.host)
            throw new Error('Session identity already bound or host absent');
          record.providerSessionId = action.providerSessionId;
          break;
        case 'running':
          if (
            record.status !== 'reserved' ||
            !record.host ||
            !record.workspace ||
            record.cancelRequestedAt
          )
            throw new Error('Run cannot start');
          assertWorkspaceOwnership(database, record, record.workspace);
          record.status = 'running';
          break;
        case 'collecting':
          if (record.status !== 'running')
            throw new Error('Run cannot collect');
          record.status = 'collecting';
          break;
        case 'quarantine':
          record.status = 'needs-reconcile';
          record.reason = action.reason;
          break;
        case 'cancel':
          record.cancelRequestedAt ??= now;
          record.cancelReason ??= action.reason;
          break;
        case 'finish': {
          const proof = action.proof;
          if (
            proof.runId !== record.runId ||
            proof.attemptId !== record.attemptId ||
            proof.ownershipToken !== record.ownershipToken ||
            !sameCodingHostIdentity(proof.host, record.host)
          )
            throw new Error('Terminal identity mismatch');
          if ((proof.kind === 'never-started') !== (record.host === null))
            throw new Error('Compute death not established');
          if (action.status === 'candidate') {
            if (
              !record.workspace ||
              !record.providerSessionId ||
              !action.candidate ||
              record.cancelRequestedAt ||
              !['collecting', 'needs-reconcile'].includes(record.status) ||
              action.candidate.baseSha !== record.snapshot.baseSha ||
              action.candidate.worktreeId !== record.workspace.worktreeId
            )
              throw new Error('Candidate evidence mismatch');
            assertWorkspaceOwnership(database, record, record.workspace);
            record.candidate = action.candidate;
          } else if (action.candidate)
            throw new Error('Noncandidate cannot include candidate evidence');
          if (action.status === 'cancelled' && !record.cancelRequestedAt)
            throw new Error('Missing cancellation intent');
          record.status = action.status;
          record.deadProof = proof;
          record.reason = action.reason;
          record.completedAt = now;
          record.cleanupAttentionAt = new Date(
            Date.parse(now) + 7 * 86400000,
          ).toISOString();
          record.evidenceRetainUntil = new Date(
            Date.parse(now) + 30 * 86400000,
          ).toISOString();
          break;
        }
      }
      record.version++;
      record.updatedAt = now;
      const validated = v.parse(codingRunRecordSchema, record);
      database
        .prepare(
          'UPDATE coding_runs SET record_json = ?, writer_slot = ?, worktree_id = ? WHERE run_id = ?',
        )
        .run(
          JSON.stringify(validated),
          terminal(validated) ? null : 1,
          validated.workspace?.worktreeId ?? null,
          record.runId,
        );
      event(database, validated, action.type);
      return validated;
    }),
  );
}

/** Retained records protect even terminal unpublished work; dates are attention metadata, not deletion authority. */
export function getCodingRunForWorktree(worktreeId: unknown, paths: Paths) {
  const id = v.parse(codingLabelSchema, worktreeId);
  return db(paths, (database) => {
    const row = database
      .prepare('SELECT * FROM coding_runs WHERE worktree_id = ?')
      .get(id);
    return row ? decode(row).record : null;
  });
}
