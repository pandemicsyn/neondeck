import { expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { deliveryContext } from './authority';
import {
  authorizeFactoryDelivery,
  factoryDeliveryPreview,
} from './service-operator';
const state = vi.hoisted(() => ({ checks: [] as string[] }));
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
vi.mock('../factory', async (original) => ({
  ...(await original<typeof import('../factory')>()),
  assertCodingAuthoritySnapshot: () => ({
    repo: { defaultBranch: 'main' },
    coding: {},
  }),
}));
vi.mock('../../runtime-home', async (original) => ({
  ...(await original<typeof import('../../runtime-home')>()),
  readRuntimeJsonSync: () => ({
    factory: {
      github: [{ enabled: true, repoId: 'repo', owner: 'test', name: 'repo' }],
    },
  }),
}));
vi.mock('../runtime', () => ({
  resolveAgentModelSelection: () => ({
    prReviewConfigured: true,
    prReview: 'reviewer',
  }),
}));
vi.mock('../autopilot-policy', async (original) => ({
  ...(await original<typeof import('../autopilot-policy')>()),
  repoGuardrails: () => ({ requiredChecks: [] }),
}));
vi.mock('../worktree-verification', () => ({
  resolveWorktreeVerificationChecks: () => state.checks,
}));
const paths = runtimePaths('/unused-admission-fixture');
const capture = vi.fn<typeof import('./evidence').captureCandidateEvidence>();
const preview = {
  workItemId: 'work',
  repoId: 'repo',
  revision: {
    runId: 'run',
    attemptId: 'attempt',
    releaseId: 'release',
    specVersion: 1,
    specHash: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    baseSha: 'c'.repeat(40),
    headSha: 'd'.repeat(40),
    treeSha: 'e'.repeat(40),
  },
  target: { owner: 'test', name: 'repo', baseBranch: 'main' },
  configFingerprint: 'f'.repeat(64),
  checkCommands: ['npm test'],
  maxRepairAttempts: 2,
  totalExecutionMs: 10800000,
  initialExecutionMs: 100,
  maxAttemptMs: 2700000,
  publish: 'draft-pr-only',
  merge: false,
  deploy: false,
};
it('rejects a 17-check configuration during preview and grant revalidation before capture or workspace/effect admission', async () => {
  state.checks = Array.from({ length: 17 }, (_, i) => `npm run check-${i}`);
  await expect(factoryDeliveryPreview('run', paths, capture)).rejects.toThrow(
    'between 1 and 16',
  );
  await expect(
    authorizeFactoryDelivery(
      { requestId: 'grant', confirm: true, preview },
      paths,
      capture,
    ),
  ).rejects.toThrow('between 1 and 16');
  expect(capture).not.toHaveBeenCalled();
});
it('rejects an oversized submitted preview before touching candidate capture', async () => {
  await expect(
    authorizeFactoryDelivery(
      {
        requestId: 'grant',
        confirm: true,
        preview: {
          ...preview,
          checkCommands: Array.from({ length: 17 }, (_, i) => `check-${i}`),
        },
      },
      paths,
      capture,
    ),
  ).rejects.toThrow(/length/i);
  expect(capture).not.toHaveBeenCalled();
});
it('accepts the exact supported 16-check configuration in authority', () => {
  state.checks = Array.from({ length: 16 }, (_, i) => `npm run check-${i}`);
  expect(deliveryContext('run', paths).checkCommands).toEqual(state.checks);
});
