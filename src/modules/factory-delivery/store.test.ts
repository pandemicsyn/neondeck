import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { openDb } from '../../lib/sqlite';
import { codingRunRecordSchema } from '../../../shared/coding-runs';
import type {
  DeliveryPipeline,
  DeliveryCommand,
  DeliveryReservation,
} from '../../../shared/factory-delivery';
import {
  reserveDeliveryPipeline,
  getDeliveryPipeline,
  updateDeliveryPipeline,
  reserveDeliveryRepair,
  getFactoryDeliveryOwnership,
  listDeliveryPipelines,
} from './store';

let home: string;
let paths: { neondeckDatabase: string };
const revision = {
  runId: 'initial',
  attemptId: 'initial-attempt',
  releaseId: 'release',
  specVersion: 1,
  specHash: 'a'.repeat(64),
  candidateDigest: 'b'.repeat(64),
  baseSha: 'c'.repeat(40),
  headSha: 'd'.repeat(40),
  treeSha: 'e'.repeat(40),
};
const reservation: DeliveryReservation = {
  workItemId: 'work',
  repoId: 'repo',
  initialRevision: revision,
  authorization: {
    id: 'grant',
    authorizedBy: 'human',
    authorizedAt: '2026-09-06T00:00:00.000Z',
    revision,
    repoId: 'repo',
    target: { owner: 'test', name: 'repo', baseBranch: 'main' },
    configFingerprint: 'f'.repeat(64),
    checkCommands: ['npm test'],
    maxRepairAttempts: 2,
    totalExecutionMs: 10800000,
    initialExecutionMs: 2700000,
  },
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delivery-'));
  paths = { neondeckDatabase: join(home, 'app.db') };
  initializeAppDatabase(paths.neondeckDatabase);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function update(r: DeliveryPipeline, action: DeliveryCommand['action']) {
  return updateDeliveryPipeline(
    { pipelineId: r.pipelineId, expectedVersion: r.version, action },
    paths,
  );
}
function evidence(
  r: DeliveryPipeline,
  kind: 'verification' | 'review',
  result: 'passed' | 'failed' = 'passed',
  producerId: string = kind,
) {
  return update(r, {
    type: 'record-evidence',
    evidence: {
      id: `${kind}-${r.version}`,
      kind,
      revision: r.revision,
      producerId,
      result,
      evidenceRef: 'private-evidence',
    },
  });
}
function ready() {
  return evidence(
    evidence(reserveDeliveryPipeline(reservation, paths), 'verification'),
    'review',
  );
}
function plan(r: DeliveryPipeline, kind: 'push' | 'create-pr' | 'commit') {
  return update(r, { type: 'plan-effect', id: `${kind}-${r.version}`, kind });
}
function start(r: DeliveryPipeline) {
  return update(r, { type: 'start-effect', id: r.effects.at(-1)!.id });
}
function deliver(r: DeliveryPipeline) {
  return update(r, {
    type: 'settle-effect',
    id: r.effects.at(-1)!.id,
    state: 'delivered',
    receiptRef: 'receipt',
  });
}
function repairInput(r: DeliveryPipeline, requestId = 'repair') {
  return {
    pipelineId: r.pipelineId,
    expectedVersion: r.version,
    requestId,
    reason: 'failed validation',
    maxWallTimeMs: 1000,
  };
}
function createRun(
  db: ReturnType<typeof openDb>,
  input: { parentRunId: string; requestId: string; maxWallTimeMs: number },
) {
  const run = v.parse(codingRunRecordSchema, {
    runId: input.requestId,
    attemptId: `${input.requestId}-attempt`,
    ownershipToken: 'token',
    version: 1,
    snapshot: {
      requestId: input.requestId,
      workItemId: 'work',
      releaseId: 'release',
      specVersion: 1,
      specHash: revision.specHash,
      specSnapshot: '{}',
      sourceId: 'source',
      sourceSnapshot: '{}',
      repoId: 'repo',
      repoSnapshot: '{}',
      policySnapshot: '{}',
      contextSnapshot: '{}',
      baseSha: revision.baseSha,
      harness: { provider: 'test', version: '1', model: 'test' },
      sessionMode: 'fresh',
    },
    status: 'reserved',
    host: null,
    workspace: null,
    providerSessionId: null,
    cancelRequestedAt: null,
    cancelReason: null,
    reason: null,
    deadProof: null,
    candidate: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
    completedAt: null,
    cleanupAttentionAt: null,
    evidenceRetainUntil: null,
  });
  db.prepare(
    'INSERT INTO coding_runs(run_id,attempt_id,request_id,release_id,work_item_id,writer_slot,record_json) VALUES(?,?,?,?,?,1,?)',
  ).run(
    run.runId,
    run.attemptId,
    input.requestId,
    'release',
    'work',
    JSON.stringify(run),
  );
  return run;
}
describe('factory delivery foundation', () => {
  it('requires exact explicit grant and replays one pipeline per initial candidate', () => {
    const r = reserveDeliveryPipeline(reservation, paths);
    expect(reserveDeliveryPipeline(reservation, paths)).toEqual(r);
    expect(() =>
      reserveDeliveryPipeline(
        {
          ...reservation,
          authorization: {
            ...reservation.authorization,
            revision: { ...revision, treeSha: 'f'.repeat(40) },
          },
        },
        paths,
      ),
    ).toThrow('authorization mismatch');
    expect(() =>
      reserveDeliveryPipeline(
        {
          ...reservation,
          authorization: { ...reservation.authorization, id: 'different' },
        },
        paths,
      ),
    ).toThrow('Conflicting delivery replay');
    expect(getDeliveryPipeline(r.pipelineId, paths)).toEqual(r);
    expect(listDeliveryPipelines({}, paths)).toEqual([
      { sequence: 1, record: r },
    ]);
    expect(() =>
      reserveDeliveryPipeline(
        { ...reservation, authorization: undefined },
        paths,
      ),
    ).toThrow();
  });
  it('rejects stale CAS and invalid persisted identity', () => {
    const r = reserveDeliveryPipeline(reservation, paths);
    evidence(r, 'verification');
    expect(() => evidence(r, 'review')).toThrow('version conflict');
    const db = openDb(paths.neondeckDatabase);
    db.prepare('UPDATE factory_delivery_pipelines SET repo_id=?').run('other');
    db.close();
    expect(() => getDeliveryPipeline(r.pipelineId, paths)).toThrow(
      'Corrupt delivery identity',
    );
  });
  it('requires exact independent current evidence', () => {
    let r = reserveDeliveryPipeline(reservation, paths);
    expect(() => plan(r, 'push')).toThrow('independent verification');
    expect(() => evidence(r, 'verification', 'passed', revision.runId)).toThrow(
      'Independent evidence',
    );
    expect(() =>
      update(r, {
        type: 'record-evidence',
        evidence: {
          id: 'stale',
          kind: 'verification',
          revision: { ...revision, treeSha: 'f'.repeat(40) },
          producerId: 'verifier',
          result: 'passed',
          evidenceRef: 'proof',
        },
      }),
    ).toThrow('Stale evidence');
    r = evidence(
      evidence(r, 'verification', 'passed', 'same'),
      'review',
      'passed',
      'same',
    );
    expect(() => plan(r, 'push')).toThrow('independent verification');
    r = evidence(r, 'review');
    r = plan(r, 'push');
    r = evidence(r, 'verification', 'failed');
    expect(() => start(r)).toThrow('independent verification');
  });
  it('keeps uncertain operations reserved and requires observed absence before restart', () => {
    let r = start(plan(ready(), 'push'));
    const id = r.effects[0]!.id;
    r = update(r, {
      type: 'settle-effect',
      id,
      state: 'uncertain',
      receiptRef: 'timeout',
    });
    expect(() => update(r, { type: 'start-effect', id })).toThrow(
      'cannot start',
    );
    expect(() =>
      update(r, {
        type: 'finish',
        outcome: 'cancelled',
        evidenceRef: 'cancel',
      }),
    ).toThrow('Outstanding work');
    r = update(r, {
      type: 'reconcile-effect',
      id,
      observation: 'not-delivered',
      receiptRef: 'remote-absence',
    });
    r = update(r, { type: 'start-effect', id });
    r = deliver(r);
    expect(r.effects[0]!.state).toBe('delivered');
    expect(() => update(r, { type: 'start-effect', id })).toThrow(
      'cannot start',
    );
  });
  it('persists separate same-tree commit receipt without invalidating certified revision', () => {
    let r = start(plan(ready(), 'commit'));
    expect(() =>
      update(r, {
        type: 'bind-commit',
        publishedHeadSha: 'a'.repeat(40),
        treeSha: 'b'.repeat(40),
        evidenceRef: 'commit',
      }),
    ).toThrow('content');
    r = update(r, {
      type: 'bind-commit',
      publishedHeadSha: 'a'.repeat(40),
      treeSha: revision.treeSha,
      evidenceRef: 'commit',
    });
    expect(r.revision).toEqual(revision);
    expect(r.commits[0]!.publishedHeadSha).toBe('a'.repeat(40));
  });
  it('binds PR ownership after push and retains ownership after terminal outcome', () => {
    let r = ready();
    r = plan(r, 'create-pr');
    expect(() => start(r)).toThrow('push receipt');
    r = deliver(start(plan(r, 'push')));
    r = update(r, { type: 'start-effect', id: r.effects[0]!.id });
    const pr = { number: 42, url: 'https://github.com/test/repo/pull/42' };
    r = update(r, {
      type: 'settle-effect',
      id: r.effects[0]!.id,
      state: 'delivered',
      receiptRef: 'github-read',
      pr,
    });
    r = update(r, {
      type: 'finish',
      outcome: 'closed',
      evidenceRef: 'observed-closed',
    });
    expect(
      getFactoryDeliveryOwnership({ repoId: 'repo', prNumber: 42 }, paths),
    ).toEqual(r);
    expect(
      getFactoryDeliveryOwnership({ repoId: 'repo', branch: r.branch }, paths),
    ).toEqual(r);
    expect(() => plan(r, 'push')).toThrow('terminal');
  });
  it('reserves repair budget and singleton writer atomically, replay safe', () => {
    let r = reserveDeliveryPipeline(reservation, paths);
    expect(() =>
      reserveDeliveryRepair(repairInput(r), paths, createRun),
    ).toThrow('failed evidence');
    r = evidence(r, 'verification', 'failed');
    const result = reserveDeliveryRepair(repairInput(r), paths, createRun);
    expect(reserveDeliveryRepair(repairInput(r), paths, createRun)).toEqual(
      result,
    );
    expect(result.pipeline.repairs).toHaveLength(1);
    expect(() =>
      reserveDeliveryRepair(
        repairInput(result.pipeline, 'another'),
        paths,
        createRun,
      ),
    ).toThrow('already reserved');
    expect(() =>
      reserveDeliveryRepair(
        { ...repairInput(r), maxWallTimeMs: 2700001 },
        paths,
        createRun,
      ),
    ).toThrow();
  });
  it('rolls back both budget and fresh run on callback failure', () => {
    const r = evidence(
      reserveDeliveryPipeline(reservation, paths),
      'review',
      'failed',
    );
    expect(() =>
      reserveDeliveryRepair(repairInput(r), paths, (db, input) => {
        createRun(db, input);
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(getDeliveryPipeline(r.pipelineId, paths)).toEqual(r);
    const db = openDb(paths.neondeckDatabase);
    expect(db.prepare('SELECT * FROM coding_runs').all()).toEqual([]);
    db.close();
  });
  it('revision replacement invalidates retained pass evidence and records over-budget intervention', () => {
    let r = evidence(ready(), 'review', 'failed');
    const result = reserveDeliveryRepair(repairInput(r), paths, createRun);
    r = result.pipeline;
    const next = {
      ...revision,
      runId: result.run.runId,
      attemptId: result.run.attemptId,
      candidateDigest: '9'.repeat(64),
      treeSha: '8'.repeat(40),
    };
    r = update(r, {
      type: 'finish-repair',
      runId: next.runId,
      attemptId: next.attemptId,
      revision: next,
      executionMs: 1001,
    });
    expect(r.evidence).toHaveLength(3);
    expect(r.interventions[0]!.kind).toBe('budget');
    expect(() => plan(r, 'push')).toThrow('intervention');
    expect(() =>
      update(r, {
        type: 'resolve-intervention',
        id: r.interventions[0]!.id,
        resolution: 'retry',
      }),
    ).toThrow('New exact authorization');
  });
  it('accounts independent verification reservation within total authority', () => {
    let r = reserveDeliveryPipeline(
      {
        ...reservation,
        authorization: {
          ...reservation.authorization,
          totalExecutionMs: 2701000,
        },
      },
      paths,
    );
    expect(() =>
      update(r, {
        type: 'plan-effect',
        id: 'check',
        kind: 'verification',
        maxExecutionMs: 1001,
      }),
    ).toThrow('budget');
    r = update(r, {
      type: 'plan-effect',
      id: 'check',
      kind: 'verification',
      maxExecutionMs: 1000,
    });
    r = start(r);
    expect(() => deliver(r)).toThrow('accounting required');
    r = update(r, {
      type: 'settle-effect',
      id: 'check',
      state: 'delivered',
      receiptRef: 'log',
      executionMs: 1100,
    });
    expect(r.interventions[0]!.kind).toBe('budget');
  });
  it('never resolves material scope under old grant', () => {
    let r = ready();
    r = update(r, {
      type: 'intervene',
      id: 'scope',
      kind: 'scope',
      reason: 'new dependency',
    });
    expect(() =>
      update(r, {
        type: 'resolve-intervention',
        id: 'scope',
        resolution: 'ok',
      }),
    ).toThrow('New exact authorization');
  });
});
