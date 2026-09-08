import { expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { localValidationContext } from './authority';
import { validationPolicySchema } from '../../../shared/factory-delivery';
import * as v from 'valibot';
const state = vi.hoisted(() => ({ checks: ['npm test'], historical: false }));
vi.mock('../coding-runs', async (original) => ({
  ...(await original<typeof import('../coding-runs')>()),
  getCodingRun: () => ({
    status: 'candidate',
    candidate: {},
    deadProof: {},
    workspace: {},
    snapshot: { repoId: 'repo' },
  }),
}));
vi.mock('../factory/validation-policy', () => ({
  factoryValidationPolicy: () => {
    return v.parse(validationPolicySchema, {
      version: 'local-validation-v1',
      configFingerprint: 'a'.repeat(64),
      checkCommands: state.checks,
      reviewerModel: 'faux/faux-1',
      reviewerThinkingLevel: 'off',
      maxRepairAttempts: 2,
      totalExecutionMs: 10800000,
    });
  },
}));
vi.mock('../factory', async (original) => ({
  ...(await original<typeof import('../factory')>()),
  assertCodingAuthoritySnapshot: () => ({
    repo: {
      id: 'repo',
      github: { owner: 'test', name: 'repo' },
      defaultBranch: 'main',
    },
    coding: {},
    release: {
      validationPolicy: state.historical
        ? undefined
        : {
            version: 'local-validation-v1',
            configFingerprint: 'a'.repeat(64),
            checkCommands: state.checks,
            reviewerModel: 'faux/faux-1',
            reviewerThinkingLevel: 'off',
            maxRepairAttempts: 2,
            totalExecutionMs: 10800000,
          },
    },
  }),
}));
const paths = runtimePaths('/private/tmp/unused-validation-authority');
it('resolves only the versioned local validation policy without intake configuration', () => {
  state.historical = false;
  state.checks = ['npm test'];
  expect(localValidationContext('run', paths)).toMatchObject({
    checkCommands: ['npm test'],
    reviewerThinkingLevel: 'off',
    target: { owner: 'test', name: 'repo', baseBranch: 'main' },
  });
});
it('historical releases require a fresh release rather than extra grant', () => {
  state.historical = true;
  expect(() => localValidationContext('run', paths)).toThrow(/fresh release/);
  state.historical = false;
});
it('bounded policy rejects excess checks before candidate work', () => {
  state.checks = Array.from({ length: 17 }, () => 'npm test');
  expect(() => localValidationContext('run', paths)).toThrow();
  state.checks = ['npm test'];
});
