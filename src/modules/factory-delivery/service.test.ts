import { approveTestPublication } from './publication.test-helper';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { reserveDeliveryPipeline, getDeliveryPipeline } from './store';
import { advanceFactoryDelivery, tickFactoryDelivery } from './service';
import {
  feedbackRepairInstructions,
  RepairContextTooLargeError,
} from './delivery-repair-context';
import { interveneDelivery, deliveryReceipt } from './service-records';
import { deliveryIO, type DeliveryIO } from './delivery-io';
import type { DeliveryReservation } from '../../../shared/factory-delivery';

let home: string;
let paths: ReturnType<typeof runtimePaths>;
const revision = {
  runId: 'run',
  attemptId: 'attempt',
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
    mode: 'local-validation',
    id: 'human-grant',
    authorizedBy: 'human',
    authorizedAt: '2026-09-06T00:00:00.000Z',
    revision,
    repoId: 'repo',
    target: { owner: 'test', name: 'repo', baseBranch: 'main' },
    configFingerprint: 'f'.repeat(64),
    checkCommands: ['npm run check'],
    maxRepairAttempts: 2,
    totalExecutionMs: 10800000,
    initialExecutionMs: 1000,
  },
};
const candidate = {
  attemptId: 'attempt',
  repoId: 'repo',
  worktreeId: 'workspace',
  root: '/private/tmp/candidate',
  baseSha: revision.baseSha,
  headSha: revision.headSha,
  revision: revision.treeSha,
  treeSha: revision.treeSha,
  evidenceDigest: revision.candidateDigest,
  statusHash: '1'.repeat(64),
  diffHash: '2'.repeat(64),
  untrackedHash: '3'.repeat(64),
};
function fakeIO(): DeliveryIO {
  return {
    recoverProgress: vi.fn(async () => false),
    assert: vi.fn(async () => {}),
    capture: vi.fn(async () => candidate),
    verify: vi.fn(async () => ({
      producerId: 'independent-check',
      result: 'passed' as const,
      durationMs: 15,
      details: { check: 'passed' },
    })),
    review: vi.fn(async () => ({
      producerId: 'independent-review',
      result: 'passed' as const,
      durationMs: 20,
      details: { review: 'passed' },
    })),
    commit: vi.fn(async () => ({
      publishedHeadSha: '9'.repeat(40),
      treeSha: revision.treeSha,
    })),
    push: vi.fn(async () => ({ remoteSha: '9'.repeat(40) })),
    createPr: vi.fn(async () => ({
      number: 7,
      url: 'https://github.com/test/repo/pull/7',
    })),
    recover: vi.fn(async () => {}),
    observeOutcome: vi.fn(async () => {}),
    watch: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {}),
    repair: vi.fn(async () => {}),
    reconcileRepair: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delivery-service-'));
  paths = runtimePaths(home);
  mkdirSync(join(home, 'data'), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
it('delivers one draft only after durable independent evidence and commit/tree binding', async () => {
  const p = reserveDeliveryPipeline(reservation, paths),
    io = fakeIO();
  for (let i = 0; i < 7; i++)
    await advanceWithPublication(p.pipelineId, paths, io);
  const actual = getDeliveryPipeline(p.pipelineId, paths)!;
  expect(actual.pr?.number).toBe(7);
  expect(actual.evidence.map((e) => e.kind)).toEqual([
    'verification',
    'review',
  ]);
  expect(actual.effects.every((e) => e.state === 'delivered')).toBe(true);
  expect(actual.evidence[1]!.verificationBundleDigest).toBe(
    actual.evidence[0]!.bundleDigest,
  );
  expect(io.createPr).toHaveBeenCalledTimes(1);
  expect(io.commit).toHaveBeenCalledTimes(1);
  expect(io.watch).toHaveBeenCalled();
});
it('claims before IO and keeps a lost POST uncertain without another POST', async () => {
  const p = reserveDeliveryPipeline(reservation, paths),
    io = fakeIO();
  io.createPr = vi.fn(async () => {
    expect(
      getDeliveryPipeline(p.pipelineId, paths)!.effects.at(-1)!.state,
    ).toBe('in-flight');
    throw new Error('response lost');
  });
  for (let i = 0; i < 8; i++)
    await advanceWithPublication(p.pipelineId, paths, io);
  expect(io.createPr).toHaveBeenCalledTimes(1);
  expect(getDeliveryPipeline(p.pipelineId, paths)!.effects.at(-1)!.state).toBe(
    'uncertain',
  );
  expect(io.recover).toHaveBeenCalled();
});
it('revocation between durable admission and IO fences checks and retains the claim', async () => {
  const p = reserveDeliveryPipeline(reservation, paths),
    io = fakeIO();
  let calls = 0;
  io.assert = vi.fn(async () => {
    calls++;
    if (calls === 3) {
      interveneDelivery(p.pipelineId, 'authority', 'Revoked by human', paths);
      throw new Error('revoked');
    }
  });
  await advanceWithPublication(p.pipelineId, paths, io);
  expect(io.verify).not.toHaveBeenCalled();
  expect(getDeliveryPipeline(p.pipelineId, paths)!.effects.at(-1)!.state).toBe(
    'planned',
  );
  await advanceWithPublication(p.pipelineId, paths, io);
  expect(io.cancel).toHaveBeenCalled();
});
it('concurrent controller calls share a local promise while durable claim prevents duplicate admission', async () => {
  const p = reserveDeliveryPipeline(reservation, paths),
    io = fakeIO();
  await Promise.all([
    advanceFactoryDelivery(p.pipelineId, paths, io),
    advanceFactoryDelivery(p.pipelineId, paths, io),
  ]);
  expect(io.verify).toHaveBeenCalledTimes(1);
});
it('does not auto-grant existing candidates during a tick', async () => {
  const io = fakeIO();
  await tickFactoryDelivery(paths, io);
  expect(io.capture).not.toHaveBeenCalled();
  expect(io.createPr).not.toHaveBeenCalled();
});

it('visits pages beyond100 and isolates one authority failure', async () => {
  const io = fakeIO();
  for (let i = 0; i < 101; i++) {
    const rev = {
      ...revision,
      runId: `run-${i}`,
      attemptId: `attempt-${i}`,
      releaseId: `release-${i}`,
    };
    reserveDeliveryPipeline(
      {
        ...reservation,
        initialRevision: rev,
        authorization: {
          mode: 'local-validation',
          ...reservation.authorization,
          id: `grant-${i}`,
          revision: rev,
        },
      },
      paths,
    );
  }
  io.assert = vi.fn(async (p) => {
    if (p.revision.runId === 'run-0') throw new Error('stale authority');
  });
  await tickFactoryDelivery(paths, io);
  expect(io.verify).toHaveBeenCalledTimes(100);
});

it('retains a legal oversized full findings report and durably asks for human planning', async () => {
  const p = reserveDeliveryPipeline(reservation, paths),
    io = fakeIO();
  const details = {
    evidenceDigest: revision.candidateDigest,
    revision: revision.treeSha,
    outcome: 'findings',
    summary: 'All findings require attention.',
    findings: Array.from({ length: 6 }, (_, i) => ({
      severity: 'high',
      path: `src/file${i}.ts`,
      line: 1,
      description: 'x'.repeat(3500),
    })),
    submissionId: 'reviewer',
    totalTokens: 12000,
    durationMs: 20,
  };
  io.review = vi.fn(async () => ({
    producerId: 'reviewer',
    result: 'failed' as const,
    durationMs: 20,
    details,
  }));
  for (let i = 0; i < 4; i++)
    await advanceWithPublication(p.pipelineId, paths, io);
  const actual = getDeliveryPipeline(p.pipelineId, paths)!;
  expect(actual.interventions.at(-1)).toMatchObject({
    kind: 'scope',
    resolution: null,
  });
  expect(actual.interventions.at(-1)?.reason).toContain(
    'Full evidence is retained',
  );
  expect(io.repair).not.toHaveBeenCalled();
  expect(
    JSON.parse(readFileSync(actual.evidence.at(-1)!.evidenceRef, 'utf8'))
      .details,
  ).toEqual(details);
});
it.each(['scope', 'budget'] as const)(
  'observes an existing PR while %s paused without mutation admission',
  async (kind) => {
    const p = reserveDeliveryPipeline(reservation, paths),
      io = fakeIO();
    for (let i = 0; i < 6; i++)
      await advanceWithPublication(p.pipelineId, paths, io);
    interveneDelivery(p.pipelineId, kind, 'Human planning needed', paths);
    vi.mocked(io.assert).mockClear();
    await advanceWithPublication(p.pipelineId, paths, io);
    expect(io.observeOutcome).toHaveBeenCalledOnce();
    expect(io.assert).not.toHaveBeenCalled();
    expect(io.repair).not.toHaveBeenCalled();
  },
);

it('rejects a legal oversized scoped feedback packet explicitly without truncating its receipt', () => {
  const report = {
    evidenceDigest: revision.candidateDigest,
    revision: revision.treeSha,
    outcome: 'scoped-repair',
    summary: 'Address every finding.',
    findings: Array.from({ length: 6 }, () => ({
      severity: 'high',
      path: 'src/a.ts',
      line: 1,
      description: 'x'.repeat(3500),
    })),
    feedbackFingerprint: 'a'.repeat(64),
    submissionId: 'feedback-reviewer',
    totalTokens: 12000,
    durationMs: 20,
  };
  const ref = deliveryReceipt('a'.repeat(64), report, paths);
  expect(() =>
    feedbackRepairInstructions({
      ciFailed: false,
      evidenceRef: ref,
      classification: { result: 'scoped-repair', evidenceRef: ref },
    }),
  ).toThrow(RepairContextTooLargeError);
  expect(JSON.parse(readFileSync(ref, 'utf8'))).toEqual(report);
});

it('records known nonadmission when post-start authority rejects before push IO dispatch', async () => {
  const p = reserveDeliveryPipeline(reservation, paths),
    io = fakeIO();
  for (let i = 0; i < 3; i++)
    await advanceWithPublication(p.pipelineId, paths, io);
  io.assert = vi.fn<DeliveryIO['assert']>(async (current) => {
    if (
      current.effects.some((e) => e.kind === 'push' && e.state === 'in-flight')
    )
      throw new Error('revoked before dispatch');
  });
  await advanceWithPublication(p.pipelineId, paths, io);
  const paused = getDeliveryPipeline(p.pipelineId, paths)!;
  expect(io.push).not.toHaveBeenCalled();
  expect(paused.effects.at(-1)?.state).toBe('planned');
  expect(paused.interventions.at(-1)?.reason).toContain('not dispatched');
  await advanceWithPublication(p.pipelineId, paths, io);
  expect(io.recover).not.toHaveBeenCalled();
});
it('records known nonadmission when outer push preparation rejects before an intent exists', async () => {
  const p = reserveDeliveryPipeline(reservation, paths),
    io = fakeIO();
  for (let i = 0; i < 3; i++)
    await advanceWithPublication(p.pipelineId, paths, io);
  // The fake commit receipt intentionally lacks a publication workspace: real IO must reject before any Git.
  io.push = deliveryIO.push;
  await advanceWithPublication(p.pipelineId, paths, io);
  const paused = getDeliveryPipeline(p.pipelineId, paths)!;
  expect(paused.effects.at(-1)?.state).toBe('planned');
  expect(paused.interventions.at(-1)?.kind).toBe('scope');
});

it('local validation waits without publishing and explicit publication preserves the original budget', async () => {
  const p = reserveDeliveryPipeline(
    {
      ...reservation,
      authorization: { ...reservation.authorization, mode: 'local-validation' },
    },
    paths,
  );
  const io = fakeIO();
  for (let i = 0; i < 5; i++)
    await advanceFactoryDelivery(p.pipelineId, paths, io);
  const clean = getDeliveryPipeline(p.pipelineId, paths)!;
  expect(clean.evidence.map((e) => e.result)).toEqual(['passed', 'passed']);
  expect(clean.effects.map((e) => e.kind)).toEqual(['verification', 'review']);
  expect(io.commit).not.toHaveBeenCalled();
  expect(io.push).not.toHaveBeenCalled();
  expect(io.createPr).not.toHaveBeenCalled();
  const { publicationEvidenceFingerprint, deliveryBudget, awaitsPublication } =
    await import('./delivery-aggregate');
  const { changeDelivery } = await import('./service-records');
  expect(awaitsPublication(clean)).toBe(true);
  expect(() =>
    changeDelivery(
      p.pipelineId,
      { type: 'plan-effect', id: 'unauthorized', kind: 'commit' },
      paths,
    ),
  ).toThrow(/publication authorization/);
  const before = deliveryBudget(clean);
  const grant = {
    requestId: 'publish',
    requestFingerprint: '9'.repeat(64),
    authorizedBy: 'human',
    authorizedAt: new Date().toISOString(),
    revision: clean.revision,
    evidenceFingerprint: publicationEvidenceFingerprint(clean),
    configFingerprint: '8'.repeat(64),
    target: clean.authorization.target,
  };
  const approved = changeDelivery(
    p.pipelineId,
    { type: 'authorize-publication', grant },
    paths,
  );
  expect(deliveryBudget(approved)).toEqual(before);
  expect(approved.authorization).toEqual(clean.authorization);
  expect(
    changeDelivery(
      p.pipelineId,
      { type: 'authorize-publication', grant },
      paths,
    ),
  ).toEqual(approved);
  expect(() =>
    changeDelivery(
      p.pipelineId,
      { type: 'authorize-publication', grant: { ...grant, requestId: 'new' } },
      paths,
    ),
  ).toThrow(/Conflicting publication replay/);
  for (let i = 0; i < 5; i++)
    await advanceFactoryDelivery(p.pipelineId, paths, io);
  const published = getDeliveryPipeline(p.pipelineId, paths)!;
  expect(published.pr?.number).toBe(7);
  expect(published.publication).toEqual(grant);
  expect(io.createPr).toHaveBeenCalledTimes(1);
  expect(deliveryBudget(published)).toEqual(before);
});
it('publication grant rejects missing checks, stale candidate and altered evidence', async () => {
  const p = reserveDeliveryPipeline(
    {
      ...reservation,
      authorization: { ...reservation.authorization, mode: 'local-validation' },
    },
    paths,
  );
  const { publicationEvidenceFingerprint } =
    await import('./delivery-aggregate');
  const { changeDelivery } = await import('./service-records');
  const grant = {
    requestId: 'publish',
    requestFingerprint: '9'.repeat(64),
    authorizedBy: 'human',
    authorizedAt: new Date().toISOString(),
    revision: p.revision,
    evidenceFingerprint: publicationEvidenceFingerprint(p),
    configFingerprint: '8'.repeat(64),
    target: p.authorization.target,
  };
  expect(() =>
    changeDelivery(
      p.pipelineId,
      { type: 'authorize-publication', grant },
      paths,
    ),
  ).toThrow(/independent verification/);
  const io = fakeIO();
  await advanceFactoryDelivery(p.pipelineId, paths, io);
  await advanceFactoryDelivery(p.pipelineId, paths, io);
  expect(() =>
    changeDelivery(
      p.pipelineId,
      { type: 'authorize-publication', grant },
      paths,
    ),
  ).toThrow(/evidence or target changed/);
  const clean = getDeliveryPipeline(p.pipelineId, paths)!;
  expect(() =>
    changeDelivery(
      p.pipelineId,
      {
        type: 'authorize-publication',
        grant: {
          ...grant,
          evidenceFingerprint: publicationEvidenceFingerprint(clean),
          revision: { ...clean.revision, treeSha: '0'.repeat(40) },
        },
      },
      paths,
    ),
  ).toThrow(/evidence or target changed/);
});
it('retains historical pipeline history but never starts validation or publication', async () => {
  const p = reserveDeliveryPipeline(
    {
      ...reservation,
      authorization: { ...reservation.authorization, mode: undefined },
    },
    paths,
  );
  const io = fakeIO();
  await advanceFactoryDelivery(p.pipelineId, paths, io);
  expect(io.verify).not.toHaveBeenCalled();
  expect(io.commit).not.toHaveBeenCalled();
  expect(io.repair).not.toHaveBeenCalled();
  expect(getDeliveryPipeline(p.pipelineId, paths)).toEqual(p);
});

async function advanceWithPublication(
  id: string,
  paths: ReturnType<typeof runtimePaths>,
  io: DeliveryIO,
) {
  const p = getDeliveryPipeline(id, paths)!;
  const { awaitsPublication } = await import('./delivery-aggregate');
  if (awaitsPublication(p)) approveTestPublication(p, paths);
  return advanceFactoryDelivery(id, paths, io);
}

it('pauses a paid setup failure until explicit same-candidate retry, retaining prior evidence and never repairing setup', async () => {
  const { retryFactoryEnvironmentSetup } = await import('./environment-retry');
  const workflow = {
    id: 'test',
    name: 'Test',
    setupCommands: [{ command: 'npm ci', cwd: '.' }],
    validationCommands: [{ command: 'npm run check', cwd: '.' }],
    setupTimeoutMs: 60000,
    validationTimeoutMs: 60000,
    runtime: {},
    environmentRefs: [],
  };
  const created = reserveDeliveryPipeline(
    {
      ...reservation,
      authorization: { ...reservation.authorization, workflow },
    },
    paths,
  );
  const io = fakeIO();
  io.verify = vi.fn(async () => ({
    producerId: 'setup-check',
    result: 'blocked' as const,
    durationMs: 125,
    details: {
      evidenceDigest: revision.candidateDigest,
      revision: revision.treeSha,
      passed: false,
      noWriter: true,
      durationMs: 125,
      checks: [],
      setup: {
        passed: false,
        checks: [
          {
            command: 'npm ci',
            passed: false,
            exitCode: 1,
            truncated: false,
            durationMs: 125,
            evidenceRef: null,
            outputHash: null,
          },
        ],
      },
    },
  }));
  await advanceFactoryDelivery(created.pipelineId, paths, io);
  let current = getDeliveryPipeline(created.pipelineId, paths)!;
  expect(current.interventions).toMatchObject([
    { kind: 'environment', resolution: null },
  ]);
  expect(current.effects[0]).toMatchObject({
    state: 'delivered',
    executionMs: 125,
  });
  expect(io.review).not.toHaveBeenCalled();
  expect(io.repair).not.toHaveBeenCalled();
  await advanceFactoryDelivery(created.pipelineId, paths, io);
  expect(io.verify).toHaveBeenCalledTimes(1);
  const retained = current.evidence[0];
  const policy = {
    version: 'local-validation-v1' as const,
    configFingerprint: current.authorization.configFingerprint,
    checkCommands: current.authorization.checkCommands,
    workflow,
    reviewerModel: 'test',
    reviewerThinkingLevel: null,
    maxRepairAttempts: 2 as const,
    totalExecutionMs: 10800000 as const,
  };
  const deps = {
    checkout: vi.fn(async () => {}),
    policy: () => policy,
    detail: vi.fn(
      () =>
        ({}) as ReturnType<
          typeof import('./service-operator').factoryDeliveryDetail
        >,
    ),
    assert: vi.fn(() => ({}) as never),
    capture: async () => candidate,
  };
  await expect(
    retryFactoryEnvironmentSetup(
      current.pipelineId,
      { expectedVersion: current.version, reason: 'Environment ready' },
      paths,
      {
        ...deps,
        policy: () => ({
          ...policy,
          workflow: { ...workflow, setupCommands: [] },
        }),
      },
    ),
  ).rejects.toThrow('changed');
  expect(getDeliveryPipeline(created.pipelineId, paths)!.version).toBe(
    current.version,
  );
  await retryFactoryEnvironmentSetup(
    current.pipelineId,
    { expectedVersion: current.version, reason: 'Environment ready' },
    paths,
    deps,
  );
  io.verify = vi.fn(async () => ({
    producerId: 'retry-check',
    result: 'passed' as const,
    durationMs: 75,
    details: {
      evidenceDigest: revision.candidateDigest,
      revision: revision.treeSha,
      passed: true,
      noWriter: true,
      durationMs: 75,
      checks: [],
      setup: { passed: true, checks: [] },
    },
  }));
  await advanceFactoryDelivery(created.pipelineId, paths, io);
  current = getDeliveryPipeline(created.pipelineId, paths)!;
  expect(io.verify).toHaveBeenCalledTimes(1);
  expect(current.revision).toEqual(revision);
  expect(current.evidence[0]).toEqual(retained);
  expect(current.evidence).toHaveLength(2);
  expect(current.effects.map((e) => e.id)).toEqual([
    `verification:${revision.candidateDigest}`,
    `verification:${revision.candidateDigest}:setup-retry-1`,
  ]);
  expect(current.effects.map((e) => e.executionMs)).toEqual([125, 75]);
  expect(io.review).not.toHaveBeenCalled();
  expect(io.repair).not.toHaveBeenCalled();
  await advanceFactoryDelivery(created.pipelineId, paths, io);
  expect(io.review).toHaveBeenCalledTimes(1);
});
