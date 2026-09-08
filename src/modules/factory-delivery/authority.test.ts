import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import { validationPolicySchema } from '../../../shared/factory-delivery';
import { assertDeliveryAuthority, localValidationContext } from './authority';
import { admitReleasedValidation } from './validation-service';
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
    attention: vi.fn(),
    publicationFingerprint: 'f'.repeat(64),
  };
});
const run = vi.hoisted(() => ({
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
  codingHandle: () => ({}),
  readCodingExecutionUsage: async () => 1234,
  readValidationAttention: () => undefined,
  saveValidationAttention: state.attention,
}));
vi.mock('./evidence', () => ({
  captureCandidateEvidence: async () => ({
    evidenceDigest: 'c'.repeat(64),
    treeSha: 'd'.repeat(40),
    baseSha: 'e'.repeat(40),
    headSha: 'e'.repeat(40),
  }),
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
  state.attention.mockClear();
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
