import { approveTestPublication } from './publication.test-helper';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyFactorySpec } from '../../../shared/factory';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import {
  reserveDeliveryPipeline,
  deliveryBudget,
  deliveryValidationContractDigest,
} from './store';
import {
  changeDelivery,
  requireDelivery,
  deliveryReceipt,
} from './service-records';
import { classifyFeedback, bindSettledFeedback } from './watch-feedback';
import { ReviewerTerminalError } from './reviewer';
const io = vi.hoisted(() => ({
  classify:
    vi.fn<typeof import('./reviewer-feedback').classifyFactoryFeedback>(),
  capture: vi.fn<typeof import('./evidence').captureCandidateEvidence>(),
  authority: vi.fn<
    () => {
      run: Record<string, never>;
      reviewerModel: string;
      authority: { revision: { spec: ReturnType<typeof emptyFactorySpec> } };
    }
  >(),
}));
vi.mock('./authority', () => ({ assertDeliveryAuthority: io.authority }));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  captureCandidateEvidence: io.capture,
}));
vi.mock('./reviewer-feedback', () => ({
  classifyFactoryFeedback: io.classify,
}));
vi.mock('../factory', async (original) => ({
  ...(await original<typeof import('../factory')>()),
  codingHandle: () => ({ directory: '/fixture', attemptToken: 'fixture' }),
}));
let paths: ReturnType<typeof runtimePaths>;
let id: string;
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
const fingerprint = 'f'.repeat(64);
const effectId = `feedback-review:${fingerprint}`;
const candidate = {
  attemptId: revision.attemptId,
  repoId: 'repo',
  worktreeId: 'worktree',
  root: '/fixture',
  baseSha: revision.baseSha,
  headSha: revision.headSha,
  revision: revision.treeSha,
  treeSha: revision.treeSha,
  evidenceDigest: revision.candidateDigest,
  statusHash: '1'.repeat(64),
  diffHash: '2'.repeat(64),
  untrackedHash: '3'.repeat(64),
};
const report = {
  evidenceDigest: revision.candidateDigest,
  revision: revision.treeSha,
  outcome: 'no-action' as const,
  summary: 'No change requested.',
  findings: [],
  feedbackFingerprint: fingerprint,
  submissionId: 'submission',
  totalTokens: 10,
  durationMs: 5,
};
const current = () => requireDelivery(id, paths);
const change = (action: Parameters<typeof changeDelivery>[1]) =>
  changeDelivery(id, action, paths);
function feedback(body = 'Please inspect the existing boundary.') {
  change({
    type: 'record-feedback',
    feedback: {
      id: 'feedback',
      fingerprint,
      revision,
      publishedHeadSha: revision.headSha,
      ciFailed: false,
      hasReviewFeedback: true,
      evidenceRef: deliveryReceipt(id, { feedbackBody: body }, paths),
    },
  });
}
const classify = () =>
  classifyFeedback(current(), current().feedback[0]!, paths);
function plan() {
  change({
    type: 'plan-effect',
    id: effectId,
    kind: 'feedback-review',
    maxExecutionMs: 1000,
  });
}
function delivered(value: unknown = report) {
  plan();
  change({ type: 'start-effect', id: effectId });
  change({
    type: 'settle-effect',
    id: effectId,
    state: 'delivered',
    executionMs: 5,
    receiptRef: deliveryReceipt(id, value, paths),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'feedback-crash-')));
  mkdirSync(dirname(paths.neondeckDatabase), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  id = reserveDeliveryPipeline(
    {
      workItemId: 'work',
      repoId: 'repo',
      initialRevision: revision,
      authorization: {
        mode: 'local-validation',
        id: 'grant',
        authorizedBy: 'human',
        authorizedAt: '2026-09-06T00:00:00.000Z',
        revision,
        repoId: 'repo',
        target: { owner: 'test', name: 'repo', baseBranch: 'main' },
        configFingerprint: '4'.repeat(64),
        checkCommands: ['npm test'],
        maxRepairAttempts: 2,
        totalExecutionMs: 10800000,
        initialExecutionMs: 100,
      },
    },
    paths,
  ).pipelineId;
  for (const kind of ['verification', 'review'] as const) {
    const details =
      kind === 'verification'
        ? {
            evidenceDigest: revision.candidateDigest,
            revision: revision.treeSha,
            passed: true,
            noWriter: true,
            durationMs: 5,
            checks: [
              {
                command: 'npm test',
                passed: true,
                exitCode: 0,
                truncated: false,
                durationMs: 5,
                evidenceRef: 'log',
                outputHash: '5'.repeat(64),
              },
            ],
          }
        : {};
    const ref = deliveryReceipt(id, { details }, paths);
    change({ type: 'plan-effect', id: kind, kind, maxExecutionMs: 1000 });
    change({ type: 'start-effect', id: kind });
    change({
      type: 'record-evidence',
      evidence: {
        id: kind,
        kind,
        revision,
        producerId: kind,
        result: 'passed',
        evidenceRef: ref,
        effectId: kind,
        validationContractDigest: deliveryValidationContractDigest(current()),
        bundleDigest: (kind === 'verification' ? '6' : '7').repeat(64),
        verificationEvidenceId: kind === 'review' ? 'verification' : null,
        verificationBundleDigest: kind === 'review' ? '6'.repeat(64) : null,
      },
    });
    change({
      type: 'settle-effect',
      id: kind,
      state: 'delivered',
      receiptRef: ref,
      executionMs: 5,
    });
  }
  approveTestPublication(current(), paths);
  change({ type: 'plan-effect', id: 'commit', kind: 'commit' });
  change({ type: 'start-effect', id: 'commit' });
  change({
    type: 'bind-commit',
    treeSha: revision.treeSha,
    publishedHeadSha: revision.headSha,
    evidenceRef: 'commit',
  });
  change({
    type: 'settle-effect',
    id: 'commit',
    state: 'delivered',
    receiptRef: 'commit',
  });
  io.capture.mockResolvedValue(candidate);
  io.authority.mockReturnValue({
    run: {},
    reviewerModel: 'fixture',
    authority: { revision: { spec: emptyFactorySpec() } },
  });
  io.classify.mockResolvedValue(report);
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));

