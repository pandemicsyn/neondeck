import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { validationPolicySchema } from '../../../shared/factory-delivery';
import { assertDeliveryAuthority, localValidationContext } from './authority';
import type { ValidationAdmissionAttention } from '../../../shared/factory-coding';
import { CodingAuthorityChangedError } from '../factory/index';
import { CandidateEvidenceError } from './evidence-errors';
import {
  admitReleasedValidation,
  retryReleasedValidation,
} from './validation-service';
import { listDeliveryPipelines } from './store';
import {
  deliveryBudget,
  publicationEvidenceFingerprint,
} from './delivery-aggregate';

const state = vi.hoisted(() => {
  const policy = {
    version: 'local-validation-v1' as const,
    configFingerprint: 'a'.repeat(64),
    checkCommands: ['npm test'],
    reviewerModel: 'faux/faux-1',
    reviewerThinkingLevel: 'off' as const,
    maxRepairAttempts: 2 as const,
    totalExecutionMs: 10800000 as const,
  };
  return {
    policy,
    historical: false,
    revoked: false,
    currentPolicy: vi.fn(() => policy),
    attentionValue: null as ValidationAdmissionAttention | null,
    captureFailure: null as Error | null,
    authorityFailure: null as Error | null,
    usage: 1234 as number | null,
    attention: vi.fn(),
    publicationFingerprint: 'f'.repeat(64),
  };
});
const run = vi.hoisted(() => ({
  version: 1,
  runId: 'run',
  attemptId: 'attempt',
  status: 'candidate',
  candidate: {},
  deadProof: {},
  workspace: {},
  snapshot: {
    workItemId: 'work',
    repoId: 'repo',
    releaseId: 'release',
    specVersion: 1,
    specHash: 'b'.repeat(64),
  },
}));
vi.mock('../coding-runs', async (original) => ({
  ...(await original<typeof import('../coding-runs')>()),
  getCodingRun: () => run,
  listCodingRuns: () => [{ sequence: 1, record: run }],
}));
vi.mock('../factory/validation-policy', () => ({
  factoryValidationPolicy: state.currentPolicy,
}));
vi.mock('../factory', async (original) => ({
  ...(await original<typeof import('../factory')>()),
  assertCodingAuthoritySnapshot: () => {
    if (state.authorityFailure) throw state.authorityFailure;
    if (state.revoked) throw new Error('Frozen coding authority changed.');
    return {
      repo: {
        id: 'repo',
        github: { owner: 'test', name: 'repo' },
        defaultBranch: 'main',
      },
      coding: { wallTimeMs: 2700000 },
      release: {
        validationPolicy: state.historical
          ? undefined
          : v.parse(validationPolicySchema, state.policy),
      },
    };
  },
  getFactoryWork: () => ({
    releases: [
      {
        id: 'release',
        actor: 'human',
        withdrawnAt: state.revoked ? '2026-09-07' : null,
        validationPolicy: state.historical ? undefined : state.policy,
      },
    ],
  }),
  publicCodingRun: (record: unknown) => ({ record }),
  codingHandle: () => ({}),
  readCodingExecutionUsage: async () => state.usage,
  readValidationAttention: () => state.attentionValue,
  clearValidationAttention: () => {
    state.attentionValue = null;
  },
  saveValidationAttention: state.attention,
}));
vi.mock('./evidence', () => ({
  captureCandidateEvidence: async () => {
    if (state.captureFailure) throw state.captureFailure;
    return {
      evidenceDigest: 'c'.repeat(64),
      treeSha: 'd'.repeat(40),
      baseSha: 'e'.repeat(40),
      headSha: 'e'.repeat(40),
    };
  },
}));
vi.mock('./service-operator', () => ({
  factoryDeliveryDetail: (p: unknown) => p,
}));
vi.mock('./publication-context', () => ({
  resolvePublicationContext: () => ({
    configFingerprint: state.publicationFingerprint,
    target: { owner: 'test', name: 'repo', baseBranch: 'main' },
    connection: { repositoryId: '42' },
  }),
}));
let paths: ReturnType<typeof runtimePaths>;
beforeEach(() => {
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'frozen-validation-')));
  mkdirSync(join(paths.home, 'data'), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  state.historical = false;
  state.revoked = false;
  state.publicationFingerprint = 'f'.repeat(64);
  state.currentPolicy.mockReset().mockReturnValue(state.policy);
  state.attentionValue = null;
  state.captureFailure = null;
  state.authorityFailure = null;
  state.usage = 1234;
  state.attention.mockReset().mockImplementation((_runId, attention) => {
    state.attentionValue = attention;
  });
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));

it('resolves the released local validation policy without intake configuration', () => {
  expect(localValidationContext('run', paths)).toMatchObject({
    validationPolicy: state.policy,
    checkCommands: ['npm test'],
    reviewerModel: 'faux/faux-1',
    reviewerThinkingLevel: 'off',
    target: { owner: 'test', name: 'repo', baseBranch: 'main' },
  });
});
it('historical releases require a fresh release rather than extra grant', () => {
  state.historical = true;
  expect(() => localValidationContext('run', paths)).toThrow(/fresh release/);
});

