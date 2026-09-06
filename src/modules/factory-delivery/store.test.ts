import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { claimWatchAutopilotTurn, transitionWatchAutopilot } from '../watches';
import { registerPendingAutopilotTurn } from '../autopilot';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
  deliveryValidationContractDigest,
  getPendingDeliveryFeedback,
  isFactoryOwnedWatch,
  deliveryBudget,
  getDeliveryPipeline,
  updateDeliveryPipeline,
  reserveDeliveryRepair,
  getFactoryDeliveryOwnership,
  listDeliveryPipelines,
} from './store';

let home: string;
let paths: RuntimePaths;
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
  paths = runtimePaths(home);
  mkdirSync(dirname(paths.neondeckDatabase), { recursive: true });
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
  settle = true,
) {
  const id = `${kind}-${r.version}`;
  const verification = r.evidence.findLast((x) => x.kind === 'verification');
  r = update(r, { type: 'plan-effect', id, kind, maxExecutionMs: 1000 });
  r = update(r, { type: 'start-effect', id });
  r = update(r, {
    type: 'record-evidence',
    evidence: {
      id,
      kind,
      revision: r.revision,
      producerId,
      result,
      evidenceRef: `receipt:${id}`,
      effectId: id,
      validationContractDigest: deliveryValidationContractDigest(r),
      bundleDigest: (kind === 'verification' ? '1' : '2').repeat(64),
      verificationEvidenceId: kind === 'review' ? verification!.id : null,
      verificationBundleDigest:
        kind === 'review' ? verification!.bundleDigest : null,
    },
  });
  return settle
    ? update(r, {
        type: 'settle-effect',
        id,
        state: 'delivered',
        receiptRef: `receipt:${id}`,
        executionMs: 1,
      })
    : r;
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
    expect(() =>
      update(r, {
        type: 'record-evidence',
        evidence: {
          id: 'self',
          kind: 'verification',
          revision,
          producerId: revision.runId,
          result: 'passed',
          evidenceRef: 'proof',
          effectId: 'none',
          validationContractDigest: deliveryValidationContractDigest(r),
          bundleDigest: '1'.repeat(64),
          verificationEvidenceId: null,
          verificationBundleDigest: null,
        },
      }),
    ).toThrow('Independent evidence');
    expect(() =>
      update(r, {
        type: 'record-evidence',
        evidence: {
          id: 'stale',
          effectId: 'none',
          validationContractDigest: deliveryValidationContractDigest(r),
          bundleDigest: '1'.repeat(64),
          verificationEvidenceId: null,
          verificationBundleDigest: null,
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
    expect(() =>
      update(r, {
        type: 'start-effect',
        id: r.effects.find((x) => x.kind === 'push')!.id,
      }),
    ).toThrow('independent verification');
  });
  it('keeps uncertain operations reserved and requires observed absence before restart', () => {
    let r = start(plan(ready(), 'push'));
    const id = r.effects.find((x) => x.kind === 'push')!.id;
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
    expect(r.effects.find((x) => x.kind === 'push')!.state).toBe('delivered');
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
    r = update(r, {
      type: 'start-effect',
      id: r.effects.find((x) => x.kind === 'create-pr')!.id,
    });
    const pr = { number: 42, url: 'https://github.com/test/repo/pull/42' };
    r = update(r, {
      type: 'settle-effect',
      id: r.effects.find((x) => x.kind === 'create-pr')!.id,
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
      'verification',
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

describe('reviewer A regressions', () => {
  it('prevents descendant candidate regrant for the same release without resetting budget or identity', () => {
    const r = evidence(
      reserveDeliveryPipeline(reservation, paths),
      'verification',
      'failed',
    );
    const child = {
      ...revision,
      runId: 'repair-descendant',
      attemptId: 'repair-attempt',
    };
    expect(() =>
      reserveDeliveryPipeline(
        {
          ...reservation,
          initialRevision: child,
          authorization: { ...reservation.authorization, revision: child },
        },
        paths,
      ),
    ).toThrow('Conflicting delivery replay');
    expect(getDeliveryPipeline(r.pipelineId, paths)).toEqual(r);
    expect(listDeliveryPipelines({}, paths)).toHaveLength(1);
    const next = { ...child, releaseId: 'new-human-release' };
    expect(
      reserveDeliveryPipeline(
        {
          ...reservation,
          initialRevision: next,
          authorization: {
            ...reservation.authorization,
            id: 'new-grant',
            revision: next,
          },
        },
        paths,
      ).pipelineId,
    ).not.toBe(r.pipelineId);
  });
  it('crossvalidates indexed release identity on read', () => {
    const r = reserveDeliveryPipeline(reservation, paths);
    const db = openDb(paths.neondeckDatabase);
    db.prepare('UPDATE factory_delivery_pipelines SET release_id=?').run(
      'tampered',
    );
    db.close();
    expect(() => getDeliveryPipeline(r.pipelineId, paths)).toThrow(
      'Corrupt delivery identity',
    );
  });
  it('requires accounted settled review receipt even when both pass labels exist', () => {
    let r = evidence(
      evidence(reserveDeliveryPipeline(reservation, paths), 'verification'),
      'review',
      'passed',
      'review',
      false,
    );
    expect(() => plan(r, 'push')).toThrow('independent verification');
    const review = r.evidence.at(-1)!;
    expect(() =>
      update(r, {
        type: 'settle-effect',
        id: review.effectId,
        state: 'delivered',
        receiptRef: 'wrong-receipt',
        executionMs: 1,
      }),
    ).toThrow('provenance');
    r = update(r, {
      type: 'settle-effect',
      id: review.effectId,
      state: 'delivered',
      receiptRef: review.evidenceRef,
      executionMs: 1,
    });
    expect(plan(r, 'push').effects.at(-1)!.kind).toBe('push');
  });
  it('requires fresh linked review when a successful verification bundle replaces another', () => {
    let r = ready();
    r = evidence(r, 'verification');
    expect(() => plan(r, 'commit')).toThrow('independent verification');
    r = evidence(r, 'review');
    expect(plan(r, 'commit').effects.at(-1)!.kind).toBe('commit');
  });
  it('rejects persisted evidence whose receipt linkage is corrupted', () => {
    const r = ready();
    r.evidence[0]!.effectId = 'nonexistent';
    const db = openDb(paths.neondeckDatabase);
    db.prepare('UPDATE factory_delivery_pipelines SET record_json=?').run(
      JSON.stringify(r),
    );
    db.close();
    expect(() => getDeliveryPipeline(r.pipelineId, paths)).toThrow(
      'provenance',
    );
  });
});

it('rejects pass labels without an execution effect and rejects review before verification settlement', () => {
  let r = reserveDeliveryPipeline(reservation, paths);
  expect(() =>
    update(r, {
      type: 'record-evidence',
      evidence: {
        id: 'fake-pass',
        kind: 'verification',
        revision,
        producerId: 'checker',
        result: 'passed',
        evidenceRef: 'fake',
        effectId: 'no-effect',
        validationContractDigest: deliveryValidationContractDigest(r),
        bundleDigest: '1'.repeat(64),
        verificationEvidenceId: null,
        verificationBundleDigest: null,
      },
    }),
  ).toThrow('effect provenance');
  r = evidence(r, 'verification', 'passed', 'checker', false);
  expect(() => plan(r, 'commit')).toThrow('independent verification');
  expect(() => evidence(r, 'review')).toThrow('unresolved');
});

function published() {
  let r = start(plan(ready(), 'commit'));
  r = update(r, {
    type: 'bind-commit',
    publishedHeadSha: '7'.repeat(40),
    treeSha: r.revision.treeSha,
    evidenceRef: 'commit',
  });
  r = deliver(r);
  r = deliver(start(plan(r, 'push')));
  r = start(plan(r, 'create-pr'));
  return update(r, {
    type: 'settle-effect',
    id: r.effects.at(-1)!.id,
    state: 'delivered',
    receiptRef: 'PR receipt',
    pr: { number: 42, url: 'https://github.com/test/repo/pull/42' },
  });
}
function feedback(
  r: DeliveryPipeline,
  ciFailed: boolean,
  hasReviewFeedback = false,
  fingerprint = '4'.repeat(64),
) {
  return update(r, {
    type: 'record-feedback',
    feedback: {
      id: `feedback:${fingerprint}`,
      fingerprint,
      revision: r.revision,
      publishedHeadSha: '7'.repeat(40),
      ciFailed,
      hasReviewFeedback,
      evidenceRef: 'external-observation',
    },
  });
}
function seedWatch(id: string, number = 99, repoId = 'repo', owner = 'test') {
  const db = openDb(paths.neondeckDatabase);
  db.prepare(
    `INSERT INTO pr_watches(id,repo_id,repo_full_name,github_owner,github_name,pr_number,desired_terminal_state,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'merged','watching',?,?)`,
  ).run(
    id,
    repoId,
    `${owner}/repo`,
    owner,
    'repo',
    number,
    reservation.authorization.authorizedAt,
    reservation.authorization.authorizedAt,
  );
  db.close();
}
it('normal feedback never certifies, consumes repair once, and success supersedes failure', () => {
  let r = feedback(published(), true);
  const observed = r.feedback[0]!;
  expect(getPendingDeliveryFeedback(r)?.id).toBe(observed.id);
  expect(r.evidence).toHaveLength(2);
  expect(feedback(r, true)).toEqual(r);
  r = feedback(r, false, false, '5'.repeat(64));
  expect(getPendingDeliveryFeedback(r)).toBeNull();
  r = feedback(r, true, false, '6'.repeat(64));
  const repaired = reserveDeliveryRepair(repairInput(r), paths, createRun);
  expect(repaired.pipeline.feedback.at(-1)!.repairRequestId).toBe('repair');
  expect(getPendingDeliveryFeedback(repaired.pipeline)).toBeNull();
});
it('raw review prose is not repair authority; only bound accounted classification can authorize', () => {
  let r = feedback(published(), false, true);
  const f = r.feedback[0]!;
  const id = `feedback-review:${f.fingerprint}`;
  expect(getPendingDeliveryFeedback(r)).toBeNull();
  expect(() => reserveDeliveryRepair(repairInput(r), paths, createRun)).toThrow(
    'failed evidence',
  );
  expect(() =>
    update(r, {
      type: 'classify-feedback',
      id: f.id,
      effectId: id,
      result: 'scoped-repair',
      evidenceRef: 'report',
    }),
  ).toThrow('receipt missing');
  r = update(r, {
    type: 'plan-effect',
    id,
    kind: 'feedback-review',
    maxExecutionMs: 1000,
  });
  r = update(r, { type: 'start-effect', id });
  r = update(r, {
    type: 'bind-effect-receipt',
    id,
    receiptRef: 'dispatch-receipt',
  });
  expect(() =>
    update(r, {
      type: 'classify-feedback',
      id: f.id,
      effectId: id,
      result: 'scoped-repair',
      evidenceRef: 'report',
    }),
  ).toThrow('receipt missing');
  r = update(r, {
    type: 'settle-effect',
    id,
    state: 'delivered',
    receiptRef: 'report',
    executionMs: 25,
  });
  r = update(r, {
    type: 'classify-feedback',
    id: f.id,
    effectId: id,
    result: 'scoped-repair',
    evidenceRef: 'report',
  });
  expect(getPendingDeliveryFeedback(r)?.id).toBe(f.id);
  expect(deliveryBudget(r).consumedExecutionMs).toBe(2700027);
});
it('queued plans do not fence unrelated work; legacy claim wins before publication admission', () => {
  let r = deliver(start(plan(ready(), 'push')));
  r = plan(r, 'create-pr');
  seedWatch('legacy');
  expect(isFactoryOwnedWatch('legacy', paths)).toBe(false);
  expect(claimWatchAutopilotTurn(paths, 'legacy', 'event')).toBeDefined();
  expect(() => start(r)).toThrow('Legacy owner');
  expect(getDeliveryPipeline(r.pipelineId, paths)!.effects.at(-1)!.state).toBe(
    'planned',
  );
});
it('publication claim atomically fences legacy event/direct/pending admissions including repo aliases', () => {
  let r = deliver(start(plan(ready(), 'push')));
  r = plan(r, 'create-pr');
  seedWatch('alias', 99, 'other-config-alias');
  seedWatch('otherrepo', 9, 'otherrepo', 'other');
  r = start(r);
  expect(isFactoryOwnedWatch('alias', paths)).toBe(true);
  expect(isFactoryOwnedWatch('otherrepo', paths)).toBe(false);
  expect(claimWatchAutopilotTurn(paths, 'alias', 'event')).toBeUndefined();
  expect(
    transitionWatchAutopilot(paths, 'alias', {
      from: 'watching',
      to: 'working',
    }),
  ).toBeUndefined();
  expect(() =>
    registerPendingAutopilotTurn(
      paths.home,
      'owner',
      undefined,
      'autofix-with-approval',
      'direct-human',
      undefined,
      { watchId: 'alias' },
    ),
  ).toThrow('Factory delivery');
  r = update(r, {
    type: 'settle-effect',
    id: r.effects.at(-1)!.id,
    state: 'uncertain',
    receiptRef: 'timeout',
  });
  expect(isFactoryOwnedWatch('alias', paths)).toBe(true);
  r = update(r, {
    type: 'reconcile-effect',
    id: r.effects.at(-1)!.id,
    observation: 'delivered',
    receiptRef: 'observed-PR',
    pr: { number: 42, url: 'https://github.com/test/repo/pull/42' },
  });
  expect(isFactoryOwnedWatch('alias', paths)).toBe(false);
  seedWatch('factory-pr', 42, 'another-alias');
  expect(isFactoryOwnedWatch('factory-pr', paths)).toBe(true);
});
it('retains execution reservation for a dead repair with unavailable duration', () => {
  const r = evidence(
    reserveDeliveryPipeline(reservation, paths),
    'verification',
    'failed',
  );
  const reserved = reserveDeliveryRepair(repairInput(r), paths, createRun);
  const finished = update(reserved.pipeline, {
    type: 'finish-repair',
    runId: reserved.run.runId,
    attemptId: reserved.run.attemptId,
    revision: null,
    executionMs: null,
  });
  expect(deliveryBudget(finished).reservedExecutionMs).toBe(1000);
  expect(getDeliveryPipeline(finished.pipelineId, paths)).toEqual(finished);
});

it('imports an exact trusted commit receipt once while its prior effect remains uncertain', () => {
  let r = start(plan(ready(), 'commit'));
  const id = r.effects.at(-1)!.id;
  r = update(r, {
    type: 'settle-effect',
    id,
    state: 'uncertain',
    receiptRef: 'timeout',
  });
  const action = {
    type: 'bind-commit' as const,
    publishedHeadSha: '7'.repeat(40),
    treeSha: r.revision.treeSha,
    evidenceRef: 'trusted-commit-receipt',
  };
  r = update(r, action);
  expect(update(r, action)).toEqual(r);
  expect(() =>
    update(r, { ...action, publishedHeadSha: '8'.repeat(40) }),
  ).toThrow('Conflicting commit');
  expect(r.effects.at(-1)!.state).toBe('uncertain');
});
