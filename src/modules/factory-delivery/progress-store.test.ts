import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { openDb } from '../../lib/sqlite';
import type {
  DeliveryPipeline,
  DeliveryCommand,
  DeliveryReservation,
} from '../../../shared/factory-delivery';
import {
  reserveDeliveryPipeline,
  updateDeliveryPipeline,
  deliveryValidationContractDigest,
  reserveDeliveryProgress,
  updateDeliveryProgress,
  deliveryProgressEvidenceDigest,
  getDeliveryPipeline,
  deliveryBudget,
  reserveDeliveryRepair,
} from './store';
import { assertProgressRepair } from './progress-domain';
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

function failed() {
  return evidence(
    reserveDeliveryPipeline(reservation, paths),
    'verification',
    'failed',
  );
}
function request(r: DeliveryPipeline) {
  return {
    pipelineId: r.pipelineId,
    expectedVersion: r.version,
    assessmentId: 'assessment',
    grantId: r.authorization.id,
    revision: r.revision,
    repairOrdinal: r.repairs.length + 1,
    requestId: 'repair',
    inputDigest: '1'.repeat(64),
    evidenceDigest: deliveryProgressEvidenceDigest(r),
    instructions: 'Repair the failed assertion',
    evidenceRefs: ['receipt:verification-1'],
  };
}
function progress(
  r: DeliveryPipeline,
  action: Parameters<typeof updateDeliveryProgress>[0],
) {
  return updateDeliveryProgress(
    {
      pipelineId: r.pipelineId,
      expectedVersion: r.version,
      assessmentId: 'assessment',
      action,
    },
    paths,
  );
}
function launched(r = failed()) {
  r = reserveDeliveryProgress(request(r), paths).pipeline;
  r = progress(r, { type: 'start' });
  return progress(r, { type: 'bind-submission', submissionId: 'submission' });
}
function result(r: DeliveryPipeline) {
  const a = r.progress.assessments[0]!;
  return {
    assessmentId: a.assessmentId,
    grantId: a.grantId,
    revision: a.revision,
    repairOrdinal: a.repairOrdinal,
    requestId: a.requestId,
    inputDigest: a.inputDigest,
    evidenceDigest: a.evidenceDigest,
    decision: 'continue',
    rationale: 'A bounded fix addresses the failure',
    evidenceRefs: ['receipt:verification-1'],
    nextInstructions: null,
  };
}
function settle(r: DeliveryPipeline, overrides = {}) {
  return progress(r, {
    type: 'settle',
    submissionId: 'submission',
    resultId: 'result',
    executionMs: 1200,
    completedAt: r.progress.assessments[0]!.reservedAt,
    result: result(r),
    ...overrides,
  });
}
function repair(r: DeliveryPipeline) {
  const a = r.progress.assessments[0]!;
  return {
    pipelineId: r.pipelineId,
    expectedVersion: r.version,
    requestId: a.requestId,
    reason: a.instructions,
    maxWallTimeMs: 1000,
    progressAssessmentId: a.assessmentId,
    progressInputDigest: a.inputDigest,
    progressEvidenceDigest: a.evidenceDigest,
  };
}
afterEach(() => vi.useRealTimers());
it('persists a single reservation and original deadline across stale duplicate/restart', () => {
  const r = failed();
  const cmd = request(r);
  const admitted = reserveDeliveryProgress(cmd, paths);
  expect(admitted.assessment.reservedExecutionMs).toBe(180000);
  expect(admitted.assessment.remainingExecutionMs).toBe(
    deliveryBudget(r).remainingExecutionMs,
  );
  expect(reserveDeliveryProgress(cmd, paths)).toEqual({
    ...admitted,
    replayed: true,
  });
  expect(getDeliveryPipeline(r.pipelineId, paths)).toEqual(admitted.pipeline);
  expect(() =>
    reserveDeliveryProgress({ ...cmd, inputDigest: '2'.repeat(64) }, paths),
  ).toThrow('Conflicting');
});
it('holds unknown admission and usage without admitting a replacement', () => {
  let r = launched();
  r = progress(r, { type: 'uncertain' });
  expect(() =>
    reserveDeliveryProgress(
      { ...request(r), assessmentId: 'replacement' },
      paths,
    ),
  ).toThrow('unresolved');
  r = settle(r, { executionMs: null, result: null });
  expect(deliveryBudget(r).reservedExecutionMs).toBe(180000);
  expect(() => assertProgressRepair(r, repair(r))).toThrow('successful');
  expect(() =>
    reserveDeliveryProgress(
      { ...request(r), assessmentId: 'replacement' },
      paths,
    ),
  ).toThrow('intervention');
});
it('accounts known time normally without refilling invocation or ordinal limits', () => {
  const started = launched();
  const before = deliveryBudget(started);
  const r = settle(started);
  expect(deliveryBudget(r).remainingExecutionMs).toBe(
    before.remainingExecutionMs + 180000 - 1200,
  );
  expect(deliveryProgressEvidenceDigest(r)).toBe(
    deliveryProgressEvidenceDigest(started),
  );
  expect(() =>
    reserveDeliveryProgress({ ...request(r), assessmentId: 'another' }, paths),
  ).toThrow('budget');
  expect(() => assertProgressRepair(r, repair(r))).not.toThrow();
  expect(settle(r)).toEqual(r);
  expect(() => settle(r, { executionMs: 0 })).toThrow('Conflicting');
});
it('rejects malformed bindings and stale evidence without granting authority', () => {
  const r = launched();
  expect(() =>
    settle(r, { result: { ...result(r), repairOrdinal: 2 } }),
  ).toThrow('binding');
  expect(() =>
    settle(r, { result: { ...result(r), evidenceRefs: [] } }),
  ).toThrow();
  expect(() =>
    settle(r, { result: { ...result(r), decision: 'change-approach' } }),
  ).toThrow();
  const settled = settle(r);
  expect(() =>
    assertProgressRepair(settled, {
      ...repair(settled),
      reason: 'Unrelated work',
    }),
  ).toThrow();
  expect(() =>
    assertProgressRepair(
      {
        ...settled,
        authorization: { ...settled.authorization, id: 'changed' },
      },
      repair(settled),
    ),
  ).toThrow();
  const changed = structuredClone(settled);
  changed.evidence[0]!.bundleDigest = '3'.repeat(64);
  expect(() => assertProgressRepair(changed, repair(settled))).toThrow();
});
it('change approach authorizes only its exact alternate instructions for the same ordinal', () => {
  let r = launched();
  r = settle(r, {
    result: {
      ...result(r),
      decision: 'change-approach',
      nextInstructions: 'Correct fixture construction',
    },
  });
  expect(() => assertProgressRepair(r, repair(r))).toThrow();
  expect(() =>
    assertProgressRepair(r, {
      ...repair(r),
      reason: 'Correct fixture construction',
    }),
  ).not.toThrow();
});
it('deadline and over-budget replies cannot grant another repair', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const r = launched();
  expect(() => settle(r, { executionMs: 180001 })).toThrow('usage');
  vi.advanceTimersByTime(180000);
  expect(() =>
    settle(r, { completedAt: new Date(Date.now() + 1).toISOString() }),
  ).toThrow('stale');
  const expired = settle(r, { result: null, executionMs: 180000 });
  expect(expired.interventions).toHaveLength(1);
});
it('exhaustion stops admission before any model invocation and smaller remaining time bounds deadline', () => {
  const r = failed();
  const db = openDb(paths.neondeckDatabase);
  r.authorization.totalExecutionMs =
    r.authorization.initialExecutionMs + 1 + 500;
  db.prepare(
    'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
  ).run(JSON.stringify(r), r.pipelineId);
  db.close();
  const admitted = reserveDeliveryProgress(request(r), paths);
  expect(admitted.assessment.reservedExecutionMs).toBe(500);
  const copy = structuredClone(admitted.pipeline);
  copy.progress.assessments = [];
  copy.authorization.totalExecutionMs =
    copy.authorization.initialExecutionMs + 1;
  const db2 = openDb(paths.neondeckDatabase);
  db2
    .prepare(
      'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
    )
    .run(JSON.stringify(copy), copy.pipelineId);
  db2.close();
  expect(() => reserveDeliveryProgress(request(copy), paths)).toThrow('budget');
});
it('legacy stored JSON remains readable but cannot admit an unassessed repair', () => {
  const r = failed();
  const { progress: _progress, ...legacy } = r;
  const db = openDb(paths.neondeckDatabase);
  db.prepare(
    'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
  ).run(JSON.stringify(legacy), r.pipelineId);
  db.close();
  const loaded = getDeliveryPipeline(r.pipelineId, paths)!;
  expect(loaded.progress.assessments).toEqual([]);
  const create = vi.fn();
  expect(() =>
    reserveDeliveryRepair(
      { ...request(loaded), reason: 'Repair', maxWallTimeMs: 1000 },
      paths,
      create,
    ),
  ).toThrow();
  expect(create).not.toHaveBeenCalled();
});
it('corrupt persisted deadlines and duplicate identities fail closed on read', () => {
  const r = launched();
  r.progress.assessments[0]!.deadlineAt = r.progress.assessments[0]!.reservedAt;
  const db = openDb(paths.neondeckDatabase);
  db.prepare(
    'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
  ).run(JSON.stringify(r), r.pipelineId);
  db.close();
  expect(() => getDeliveryPipeline(r.pipelineId, paths)).toThrow(
    'Corrupt progress',
  );
});
it('reconciles an attested on-time completion after deadline with no new admission', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-06T00:00:00Z'));
  const r = launched();
  const completedAt = new Date(Date.now() + 1000).toISOString();
  vi.advanceTimersByTime(600000);
  const settled = settle(r, { completedAt });
  expect(settled.progress.assessments[0]!.state).toBe('settled');
  expect(deliveryBudget(settled).reservedExecutionMs).toBe(0);
});
it('records terminal accounting after revocation without permitting another start', () => {
  const r = launched();
  r.outcome = 'cancelled';
  r.outcomeRef = 'revoked';
  const db = openDb(paths.neondeckDatabase);
  db.prepare(
    'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
  ).run(JSON.stringify(r), r.pipelineId);
  db.close();
  const settled = settle(r, { result: null });
  expect(settled.progress.assessments[0]!.executionMs).toBe(1200);
  expect(() => progress(settled, { type: 'start' })).toThrow('terminal');
});
it('rejects invented evidence citations at the persistence boundary', () => {
  const r = launched();
  expect(() =>
    settle(r, { result: { ...result(r), evidenceRefs: ['invented:source'] } }),
  ).toThrow('binding');
});