const configChanges = [
  'coding',
  'reviewer',
  'checks',
  'unconfigured reviewer',
] as const;
function changeCurrentConfig(kind: (typeof configChanges)[number]) {
  if (kind === 'unconfigured reviewer') {
    state.currentPolicy.mockImplementation(() => {
      throw new Error('Configure an independent reviewer model');
    });
  } else {
    state.currentPolicy.mockReturnValue({
      ...state.policy,
      configFingerprint: '9'.repeat(64),
      ...(kind === 'reviewer' ? { reviewerModel: 'faux/new-reviewer' } : {}),
      ...(kind === 'checks'
        ? { checkCommands: ['npm run different-check'] }
        : {}),
    });
  }
}
it.each(configChanges)(
  'automatically admits the frozen release after changing %s settings',
  async (kind) => {
    changeCurrentConfig(kind);
    await admitReleasedValidation(paths);
    const rows = listDeliveryPipelines({}, paths);
    expect(rows).toHaveLength(1);
    const pipeline = rows[0]!.record;
    expect(pipeline.authorization).toMatchObject({
      id: 'release-validation:release',
      configFingerprint: state.policy.configFingerprint,
      checkCommands: state.policy.checkCommands,
      maxRepairAttempts: 2,
      totalExecutionMs: 10800000,
      initialExecutionMs: 1234,
    });
    expect(pipeline.publication).toBeUndefined();
    expect(pipeline.coordinator.candidateRef).toBeTruthy();
    expect(state.attention).not.toHaveBeenCalled();
    expect(state.currentPolicy).not.toHaveBeenCalled();
    await admitReleasedValidation(paths);
    expect(listDeliveryPipelines({}, paths)[0]!.record).toEqual(pipeline);
  },
);
it.each(configChanges)(
  'retains active validation and watched PR authority after changing %s settings',
  async (kind) => {
    await admitReleasedValidation(paths);
    const pipeline = listDeliveryPipelines({}, paths)[0]!.record;
    const budget = deliveryBudget(pipeline);
    changeCurrentConfig(kind);
    expect(assertDeliveryAuthority(pipeline, paths)).toMatchObject({
      validationPolicy: state.policy,
      reviewerModel: state.policy.reviewerModel,
      checkCommands: state.policy.checkCommands,
      connection: null,
      authority: { coding: { wallTimeMs: 2700000 } },
    });
    // Exercise the real publication-consent fence with an exact synthetic receipt.
    pipeline.publication = {
      requestId: 'publish',
      requestFingerprint: '7'.repeat(64),
      authorizedBy: 'human',
      authorizedAt: '2026-09-07T00:00:00.000Z',
      revision: pipeline.revision,
      evidenceFingerprint: publicationEvidenceFingerprint(pipeline),
      configFingerprint: state.publicationFingerprint,
      target: pipeline.authorization.target,
    };
    expect(assertDeliveryAuthority(pipeline, paths).connection).toEqual({
      repositoryId: '42',
    });
    pipeline.pr = { number: 42, url: 'https://github.com/test/repo/pull/42' };
    expect(assertDeliveryAuthority(pipeline, paths).connection).toEqual({
      repositoryId: '42',
    });
    expect(deliveryBudget(pipeline)).toEqual(budget);
    expect(state.currentPolicy).not.toHaveBeenCalled();
    state.publicationFingerprint = '8'.repeat(64);
    expect(() => assertDeliveryAuthority(pipeline, paths)).toThrow(
      /Publication configuration changed/,
    );
    state.publicationFingerprint = 'f'.repeat(64);
    pipeline.publication.revision = {
      ...pipeline.revision,
      specHash: '1'.repeat(64),
    };
    expect(() => assertDeliveryAuthority(pipeline, paths)).toThrow(
      /exact-candidate publication authorization/,
    );
  },
);
it('preserves revoked release and frozen identity fences', async () => {
  state.revoked = true;
  await admitReleasedValidation(paths);
  expect(listDeliveryPipelines({}, paths)).toEqual([]);
  expect(() => localValidationContext('run', paths)).toThrow(
    /authority changed/,
  );
  state.revoked = false;
  await admitReleasedValidation(paths);
  const pipeline = listDeliveryPipelines({}, paths)[0]!.record;
  state.revoked = true;
  expect(() => assertDeliveryAuthority(pipeline, paths)).toThrow(
    /authority changed/,
  );
  state.revoked = false;
  pipeline.authorization.revision.specHash = '0'.repeat(64);
  expect(() => assertDeliveryAuthority(pipeline, paths)).toThrow(
    /Validation authority changed/,
  );
});

