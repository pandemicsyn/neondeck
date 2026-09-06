import { getActiveCodingRun, getCodingRunForRelease } from './queries';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ValiError } from 'valibot';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { openDb } from '../../lib/sqlite';
import {
  reserveCodingRun,
  updateCodingRun,
  getCodingRun,
  listCodingRuns,
  listCodingRunEvents,
  getCodingRunForWorktree,
} from './store';
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

describe('durable coding runs', () => {
  it.each([
    [
      'expired lock',
      "UPDATE worktree_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 'lock'",
    ],
    [
      'invalid expiry',
      "UPDATE worktree_locks SET expires_at = 'invalid' WHERE id = 'lock'",
    ],
    ['wrong scope', "UPDATE worktree_locks SET scope = 'pr' WHERE id = 'lock'"],
    [
      'wrong scope key',
      "UPDATE worktree_locks SET scope_key = 'wt' WHERE id = 'lock'",
    ],
    [
      'stolen workspace owner',
      "UPDATE worktrees SET owning_workflow_run_id = 'other' WHERE id = 'wt'",
    ],
    [
      'stolen lock owner',
      "UPDATE worktree_locks SET workflow_run_id = 'other' WHERE id = 'lock'",
    ],
  ])('rejects initial binding with %s', (_label, mutation) => {
    const r = reserveCodingRun(snapshot, paths);
    createWorkspace(r);
    const database = openDb(paths.neondeckDatabase);
    try {
      database.exec(mutation);
    } finally {
      database.close();
    }
    expect(() =>
      update(r, {
        type: 'bind-workspace',
        workspace: { worktreeId: 'wt', lockId: 'lock' },
      }),
    ).toThrow('Workspace ownership mismatch');
    expect(getCodingRun(r.runId, paths)).toEqual(r);
    expect(getCodingRunForWorktree('wt', paths)).toBeNull();
    expect(listCodingRunEvents(r.runId, {}, paths)).toHaveLength(1);
  });
  it.each([
    [
      'expired lock',
      "UPDATE worktree_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 'lock'",
    ],
    [
      'released lock',
      "UPDATE worktree_locks SET released_at = '2026-09-06T00:00:00.000Z' WHERE id = 'lock'",
    ],
    [
      'revoked lock',
      "UPDATE worktree_locks SET revoked_at = '2026-09-06T00:00:00.000Z' WHERE id = 'lock'",
    ],
    [
      'reclaimed lock',
      "UPDATE worktree_locks SET workflow_run_id = 'other' WHERE id = 'lock'",
    ],
    [
      'stolen workspace',
      "UPDATE worktrees SET owning_workflow_run_id = 'other' WHERE id = 'wt'",
    ],
    [
      'changed lock scope',
      "UPDATE worktree_locks SET scope = 'pr' WHERE id = 'lock'",
    ],
    [
      'changed lock key',
      "UPDATE worktree_locks SET scope_key = 'wrong' WHERE id = 'lock'",
    ],
  ])(
    'rejects running after %s without changing run version or releasing writer',
    (_label, mutation) => {
      let r = workspace(reserveCodingRun(snapshot, paths));
      r = update(r, {
        type: 'bind-host',
        host: { hostId: 'local', jobId: 'job' },
      });
      const database = openDb(paths.neondeckDatabase);
      try {
        database.exec(mutation);
      } finally {
        database.close();
      }
      expect(() => update(r, { type: 'running' })).toThrow(
        'Workspace ownership mismatch',
      );
      expect(getCodingRun(r.runId, paths)).toEqual(r);
      expect(listCodingRunEvents(r.runId, {}, paths)).toHaveLength(3);
      expect(() =>
        reserveCodingRun(
          { ...snapshot, requestId: 'other', releaseId: 'other' },
          paths,
        ),
      ).toThrow('Coding writer already reserved');
    },
  );
  it.each([
    [
      'released',
      "UPDATE worktree_locks SET released_at = '2026-09-06T00:00:00.000Z' WHERE id = 'lock'",
    ],
    [
      'revoked',
      "UPDATE worktree_locks SET revoked_at = '2026-09-06T00:00:00.000Z' WHERE id = 'lock'",
    ],
    [
      'expired',
      "UPDATE worktree_locks SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 'lock'",
    ],
    [
      'reclaimed',
      "UPDATE worktree_locks SET workflow_run_id = 'other-run' WHERE id = 'lock'",
    ],
    [
      'wrong workspace owner',
      "UPDATE worktrees SET owning_workflow_run_id = 'other-run' WHERE id = 'wt'",
    ],
  ])(
    'rejects candidate with %s ownership and retains writer/evidence',
    (_label, mutation) => {
      let r = workspace(reserveCodingRun(snapshot, paths));
      r = update(r, {
        type: 'bind-host',
        host: { hostId: 'local', jobId: 'job' },
      });
      r = update(r, { type: 'running' });
      r = update(r, { type: 'bind-session', providerSessionId: 'session' });
      r = update(r, { type: 'collecting' });
      const events = listCodingRunEvents(r.runId, {}, paths);
      const database = openDb(paths.neondeckDatabase);
      try {
        database.exec(mutation);
      } finally {
        database.close();
      }
      expect(() =>
        update(r, {
          type: 'finish',
          status: 'candidate',
          proof: proof(r),
          reason: 'candidate',
          candidate: {
            baseSha: r.snapshot.baseSha,
            headSha: 'c'.repeat(40),
            worktreeId: 'wt',
            statusRef: 'status',
            diffRef: 'diff',
            includesUntracked: true,
          },
        }),
      ).toThrow('Workspace ownership mismatch');
      expect(getCodingRun(r.runId, paths)).toEqual(r);
      expect(getCodingRunForWorktree('wt', paths)).toEqual(r);
      expect(listCodingRunEvents(r.runId, {}, paths)).toEqual(events);
      expect(() =>
        reserveCodingRun(
          { ...snapshot, requestId: 'other', releaseId: 'other' },
          paths,
        ),
      ).toThrow('Coding writer already reserved');
      const quarantined = update(r, {
        type: 'quarantine',
        reason: 'ownership lost',
      });
      expect(quarantined.status).toBe('needs-reconcile');
      expect(() =>
        reserveCodingRun(
          { ...snapshot, requestId: 'other', releaseId: 'other' },
          paths,
        ),
      ).toThrow('Coding writer already reserved');
    },
  );
  it('accepts reordered identity keys but keeps opaque snapshot bytes exact', () => {
    const input = { ...snapshot, contextSnapshot: '{"a":1,"b":2}' };
    const r = reserveCodingRun(input, paths);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    reordered.harness = {
      model: input.harness.model,
      version: input.harness.version,
      provider: input.harness.provider,
    };
    expect(reserveCodingRun(reordered, paths)).toEqual(r);
    expect(() =>
      reserveCodingRun({ ...input, contextSnapshot: '{"b":2,"a":1}' }, paths),
    ).toThrow('Conflicting coding run replay');
    const host = update(r, {
      type: 'bind-host',
      host: { hostId: 'local', jobId: 'job' },
    });
    const done = update(host, {
      type: 'finish',
      status: 'failed',
      reason: 'stopped',
      proof: { ...proof(host), host: { jobId: 'job', hostId: 'local' } },
    });
    expect(getCodingRun(done.runId, paths)).toEqual(done);
  });
  it('pages newest first beyond 25 runs without gaps and preserves ascending defaults', () => {
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      const run = reserveCodingRun(
        { ...snapshot, requestId: `page-${i}`, releaseId: `release-${i}` },
        paths,
      );
      ids.push(run.runId);
      update(run, {
        type: 'finish',
        status: 'failed',
        proof: proof(run),
        reason: 'never launched',
      });
    }
    const first = listCodingRuns({ order: 'desc' }, paths);
    expect(first).toHaveLength(25);
    expect(first.map((row) => row.record.runId)).toEqual(
      ids.slice(5).reverse(),
    );
    const second = listCodingRuns(
      { order: 'desc', after: first.at(-1)!.sequence },
      paths,
    );
    expect(second.map((row) => row.record.runId)).toEqual(
      ids.slice(0, 5).reverse(),
    );
    expect(
      listCodingRuns({ order: 'desc', after: second.at(-1)!.sequence }, paths),
    ).toEqual([]);
    expect(listCodingRuns({}, paths).map((row) => row.record.runId)).toEqual(
      ids.slice(0, 25),
    );
    expect(
      listCodingRuns({ order: 'desc', workItemId: 'work', limit: 1 }, paths)[0]
        ?.record.runId,
    ).toBe(ids.at(-1));
    expect(
      listCodingRuns({ order: 'desc', workItemId: 'missing', limit: 1 }, paths),
    ).toEqual([]);
    expect(
      listCodingRuns(
        {
          order: 'desc',
          workItemId: 'work',
          after: first[0]!.sequence,
          limit: 1,
        },
        paths,
      )[0]?.record.runId,
    ).toBe(ids.at(-2));
    expect(() => listCodingRuns({ order: 'sideways' }, paths)).toThrow(
      ValiError,
    );
  });
  it('queries the unique active slot and exact release without decoding unrelated history', () => {
    expect(getActiveCodingRun(paths)).toBeNull();
    expect(getCodingRunForRelease('missing', paths)).toBeNull();
    const first = reserveCodingRun(snapshot, paths);
    expect(getActiveCodingRun(paths)).toEqual(first);
    const completed = update(first, {
      type: 'finish',
      status: 'failed',
      proof: proof(first),
      reason: 'no compute',
    });
    expect(getActiveCodingRun(paths)).toBeNull();
    expect(getCodingRunForRelease(snapshot.releaseId, paths)).toEqual(
      completed,
    );
    let active = reserveCodingRun(
      { ...snapshot, requestId: 'next', releaseId: 'next-release' },
      paths,
    );
    active = update(active, { type: 'quarantine', reason: 'unknown compute' });
    expect(getActiveCodingRun(paths)).toEqual(active);
    expect(getCodingRunForRelease('next-release', paths)).toEqual(active);
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare('UPDATE coding_runs SET record_json = ? WHERE run_id = ?')
        .run('{}', first.runId);
    } finally {
      database.close();
    }
    expect(getActiveCodingRun(paths)).toEqual(active);
    expect(getCodingRunForRelease('next-release', paths)).toEqual(active);
    expect(getCodingRunForRelease('absent', paths)).toBeNull();
    expect(() => getCodingRunForRelease(snapshot.releaseId, paths)).toThrow(
      ValiError,
    );
    expect(() => getCodingRunForRelease('', paths)).toThrow(ValiError);
  });
  it('validates selected active IDs and records through the foundation decoder', () => {
    const active = reserveCodingRun(snapshot, paths);
    const database = openDb(paths.neondeckDatabase);
    try {
      database
        .prepare('UPDATE coding_runs SET record_json = ? WHERE run_id = ?')
        .run('{}', active.runId);
    } finally {
      database.close();
    }
    expect(() => getActiveCodingRun(paths)).toThrow(ValiError);
  });
  it('replays exactly, rejects changed frozen inputs and serializes global ownership', () => {
    const r = reserveCodingRun(snapshot, paths);
    expect(reserveCodingRun({ ...snapshot }, paths)).toEqual(r);
    expect(() =>
      reserveCodingRun({ ...snapshot, contextSnapshot: 'changed' }, paths),
    ).toThrow('Conflicting');
    expect(() =>
      reserveCodingRun({ ...snapshot, requestId: 'other' }, paths),
    ).toThrow('Conflicting');
    expect(() =>
      reserveCodingRun(
        { ...snapshot, requestId: 'other', releaseId: 'other' },
        paths,
      ),
    ).toThrow('reserved');
    snapshot.harness.model = 'changed';
    expect(getCodingRun(r.runId, paths)?.snapshot.harness.model).toBe(
      'test-model',
    );
    snapshot.harness.model = 'test-model';
    expect(listCodingRunEvents(r.runId, {}, paths)).toHaveLength(1);
  });
  it('fences stale versions/tokens and preserves cancellation through quarantine/restart', () => {
    const r = reserveCodingRun(snapshot, paths);
    expect(() =>
      updateCodingRun(
        {
          ...guard(r),
          ownershipToken: 'wrong',
          action: { type: 'cancel', reason: 'stop' },
        },
        paths,
      ),
    ).toThrow('conflict');
    const cancelled = update(r, { type: 'cancel', reason: 'stop' });
    expect(() => update(r, { type: 'quarantine', reason: 'stale' })).toThrow(
      'conflict',
    );
    const quarantined = update(cancelled, {
      type: 'quarantine',
      reason: 'controller lost',
    });
    initializeAppDatabase(paths.neondeckDatabase);
    expect(getCodingRun(r.runId, paths)).toEqual(quarantined);
    expect(() =>
      reserveCodingRun({ ...snapshot, requestId: '2', releaseId: '2' }, paths),
    ).toThrow('reserved');
    const done = update(quarantined, {
      type: 'finish',
      status: 'cancelled',
      proof: proof(quarantined),
      reason: 'no compute',
    });
    expect(done.cancelRequestedAt).toBe(cancelled.cancelRequestedAt);
    expect(() => update(done, { type: 'cancel', reason: 'again' })).toThrow(
      'terminal',
    );
    expect(
      reserveCodingRun({ ...snapshot, requestId: '2', releaseId: '2' }, paths)
        .runId,
    ).not.toBe(r.runId);
  });
  it('requires matching dead compute identity, retains candidate and separates session from host', () => {
    let r = workspace(reserveCodingRun(snapshot, paths));
    expect(getCodingRunForWorktree('wt', paths)?.runId).toBe(r.runId);
    r = update(r, {
      type: 'bind-host',
      host: { hostId: 'local', jobId: 'supervisor' },
    });
    expect(() =>
      update(r, {
        type: 'finish',
        status: 'failed',
        proof: { ...proof(r), kind: 'never-started' },
        reason: 'spawn failed',
      }),
    ).toThrow('death');
    expect(() =>
      update(r, {
        type: 'finish',
        status: 'failed',
        proof: { ...proof(r), host: { hostId: 'local', jobId: 'wrong' } },
        reason: 'bad',
      }),
    ).toThrow('identity');
    r = update(r, { type: 'running' });
    r = update(r, {
      type: 'bind-session',
      providerSessionId: 'provider-session',
    });
    expect(() =>
      update(r, { type: 'bind-session', providerSessionId: 'replacement' }),
    ).toThrow('already');
    r = update(r, { type: 'collecting' });
    const candidate = {
      baseSha: snapshot.baseSha,
      headSha: 'c'.repeat(40),
      worktreeId: 'wt',
      statusRef: 'status',
      diffRef: 'diff',
      includesUntracked: true as const,
    };
    expect(() =>
      update(r, {
        type: 'finish',
        status: 'candidate',
        proof: proof(r),
        candidate: { ...candidate, baseSha: 'd'.repeat(40) },
        reason: 'wrong',
      }),
    ).toThrow('evidence');
    const done = update(r, {
      type: 'finish',
      status: 'candidate',
      proof: proof(r),
      candidate,
      reason: 'awaiting review',
    });
    expect(done.status).toBe('candidate');
    expect(
      Date.parse(done.evidenceRetainUntil!) - Date.parse(done.completedAt!),
    ).toBe(30 * 86400000);
    expect(
      Date.parse(done.cleanupAttentionAt!) - Date.parse(done.completedAt!),
    ).toBe(7 * 86400000);
    expect(getCodingRunForWorktree('wt', paths)).toEqual(done);
  });
  it('rejects invalid inputs/records and bounds keyset pages', () => {
    expect(() =>
      reserveCodingRun({ ...snapshot, sessionMode: 'resume' }, paths),
    ).toThrow(ValiError);
    expect(() =>
      reserveCodingRun({ ...snapshot, baseSha: 'main' }, paths),
    ).toThrow(ValiError);
    expect(() =>
      reserveCodingRun(
        { ...snapshot, contextSnapshot: 'x'.repeat(100001) },
        paths,
      ),
    ).toThrow(ValiError);
    let r = reserveCodingRun(snapshot, paths);
    r = update(r, { type: 'quarantine', reason: 'unknown' });
    expect(() => listCodingRuns({ limit: 101 }, paths)).toThrow(ValiError);
    const first = listCodingRunEvents(r.runId, { limit: 1 }, paths);
    expect(
      listCodingRunEvents(
        r.runId,
        { after: first[0]!.sequence, limit: 1 },
        paths,
      )[0]?.type,
    ).toBe('quarantine');
    expect(listCodingRuns({ workItemId: 'missing' }, paths)).toEqual([]);
    expect(listCodingRuns({ workItemId: 'work' }, paths)).toHaveLength(1);
    const page = listCodingRuns({ limit: 1 }, paths);
    expect(listCodingRuns({ after: page[0]!.sequence }, paths)).toEqual([]);
    const db = openDb(paths.neondeckDatabase);
    db.prepare('UPDATE coding_runs SET record_json = ?').run(
      JSON.stringify({ ...r, status: 'candidate' }),
    );
    db.close();
    expect(() => getCodingRun(r.runId, paths)).toThrow(ValiError);
  });
  it('rejects rebinding and cancellation cannot become candidate', () => {
    let r = workspace(reserveCodingRun(snapshot, paths));
    expect(() =>
      update(r, {
        type: 'bind-workspace',
        workspace: { worktreeId: 'wt', lockId: 'lock' },
      }),
    ).toThrow('Workspace already bound or launch fenced');
    r = update(r, {
      type: 'bind-host',
      host: { hostId: 'host', jobId: 'job' },
    });
    r = update(r, { type: 'running' });
    r = update(r, { type: 'bind-session', providerSessionId: 'session' });
    r = update(r, { type: 'collecting' });
    r = update(r, { type: 'cancel', reason: 'withdrawn release' });
    expect(() =>
      update(r, {
        type: 'finish',
        status: 'candidate',
        proof: proof(r),
        reason: 'done',
      }),
    ).toThrow('Candidate evidence mismatch');
    expect(
      update(r, {
        type: 'finish',
        status: 'failed',
        proof: proof(r),
        reason: 'failed while cancelling',
      }).status,
    ).toBe('failed');
  });
  it('rejects corrupt terminal proof even when the JSON has valid field types', () => {
    let r = reserveCodingRun(snapshot, paths);
    r = update(r, {
      type: 'finish',
      status: 'failed',
      proof: proof(r),
      reason: 'no launch',
    });
    const database = openDb(paths.neondeckDatabase);
    try {
      database.prepare('UPDATE coding_runs SET record_json = ?').run(
        JSON.stringify({
          ...r,
          deadProof: { ...r.deadProof, attemptId: 'different-attempt' },
        }),
      );
    } finally {
      database.close();
    }
    expect(() => getCodingRun(r.runId, paths)).toThrow(ValiError);
  });
  it('quarantine never frees the writer even when its timestamps are old', () => {
    let r = reserveCodingRun(snapshot, paths);
    r = update(r, { type: 'quarantine', reason: 'lost host' });
    const database = openDb(paths.neondeckDatabase);
    try {
      database.prepare('UPDATE coding_runs SET record_json = ?').run(
        JSON.stringify({
          ...r,
          createdAt: '2000-01-01T00:00:00.000Z',
          updatedAt: '2000-01-01T00:00:00.000Z',
        }),
      );
    } finally {
      database.close();
    }
    initializeAppDatabase(paths.neondeckDatabase);
    expect(() =>
      reserveCodingRun(
        { ...snapshot, requestId: 'new', releaseId: 'new' },
        paths,
      ),
    ).toThrow('reserved');
    expect(getCodingRun(r.runId, paths)?.status).toBe('needs-reconcile');
  });
  it('serializes concurrent public API reservations and replay across workers', async () => {
    const reserve = (input: CodingRunSnapshot) =>
      new Promise<string>((resolve, reject) => {
        const worker = new Worker(
          `
        const {parentPort,workerData}=require('node:worker_threads');
        require('tsx/cjs');
        const {reserveCodingRun}=require(workerData.store);
        try { parentPort.postMessage(reserveCodingRun(workerData.input,workerData.paths).runId); }
        catch(error) { parentPort.postMessage('blocked'); }
      `,
          {
            eval: true,
            workerData: {
              store: join(process.cwd(), 'src/modules/coding-runs/store.ts'),
              input,
              paths,
            },
          },
        );
        worker.once('message', resolve);
        worker.once('error', reject);
      });
    const replay = await Promise.all(
      Array.from({ length: 4 }, () => reserve(snapshot)),
    );
    expect(new Set(replay).size).toBe(1);
    expect(replay[0]).not.toBe('blocked');
    expect(listCodingRunEvents(replay[0], {}, paths)).toHaveLength(1);
    let r = getCodingRun(replay[0], paths)!;
    r = update(r, {
      type: 'finish',
      status: 'failed',
      proof: proof(r),
      reason: 'never started',
    });
    const race = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        reserve({ ...snapshot, requestId: String(i), releaseId: String(i) }),
      ),
    );
    expect(race.filter((id) => id !== 'blocked')).toHaveLength(1);
  });
});