it('resumes a planned-before-start crash using its existing budget exactly once', async () => {
  feedback();
  plan();
  const count = current().effects.length;
  await classify();
  expect(io.classify).toHaveBeenCalledTimes(1);
  expect(io.classify.mock.calls[0]![0]).toMatchObject({
    id: `${id}:${effectId}`,
    maxDurationMs: 1000,
  });
  expect(current().effects).toHaveLength(count);
  expect(current().effects.at(-1)).toMatchObject({
    state: 'delivered',
    reservedExecutionMs: 1000,
    executionMs: 5,
  });
  expect(current().feedback[0]?.classification?.result).toBe('no-action');
  await classify();
  expect(io.classify).toHaveBeenCalledTimes(1);
});
it('binds a settled-before-classification crash without model redispatch and replays idempotently', async () => {
  feedback();
  delivered();
  await classify();
  const version = current().version;
  expect(bindSettledFeedback(id, 'feedback', paths)).toBe(true);
  expect(current().version).toBe(version);
  expect(io.classify).not.toHaveBeenCalled();
});
it('retries receipt binding after a transient intervention is resolved', async () => {
  feedback();
  delivered();
  change({
    type: 'intervene',
    id: 'transient',
    kind: 'uncertainty',
    reason: 'Inspection pending',
  });
  expect(() => bindSettledFeedback(id, 'feedback', paths)).toThrow(
    'Delivery needs intervention',
  );
  change({
    type: 'resolve-intervention',
    id: 'transient',
    resolution: 'Inspection completed',
  });
  await classify();
  expect(current().feedback[0]?.classification).not.toBeNull();
  expect(io.classify).not.toHaveBeenCalled();
});
it.each(['in-flight', 'uncertain'] as const)(
  'never redispatches %s admission',
  async (state) => {
    feedback();
    plan();
    change({ type: 'start-effect', id: effectId });
    if (state === 'uncertain')
      change({
        type: 'settle-effect',
        id: effectId,
        state,
        receiptRef: 'unknown',
      });
    await classify();
    expect(io.classify).not.toHaveBeenCalled();
    expect(current().effects.at(-1)?.state).toBe(state);
  },
);
it.each([16001, 24000])(
  'rejects %i-character feedback before reserving or starting any effect',
  async (size) => {
    feedback('x'.repeat(size));
    const budget = deliveryBudget(current());
    await classify();
    expect(current().effects.some((e) => e.id === effectId)).toBe(false);
    expect(deliveryBudget(current())).toEqual(budget);
    expect(current().interventions.at(-1)).toMatchObject({
      kind: 'scope',
      resolution: null,
    });
    expect(io.classify).not.toHaveBeenCalled();
  },
);
it('validates the complete packet before admission, beyond just feedback length', async () => {
  feedback();
  io.authority.mockReturnValue({
    run: {},
    reviewerModel: 'x'.repeat(201),
    authority: { revision: { spec: emptyFactorySpec() } },
  });
  await classify();
  expect(current().effects.some((e) => e.id === effectId)).toBe(false);
  expect(current().interventions.at(-1)?.kind).toBe('scope');
  expect(io.classify).not.toHaveBeenCalled();
});
it('rejects a delivered report bound to different feedback without redispatch', async () => {
  feedback();
  delivered({ ...report, feedbackFingerprint: '9'.repeat(64) });
  await expect(classify()).rejects.toThrow('binding mismatch');
  expect(current().feedback[0]?.classification).toBeNull();
  expect(io.classify).not.toHaveBeenCalled();
});
it('settles known failed reviewer usage conservatively in the same attempt', async () => {
  feedback();
  io.classify.mockRejectedValue(
    new ReviewerTerminalError('failed', 'submission', 180000),
  );
  await classify();
  expect(current().effects.at(-1)).toMatchObject({
    state: 'delivered',
    executionMs: null,
  });
  expect(current().interventions).toHaveLength(1);
  expect(current().feedback[0]?.classification).toBeNull();
});

it('accepts the shared 16000-character boundary before one dispatch', async () => {
  feedback('x'.repeat(16000));
  await classify();
  expect(io.classify).toHaveBeenCalledTimes(1);
  expect(current().feedback[0]?.classification?.result).toBe('no-action');
});
it('resuming planned work still applies the normal intervention guard', async () => {
  feedback();
  plan();
  change({
    type: 'intervene',
    id: 'pause',
    kind: 'uncertainty',
    reason: 'Inspection pending',
  });
  await expect(classify()).rejects.toThrow('Delivery needs intervention');
  expect(io.classify).not.toHaveBeenCalled();
  expect(current().effects.at(-1)?.state).toBe('planned');
});
