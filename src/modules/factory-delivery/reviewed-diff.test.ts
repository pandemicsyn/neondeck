import * as v from 'valibot';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { deliveryPipelineSchema } from '../../../shared/factory-delivery';
import { deliveryValidationContractDigest } from './delivery-aggregate';
import { runtimePaths } from '../../runtime-home';
import { readReviewedDeliveryDiff } from './reviewed-diff';
const state = vi.hoisted(() => ({
  root: '',
  pipeline: undefined as unknown,
  reads: 0,
  changeOnRead: false,
}));
vi.mock('./service-records', () => ({
  requireDelivery: () => {
    const pipeline = v.parse(deliveryPipelineSchema, state.pipeline);
    state.reads++;
    return state.changeOnRead && state.reads > 1
      ? { ...pipeline, version: pipeline.version + 1 }
      : pipeline;
  },
}));
vi.mock('../factory', async (original) => ({
  ...(await original<typeof import('../factory')>()),
  requireCodingRun: () => ({}),
  codingHandle: () => ({}),
}));
vi.mock('../coding-runs', async (original) => ({
  ...(await original<typeof import('../coding-runs')>()),
  loadLocalManifest: async () => ({
    manifest: { ownedWorktree: { root: state.root } },
  }),
}));
let home: string;
let base: string;
const git = (...args: string[]) =>
  execFileSync('/usr/bin/git', args, {
    cwd: state.root,
    encoding: 'utf8',
  }).trim();
function fixture(treeSha: string, result: 'passed' | 'failed' = 'passed') {
  const revision = {
    runId: 'run',
    attemptId: 'attempt',
    releaseId: 'release',
    specVersion: 1,
    specHash: 'a'.repeat(64),
    candidateDigest: 'b'.repeat(64),
    baseSha: base,
    headSha: base,
    treeSha,
  };
  const p = v.parse(deliveryPipelineSchema, {
    pipelineId: 'p',
    version: 1,
    workItemId: 'work',
    repoId: 'repo',
    initialRevision: revision,
    revision,
    branch: 'agent/fixture',
    prIdentity: 'fixture',
    pr: null,
    authorization: {
      mode: 'local-validation',
      id: 'grant',
      authorizedBy: 'human',
      authorizedAt: '2026-09-07T00:00:00.000Z',
      revision,
      repoId: 'repo',
      target: { owner: 'test', name: 'repo', baseBranch: 'main' },
      configFingerprint: 'a'.repeat(64),
      checkCommands: ['npm test'],
      maxRepairAttempts: 2,
      totalExecutionMs: 10800000,
      initialExecutionMs: 0,
    },
    repairs: [],
    evidence: [],
    effects: [],
    interventions: [],
    commits: [],
    coordinator: {
      candidateRef: null,
      watchId: null,
      observationFingerprint: null,
      terminalObservedAt: null,
    },
    outcome: null,
    outcomeRef: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  });
  for (const kind of ['verification', 'review'] as const) {
    p.effects.push({
      id: kind,
      kind,
      revision,
      state: 'delivered',
      receiptRef: kind,
      reservedExecutionMs: 100,
      executionMs: 1,
    });
    p.evidence.push({
      id: kind,
      kind,
      revision,
      producerId: kind,
      result: kind === 'review' ? result : 'passed',
      evidenceRef: kind,
      effectId: kind,
      validationContractDigest: deliveryValidationContractDigest(p),
      bundleDigest: '1'.repeat(64),
      verificationEvidenceId: kind === 'review' ? 'verification' : null,
      verificationBundleDigest: kind === 'review' ? '1'.repeat(64) : null,
    });
  }
  state.pipeline = p;
  state.reads = 0;
  state.changeOnRead = false;
  return p;
}
beforeEach(() => {
  home = mkdtempSync('/private/tmp/reviewed-diff-');
  state.root = home;
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(home, 'file.txt'), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  base = git('rev-parse', 'HEAD');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
it('reads the immutable reviewed tree despite a different dirty live checkout, including failed reviews', async () => {
  writeFileSync(join(home, 'file.txt'), 'reviewed content\n');
  git('add', '.');
  const tree = git('write-tree');
  fixture(tree, 'failed');
  writeFileSync(join(home, 'file.txt'), 'unreviewed dirty content\n');
  const result = await readReviewedDeliveryDiff(
    'p',
    runtimePaths(join(home, 'runtime')),
  );
  expect(result.diff).toContain('+reviewed content');
  expect(result.diff).not.toContain('unreviewed dirty');
  expect(result.revision.treeSha).toBe(tree);
  expect(result.unavailableReason).toBeNull();
  expect(git('diff')).toContain('unreviewed dirty content');
});
it('updates exact revision and diff when the controller presents a reviewed repair candidate', async () => {
  writeFileSync(join(home, 'file.txt'), 'first candidate\n');
  git('add', '.');
  fixture(git('write-tree'));
  const first = await readReviewedDeliveryDiff(
    'p',
    runtimePaths(join(home, 'runtime')),
  );
  writeFileSync(join(home, 'file.txt'), 'reviewed repair\n');
  git('add', '.');
  const p = fixture(git('write-tree'));
  p.revision = {
    ...p.revision,
    runId: 'repair',
    attemptId: 'repair-attempt',
    candidateDigest: 'c'.repeat(64),
  };
  for (const e of p.evidence) e.revision = p.revision;
  for (const e of p.effects) e.revision = p.revision;
  const repaired = await readReviewedDeliveryDiff(
    'p',
    runtimePaths(join(home, 'runtime')),
  );
  expect(repaired.revision.runId).toBe('repair');
  expect(repaired.diff).toContain('+reviewed repair');
  expect(repaired.revision.treeSha).not.toBe(first.revision.treeSha);
  expect(repaired.evidenceFingerprint).not.toBe(first.evidenceFingerprint);
});
it('distinguishes review pending, sensitive paths, and changes during loading without enabling approval', async () => {
  const p = fixture(git('rev-parse', 'HEAD^{tree}'));
  p.evidence = [];
  expect(
    (await readReviewedDeliveryDiff('p', runtimePaths(home))).unavailableReason,
  ).toContain('review has not settled');
  writeFileSync(join(home, '.env'), 'SYNTHETIC=fixture\n');
  git('add', '.');
  fixture(git('write-tree'));
  expect(
    (await readReviewedDeliveryDiff('p', runtimePaths(home))).unavailableReason,
  ).toContain('sensitive paths');
  fixture(git('rev-parse', 'HEAD^{tree}'));
  state.changeOnRead = true;
  const changed = await readReviewedDeliveryDiff('p', runtimePaths(home));
  expect(changed.diff).toBeNull();
  expect(changed.unavailableReason).toContain('changed while');
});