it('retains a safe catch diagnostic and does not automatically retry blocked admission', async () => {
  state.captureFailure = new Error('secret credentials /private/source');
  await admitReleasedValidation(paths);
  const attention = state.attentionValue;
  expect(attention).toMatchObject({
    reasonCode: 'unexpected-admission-failure',
    stage: 'preview',
    nextAction: 'retry-validation',
  });
  expect(JSON.stringify(attention)).not.toContain('secret');
  await admitReleasedValidation(paths);
  expect(state.attention).toHaveBeenCalledTimes(1);
  expect(state.attentionValue).toBe(attention);
  expect(listDeliveryPipelines({}, paths)).toEqual([]);
});
it('deliberate recheck preserves unchanged limits and admits only after corrected capture', async () => {
  state.captureFailure = new CandidateEvidenceError('file-too-large', {
    path: 'assets/large.png',
    observedBytes: 3000000,
    limitBytes: 2097152,
  });
  await admitReleasedValidation(paths);
  const attention = state.attentionValue;
  expect(attention).toMatchObject({
    reasonCode: 'file-too-large',
    nextAction: 'inspect-diagnostics',
  });
  expect(attention?.message).toContain('3000000');
  await retryReleasedValidation(
    'run',
    { expectedVersion: 1, reason: 'recheck after resolution' },
    paths,
  );
  expect(state.attentionValue).toMatchObject({
    reasonCode: 'file-too-large',
    nextAction: 'inspect-diagnostics',
  });
  expect(listDeliveryPipelines({}, paths)).toEqual([]);
  const retainedFailure = state.attentionValue;
  await admitReleasedValidation(paths);
  expect(state.attentionValue).toBe(retainedFailure);
  state.captureFailure = null;
  await retryReleasedValidation(
    'run',
    { expectedVersion: 1, reason: 'recheck after resolution' },
    paths,
  );
  expect(state.attentionValue).toBeNull();
  const pipelines = listDeliveryPipelines({}, paths);
  expect(pipelines).toHaveLength(1);
  expect(pipelines[0]!.record.initialRevision).toMatchObject({
    runId: 'run',
    releaseId: 'release',
  });
  expect(pipelines[0]!.record.publication).toBeUndefined();
  expect(pipelines[0]!.record.effects).toEqual([]);
});
it('rejects stale run-version retry without clearing the saved failure', async () => {
  state.captureFailure = new CandidateEvidenceError('capture-failed');
  await admitReleasedValidation(paths);
  const attention = state.attentionValue;
  await expect(
    retryReleasedValidation(
      'run',
      { expectedVersion: 99, reason: 'retry' },
      paths,
    ),
  ).rejects.toThrow(/Candidate changed/);
  expect(state.attentionValue).toBe(attention);
});
it.each([
  [null, 'usage-unavailable'],
  [10800000, 'budget-exhausted'],
] as const)(
  'reports unavailable/exhausted usage without blind retry: %s',
  async (usage, code) => {
    state.usage = usage;
    await admitReleasedValidation(paths);
    expect(state.attentionValue?.reasonCode).toBe(code);
    expect(state.attentionValue?.nextAction).not.toBe('retry-validation');
    expect(listDeliveryPipelines({}, paths)).toEqual([]);
  },
);
it('rechecks the current saved generic failure through the same admission path', async () => {
  state.attentionValue = {
    blocker: 'candidate-unavailable',
    message: 'Reconcile its evidence and retry validation.',
    observedAt: '2026-09-01T00:00:00.000Z',
    nextAction: 'retry-validation',
  };
  state.captureFailure = new CandidateEvidenceError('file-too-large', {
    path: 'assets/image.png',
    observedBytes: 4000000,
    limitBytes: 2097152,
  });
  await retryReleasedValidation(
    'run',
    { expectedVersion: 1, reason: 'retry' },
    paths,
  );
  expect(state.attentionValue).toMatchObject({
    reasonCode: 'file-too-large',
    nextAction: 'inspect-diagnostics',
    stage: 'preview',
  });
  expect(state.attentionValue?.message).toContain('assets/image.png');
  expect(listDeliveryPipelines({}, paths)).toEqual([]);
});

it.each([true, false])(
  'distinguishes typed authority rejection from internal authority failure: %s',
  async (known) => {
    state.authorityFailure = known
      ? new CodingAuthorityChangedError('Frozen coding authority changed.')
      : new Error('private storage failure');
    await admitReleasedValidation(paths);
    expect(state.attentionValue).toMatchObject({
      stage: 'authority',
      reasonCode: known ? 'policy-changed' : 'unexpected-admission-failure',
      nextAction: known ? 'review-plan' : 'retry-validation',
    });
    expect(JSON.stringify(state.attentionValue)).not.toContain(
      'private storage',
    );
    expect(listDeliveryPipelines({}, paths)).toEqual([]);
  },
);

it('never clears plan-review attention through the recheck endpoint', async () => {
  state.usage = 10800000;
  await admitReleasedValidation(paths);
  const retained = state.attentionValue;
  await expect(
    retryReleasedValidation(
      'run',
      { expectedVersion: 1, reason: 'recheck' },
      paths,
    ),
  ).rejects.toThrow(/plan review/);
  expect(state.attentionValue).toBe(retained);
  expect(listDeliveryPipelines({}, paths)).toEqual([]);
});