it.each(['continue', 'change-approach'] as const)(
  'rejects %s settlement after a concurrent pause while retaining accounting',
  (decision) => {
    const started = launched();
    const paused = update(started, {
      type: 'intervene',
      id: 'concurrent-pause',
      kind: 'authority',
      reason: 'Operator withdrew repair authority',
    });
    expect(() =>
      settle(paused, {
        result: {
          ...result(paused),
          decision,
          nextInstructions:
            decision === 'change-approach' ? 'Correct the fixture' : null,
        },
      }),
    ).toThrow('intervention');
    expect(getDeliveryPipeline(paused.pipelineId, paths)).toEqual(paused);
    const accounted = settle(paused, { result: null });
    expect(accounted.progress.assessments[0]!.executionMs).toBe(1200);
    expect(accounted.progress.assessments[0]!.result).toBeNull();
  },
);

it.each(['continue', 'change-approach'] as const)(
  'rejects %s settlement after a terminal outcome while retaining accounting',
  (decision) => {
    const terminal = launched();
    terminal.outcome = 'cancelled';
    terminal.outcomeRef = 'authority-revoked';
    const db = openDb(paths.neondeckDatabase);
    db.prepare(
      'UPDATE factory_delivery_pipelines SET record_json=? WHERE pipeline_id=?',
    ).run(JSON.stringify(terminal), terminal.pipelineId);
    db.close();
    expect(() =>
      settle(terminal, {
        result: {
          ...result(terminal),
          decision,
          nextInstructions:
            decision === 'change-approach' ? 'Correct the fixture' : null,
        },
      }),
    ).toThrow('terminal');
    expect(getDeliveryPipeline(terminal.pipelineId, paths)).toEqual(terminal);
    const accounted = settle(terminal, { result: null });
    expect(accounted.progress.assessments[0]!.executionMs).toBe(1200);
    expect(accounted.progress.assessments[0]!.result).toBeNull();
  },
);
