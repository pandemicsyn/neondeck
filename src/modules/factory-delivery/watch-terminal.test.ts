import { approveTestPublication } from './publication.test-helper';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { initializeAppDatabase } from '../../runtime-home/app-db';
import {
  reserveDeliveryPipeline,
  deliveryValidationContractDigest,
} from './store';
import {
  changeDelivery,
  requireDelivery,
  deliveryReceipt,
} from './service-records';
import { watchFactoryDelivery } from './watch';
const io = vi.hoisted(() => ({
  observe: vi.fn<typeof import('../github').observeFactoryGitHubPull>(),
  classify: vi.fn<typeof import('./watch-feedback').classifyFeedback>(),
  notify: vi.fn<() => Promise<void>>(),
}));
vi.mock('../github', async (original) => ({
  ...(await original<typeof import('../github')>()),
  observeFactoryGitHubPull: io.observe,
}));
vi.mock('./authority', () => ({
  assertDeliveryAuthority: () => ({ connection: { repositoryId: '1' } }),
}));
vi.mock('./watch-feedback', () => ({ classifyFeedback: io.classify }));
vi.mock('../app-state', async (original) => ({
  ...(await original<typeof import('../app-state')>()),
  addNotification: io.notify,
}));
vi.mock('../watches', async (original) => ({
  ...(await original<typeof import('../watches')>()),
  readWatches: () => [
    {
      id: 'watch',
      repoId: 'repo',
      githubOwner: 'test',
      githubName: 'repo',
      prNumber: 42,
      ownerInstanceId: null,
      worktreeId: null,
      autopilotStatus: 'idle',
      lastCheckedAt: '2026-09-06T00:00:00.000Z',
    },
  ],
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
const current = () => requireDelivery(id, paths);
const change = (action: Parameters<typeof changeDelivery>[1]) =>
  changeDelivery(id, action, paths);
beforeEach(() => {
  vi.clearAllMocks();
  paths = runtimePaths(mkdtempSync(join(tmpdir(), 'watch-terminal-')));
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

  for (const kind of ['push', 'create-pr'] as const) {
    change({ type: 'plan-effect', id: kind, kind });
    change({ type: 'start-effect', id: kind });
    change({
      type: 'settle-effect',
      id: kind,
      state: 'delivered',
      receiptRef: kind,
      ...(kind === 'create-pr'
        ? { pr: { number: 42, url: 'https://github.com/test/repo/pull/42' } }
        : {}),
    });
  }
  change({
    type: 'set-coordinator',
    coordinator: { ...current().coordinator, watchId: 'watch' },
  });
});
afterEach(() => rmSync(paths.home, { recursive: true, force: true }));
function facts(merged: boolean): Awaited<ReturnType<typeof io.observe>> {
  const p = current();
  const repo = { id: 1, name: 'repo', owner: { login: 'test' } };
  return {
    pull: {
      id: 42,
      number: 42,
      html_url: p.pr!.url,
      title: 'Fixture',
      body: `<!-- neon-factory-pr:${p.pipelineId} -->`,
      state: 'closed',
      draft: false,
      head: { sha: revision.headSha, ref: p.branch, repo },
      base: { sha: revision.baseSha, ref: 'main', repo },
      user: { id: 1, login: 'test' },
      merged_at: merged ? '2026-09-06T00:00:00.000Z' : null,
      merge_commit_sha: merged ? '9'.repeat(40) : null,
      updated_at: '2026-09-06T00:00:00.000Z',
      merged,
      mergeable: null,
      mergeable_state: 'unknown',
    },
    checks: { items: [], complete: true },
    statuses: { items: [], complete: true },
    reviews: { items: [], complete: true },
    inlineComments: { items: [], complete: true },
    issueComments: {
      complete: true,
      items: [
        {
          id: 1,
          body: 'External feedback '.repeat(2000),
          user: { id: 1, login: 'external' },
          created_at: '2026-09-06T00:00:00.000Z',
          updated_at: '2026-09-06T00:00:00.000Z',
        },
      ],
    },
    complete: true,
  };
}
it.each([false, true])(
  'records terminal merged=%s before oversized feedback without model/effect admission',
  async (merged) => {
    const before = current();
    io.observe.mockResolvedValue(facts(merged));
    await watchFactoryDelivery(before, paths);
    const after = current();
    expect(after.outcome).toBe(merged ? 'merged' : 'closed');
    expect(after.effects).toEqual(before.effects);
    expect(after.interventions).toEqual([]);
    expect(after.feedback).toEqual([]);
    expect(io.classify).not.toHaveBeenCalled();
    const body = readFileSync(after.outcomeRef!, 'utf8');
    expect(Buffer.byteLength(body)).toBeLessThan(2000);
    expect(body).not.toContain('External feedback');
    expect(JSON.parse(body)).toMatchObject({
      kind: 'terminal-pr-observation',
      pr: before.pr,
      revision,
      publishedHeadSha: revision.headSha,
      target: before.authorization.target,
    });
    expect(io.observe).toHaveBeenCalledWith(
      expect.anything(),
      42,
      {
        head: before.branch,
        base: 'main',
        marker: `<!-- neon-factory-pr:${id} -->`,
      },
      { fresh: true },
    );
  },
);
it('prioritizes fresh terminal observation over pending comment classification', async () => {
  change({
    type: 'record-feedback',
    feedback: {
      id: 'pending',
      fingerprint: 'f'.repeat(64),
      revision,
      publishedHeadSha: revision.headSha,
      ciFailed: false,
      hasReviewFeedback: true,
      evidenceRef: deliveryReceipt(
        id,
        { feedbackBody: 'Prior comment' },
        paths,
      ),
    },
  });
  io.observe.mockResolvedValue(facts(true));
  await watchFactoryDelivery(current(), paths);
  expect(current().outcome).toBe('merged');
  expect(io.classify).not.toHaveBeenCalled();
});
it('preserves exact-head enforcement even for terminal pulls with large feedback', async () => {
  const observed = facts(true);
  observed.pull.head.sha = '8'.repeat(40);
  io.observe.mockResolvedValue(observed);
  await watchFactoryDelivery(current(), paths);
  expect(current().outcome).toBeNull();
  expect(current().interventions.at(-1)?.kind).toBe('authority');
  expect(io.classify).not.toHaveBeenCalled();
});
it('does not record terminal state when the scoped transport rejects PR identity', async () => {
  io.observe.mockRejectedValue(
    new Error('Factory pull request identity conflict.'),
  );
  await expect(watchFactoryDelivery(current(), paths)).rejects.toThrow(
    'identity conflict',
  );
  expect(current().outcome).toBeNull();
  expect(io.classify).not.toHaveBeenCalled();
});
