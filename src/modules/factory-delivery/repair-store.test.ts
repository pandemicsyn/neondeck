import { getActiveCodingRun, getCodingRunForRelease } from '../coding-runs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { openDb, withImmediateTransaction } from '../../lib/sqlite';
import {
  reserveCodingRun,
  reserveRepairCodingRunInTransaction,
  updateCodingRun,
  getCodingRun,
  listCodingRuns,
} from '../coding-runs';
import type {
  CodingRunCommand,
  CodingRunRecord,
  CodingRunSnapshot,
} from '../../../shared/coding-runs';

const snapshot: CodingRunSnapshot = {
  requestId: 'request',
  workItemId: 'work',
  releaseId: 'release',
  specVersion: 1,
  specHash: 'a'.repeat(64),
  specSnapshot: '{"outcome":"test"}',
  sourceId: 'issue',
  sourceSnapshot: '{}',
  repoId: 'repo',
  repoSnapshot: '{}',
  policySnapshot: '{}',
  contextSnapshot: '{}',
  baseSha: 'b'.repeat(40),
  harness: { provider: 'test', version: '1', model: 'test-model' },
  sessionMode: 'fresh',
};
function guard(r: CodingRunRecord) {
  return {
    runId: r.runId,
    attemptId: r.attemptId,
    ownershipToken: r.ownershipToken,
    expectedVersion: r.version,
  };
}
function proof(r: CodingRunRecord) {
  return {
    runId: r.runId,
    attemptId: r.attemptId,
    ownershipToken: r.ownershipToken,
    host: r.host,
    kind: r.host ? ('verified-dead' as const) : ('never-started' as const),
    evidenceRef: 'receipt',
  };
}
let home: string;
let paths: { neondeckDatabase: string };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'coding-runs-'));
  paths = { neondeckDatabase: join(home, 'app.db') };
  initializeAppDatabase(paths.neondeckDatabase);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function update(r: CodingRunRecord, action: CodingRunCommand['action']) {
  return updateCodingRun({ ...guard(r), action }, paths);
}
function createWorkspace(r: CodingRunRecord) {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      `INSERT INTO worktrees (id,repo_id,repo_full_name,github_owner,github_name,base_ref,head_ref,local_path,storage_kind,owning_workflow_run_id,lifecycle_status,adopted,created_by,created_at,updated_at) VALUES ('wt','repo','a/b','a','b','main','agent/factory-test','/tmp/test','home',?,'ready',0,'factory',?,?)`,
    ).run(r.runId, r.createdAt, r.createdAt);
    db.prepare(
      `INSERT INTO worktree_locks (id,scope,scope_key,worktree_id,repo_id,owner,workflow_run_id,expires_at,created_at,updated_at) VALUES ('lock','worktree','worktree:wt','wt','repo','factory',?,'2099-01-01T00:00:00.000Z',?,?)`,
    ).run(r.runId, r.createdAt, r.createdAt);
  } finally {
    db.close();
  }
}
function workspace(r: CodingRunRecord) {
  createWorkspace(r);
  return update(r, {
    type: 'bind-workspace',
    workspace: { worktreeId: 'wt', lockId: 'lock' },
  });
}

function candidate() {
  let run = reserveCodingRun(snapshot, paths);
  run = update(run, {
    type: 'bind-host',
    host: { hostId: 'test', jobId: 'job' },
  });
  run = workspace(run);
  run = update(run, { type: 'running' });
  run = update(run, {
    type: 'bind-session',
    providerSessionId: 'initial-session',
  });
  run = update(run, { type: 'collecting' });
  return update(run, {
    type: 'finish',
    status: 'candidate',
    proof: proof(run),
    candidate: {
      baseSha: snapshot.baseSha,
      headSha: snapshot.baseSha,
      worktreeId: 'wt',
      statusRef: 'status',
      diffRef: 'diff',
      includesUntracked: true,
    },
    reason: 'Retained',
  });
}
function reserve(parentRunId: string, requestId = 'repair') {
  const database = openDb(paths.neondeckDatabase);
  try {
    return withImmediateTransaction(database, () =>
      reserveRepairCodingRunInTransaction(database, {
        parentRunId,
        requestId,
        maxWallTimeMs: 1000,
      }),
    );
  } finally {
    database.close();
  }
}
describe('repair coding reservation', () => {
  it('reserves once with fresh identities and exactly the immutable parent context', () => {
    const parent = candidate();
    const repair = reserve(parent.runId);
    expect(repair.snapshot).toEqual({
      ...parent.snapshot,
      requestId: 'repair',
    });
    expect(repair.runId).not.toBe(parent.runId);
    expect(repair.attemptId).not.toBe(parent.attemptId);
    expect(repair.ownershipToken).not.toBe(parent.ownershipToken);
    expect(repair.providerSessionId).toBeNull();
    expect(reserve(parent.runId)).toEqual(repair);
    expect(getCodingRun(parent.runId, paths)).toEqual(parent);
    expect(getCodingRunForRelease(snapshot.releaseId, paths)).toEqual(parent);
    expect(reserveCodingRun(snapshot, paths)).toEqual(parent);
    expect(listCodingRuns({}, paths)).toHaveLength(2);
    expect(getActiveCodingRun(paths)).toEqual(repair);
    expect(() => reserve(parent.runId, 'another')).toThrow('writer');
  });
  it('rolls back writer insertion with an unsuccessful budget transaction', () => {
    const parent = candidate();
    const database = openDb(paths.neondeckDatabase);
    try {
      expect(() =>
        withImmediateTransaction(database, () => {
          reserveRepairCodingRunInTransaction(database, {
            parentRunId: parent.runId,
            requestId: 'repair',
            maxWallTimeMs: 1000,
          });
          throw new Error('Budget mutation rejected');
        }),
      ).toThrow('Budget');
    } finally {
      database.close();
    }
    expect(listCodingRuns({}, paths)).toHaveLength(1);
    expect(getActiveCodingRun(paths)).toBeNull();
  });
  it('rejects noncandidate, missing transaction and oversized attempt budgets', () => {
    const initial = reserveCodingRun(snapshot, paths);
    expect(() => reserve(initial.runId)).toThrow('retained terminal candidate');
    const database = openDb(paths.neondeckDatabase);
    try {
      expect(() =>
        reserveRepairCodingRunInTransaction(database, {
          parentRunId: initial.runId,
          requestId: 'r',
          maxWallTimeMs: 1000,
        }),
      ).toThrow('transaction');
      expect(() =>
        withImmediateTransaction(database, () =>
          reserveRepairCodingRunInTransaction(database, {
            parentRunId: initial.runId,
            requestId: 'r',
            maxWallTimeMs: 2700001,
          }),
        ),
      ).toThrow(/Invalid/);
    } finally {
      database.close();
    }
  });
});
