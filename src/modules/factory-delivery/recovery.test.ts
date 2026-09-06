import { database, save } from './delivery-persistence';
import { advanceFactoryDelivery } from './service';
import { deliveryIO } from './delivery-io';
import {
  PublicationPushNotAttemptedError,
  settleEffectNonadmission,
} from './publication-nonadmission';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
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
  interveneDelivery,
} from './service-records';
import { settleReviewerFailure } from './service-review-failure';
import { ReviewerTerminalError } from './reviewer';
import {
  recoverDeliveryEffect,
  observePausedDeliveryOutcome,
} from './recovery';
const io = vi.hoisted(() => ({
  lookup: vi.fn(),
  observe: vi.fn(),
  watches: vi.fn(),
}));
vi.mock('../github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github')>()),
  lookupFactoryGitHubPull: io.lookup,
  observeFactoryGitHubPull: io.observe,
}));
vi.mock('../watches', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../watches')>()),
  readWatches: io.watches,
}));
let home: string;
let paths: ReturnType<typeof runtimePaths>;
const rev = {
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
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delivery-recovery-'));
  paths = runtimePaths(home);
  mkdirSync(join(home, 'data'));
  initializeAppDatabase(paths.neondeckDatabase);
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      factory: {
        enabled: false,
        github: [
          {
            id: 'test',
            enabled: false,
            repoId: 'repo',
            repositoryId: '1',
            owner: 'test',
            name: 'repo',
            webhookSecretEnv: 'UNUSED_TEST',
            tokenEnv: 'UNUSED_TEST',
            admission: { mode: 'all' },
          },
        ],
      },
    }),
  );
  io.lookup.mockReset();
  io.watches.mockReturnValue([]);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function uncertainPr() {
  const p = reserveDeliveryPipeline(
    {
      workItemId: 'work',
      repoId: 'repo',
      initialRevision: rev,
      authorization: {
        id: 'grant',
        authorizedBy: 'human',
        authorizedAt: '2026-09-06T00:00:00.000Z',
        revision: rev,
        repoId: 'repo',
        target: { owner: 'test', name: 'repo', baseBranch: 'main' },
        configFingerprint: 'f'.repeat(64),
        checkCommands: ['npm run check'],
        maxRepairAttempts: 2,
        totalExecutionMs: 10800000,
        initialExecutionMs: 100,
      },
    },
    paths,
  );
  const change = (action: Parameters<typeof changeDelivery>[1]) =>
    changeDelivery(p.pipelineId, action, paths);
  for (const kind of ['verification', 'review'] as const) {
    change({ type: 'plan-effect', id: kind, kind, maxExecutionMs: 1000 });
    change({ type: 'start-effect', id: kind });
    change({
      type: 'record-evidence',
      evidence: {
        id: kind,
        kind,
        revision: rev,
        producerId: kind,
        result: 'passed',
        evidenceRef: kind,
        effectId: kind,
        validationContractDigest: deliveryValidationContractDigest(p),
        bundleDigest: (kind === 'verification' ? '1' : '2').repeat(64),
        verificationEvidenceId: kind === 'review' ? 'verification' : null,
        verificationBundleDigest: kind === 'review' ? '1'.repeat(64) : null,
      },
    });
    change({
      type: 'settle-effect',
      id: kind,
      state: 'delivered',
      receiptRef: kind,
      executionMs: 1,
    });
  }
  change({ type: 'plan-effect', id: 'commit', kind: 'commit' });
  change({ type: 'start-effect', id: 'commit' });
  change({
    type: 'bind-commit',
    publishedHeadSha: '9'.repeat(40),
    treeSha: rev.treeSha,
    evidenceRef: 'commit',
  });
  change({
    type: 'settle-effect',
    id: 'commit',
    state: 'delivered',
    receiptRef: 'commit',
  });
  change({ type: 'plan-effect', id: 'push', kind: 'push' });
  change({ type: 'start-effect', id: 'push' });
  change({
    type: 'settle-effect',
    id: 'push',
    state: 'delivered',
    receiptRef: 'push',
  });
  change({ type: 'plan-effect', id: 'create-pr', kind: 'create-pr' });
  change({ type: 'start-effect', id: 'create-pr' });
  change({
    type: 'settle-effect',
    id: 'create-pr',
    state: 'uncertain',
    receiptRef: 'lost-response',
  });
  return requireDelivery(p.pipelineId, paths);
}
it('reconciles known PR after release/config revocation using readonly target connection', async () => {
  let p = uncertainPr();
  p = interveneDelivery(p.pipelineId, 'authority', 'Human revoked', paths);
  io.lookup.mockResolvedValue({
    status: 'found',
    pages: 1,
    pull: {
      number: 7,
      html_url: 'https://github.com/test/repo/pull/7',
      head: { sha: '9'.repeat(40) },
    },
  });
  await recoverDeliveryEffect(p, p.effects.at(-1)!, paths);
  expect(requireDelivery(p.pipelineId, paths).pr?.number).toBe(7);
  expect(io.lookup).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: false }),
    expect.objectContaining({ head: p.branch, base: 'main' }),
    { fresh: true },
  );
});
it('fresh absence never rearms an uncertain POST', async () => {
  const p = uncertainPr();
  io.lookup.mockResolvedValue({ status: 'absent', pages: 1 });
  await recoverDeliveryEffect(p, p.effects.at(-1)!, paths);
  expect(requireDelivery(p.pipelineId, paths).effects.at(-1)!.state).toBe(
    'uncertain',
  );
});

it.each(['authority', 'scope', 'budget'] as const)(
  'observes human merge during %s pause with an unpublished newer candidate',
  async (kind) => {
    let p = uncertainPr();
    io.lookup.mockResolvedValue({
      status: 'found',
      pages: 1,
      pull: {
        number: 7,
        html_url: 'https://github.com/test/repo/pull/7',
        head: { sha: '9'.repeat(40) },
      },
    });
    await recoverDeliveryEffect(p, p.effects.at(-1)!, paths);
    p = interveneDelivery(p.pipelineId, kind, 'Human planning pause', paths);
    p = changeDelivery(
      p.pipelineId,
      {
        type: 'set-coordinator',
        coordinator: { ...p.coordinator, watchId: 'watch' },
      },
      paths,
    );
    io.watches.mockReturnValue([
      {
        githubOwner: 'test',
        githubName: 'repo',
        repoId: 'repo',
        prNumber: 7,
        ownerInstanceId: null,
        worktreeId: null,
        autopilotStatus: 'idle',
        id: 'watch',
        lastCheckedAt: '2026-09-06T12:00:00.000Z',
      },
    ]);
    io.observe.mockResolvedValue({
      complete: true,
      pull: {
        merged: true,
        state: 'closed',
        head: { sha: '9'.repeat(40) },
        updated_at: '2026-09-06T12:00:00.000Z',
        merged_at: '2026-09-06T12:00:00.000Z',
        merge_commit_sha: '1'.repeat(40),
      },
      issueComments: {
        items: Array.from({ length: 17 }, () => ({ body: 'x'.repeat(64000) })),
      },
    });
    const nextRevision = {
      ...p.revision,
      candidateDigest: '8'.repeat(64),
      treeSha: '7'.repeat(40),
    };
    await observePausedDeliveryOutcome(
      {
        ...p,
        revision: nextRevision,
        commits: [
          ...p.commits,
          {
            ...p.commits.at(-1)!,
            revision: nextRevision,
            publishedHeadSha: '6'.repeat(40),
          },
        ],
      },
      paths,
    );
    const ended = requireDelivery(p.pipelineId, paths);
    expect(ended.outcome).toBe('merged');
    expect(readFileSync(ended.outcomeRef!, 'utf8').length).toBeLessThan(4096);
    expect(ended.coordinator.watchObservedAt).toBeNull();
    expect(
      ended.interventions.some((i) => i.kind === kind && !i.resolution),
    ).toBe(true);
    expect(io.observe).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
      7,
      expect.anything(),
      { fresh: true },
    );
  },
);
it('settles known reviewer failure with unknown usage held and no repeat admission', async () => {
  let p = uncertainPr();
  io.lookup.mockResolvedValue({
    status: 'found',
    pages: 1,
    pull: {
      number: 7,
      html_url: 'https://github.com/test/repo/pull/7',
      head: { sha: '9'.repeat(40) },
    },
  });
  await recoverDeliveryEffect(p, p.effects.at(-1)!, paths);
  p = requireDelivery(p.pipelineId, paths);
  p = changeDelivery(
    p.pipelineId,
    {
      type: 'plan-effect',
      id: 'feedback-failure',
      kind: 'feedback-review',
      maxExecutionMs: 1000,
    },
    paths,
  );
  p = changeDelivery(
    p.pipelineId,
    { type: 'start-effect', id: 'feedback-failure' },
    paths,
  );
  const effect = p.effects.at(-1)!;
  expect(
    settleReviewerFailure(
      p,
      effect,
      new ReviewerTerminalError('failed', 'submission', 1000),
      paths,
    ),
  ).toBe(true);
  const settled = requireDelivery(p.pipelineId, paths);
  expect(settled.effects.at(-1)).toMatchObject({
    state: 'delivered',
    executionMs: null,
    reservedExecutionMs: 1000,
  });
  expect(settled.interventions.at(-1)?.kind).toBe('scope');
  expect(deliveryBudget(settled)).toMatchObject({
    consumedExecutionMs: 102,
    reservedExecutionMs: 1000,
  });
  settleReviewerFailure(
    settled,
    effect,
    new ReviewerTerminalError('failed', 'submission', 1000),
    paths,
  );
  expect(requireDelivery(p.pipelineId, paths).version).toBe(settled.version);
});

it('known pre-push rejection pauses durably then observes a human close without a push or uncertainty trap', async () => {
  let p = uncertainPr();
  io.lookup.mockResolvedValue({
    status: 'found',
    pages: 1,
    pull: {
      number: 7,
      html_url: 'https://github.com/test/repo/pull/7',
      head: { sha: '9'.repeat(40) },
    },
  });
  await recoverDeliveryEffect(p, p.effects.at(-1)!, paths);
  p = requireDelivery(p.pipelineId, paths);
  p = changeDelivery(
    p.pipelineId,
    {
      type: 'set-coordinator',
      coordinator: { ...p.coordinator, watchId: 'watch' },
    },
    paths,
  );
  // Retained controller snapshot after a new local revision reached push admission.
  const repaired = {
    ...p.revision,
    runId: 'repair-run',
    attemptId: 'repair-attempt',
    candidateDigest: '8'.repeat(64),
    treeSha: '7'.repeat(40),
  };
  p = database(paths, (db) =>
    save(db, {
      ...p,
      revision: repaired,
      repairs: [
        {
          runId: repaired.runId,
          attemptId: repaired.attemptId,
          requestId: 'repair-request',
          reservedExecutionMs: 1000,
          executionMs: 10,
          fromRevision: p.revision,
          status: 'candidate',
          revision: repaired,
          reason: 'Scoped review repair',
        },
      ],
      commits: [
        ...p.commits,
        {
          ...p.commits.at(-1)!,
          revision: repaired,
          treeSha: repaired.treeSha,
          publishedHeadSha: '6'.repeat(40),
        },
      ],
      effects: [
        ...p.effects,
        {
          ...p.effects.find((e) => e.kind === 'push')!,
          id: 'blocked-push',
          revision: repaired,
          state: 'in-flight',
          receiptRef: null,
        },
      ],
    }),
  );
  settleEffectNonadmission(
    p,
    p.effects.at(-1)!,
    new PublicationPushNotAttemptedError(),
    paths,
  );
  const paused = requireDelivery(p.pipelineId, paths);
  expect(paused.effects.at(-1)?.state).toBe('planned');
  expect(paused.interventions.at(-1)?.kind).toBe('scope');
  io.watches.mockReturnValue([
    {
      githubOwner: 'test',
      githubName: 'repo',
      repoId: 'repo',
      prNumber: 7,
      ownerInstanceId: null,
      worktreeId: null,
      autopilotStatus: 'idle',
      id: 'watch',
      lastCheckedAt: '2026-09-06T12:00:00.000Z',
    },
  ]);
  io.observe.mockResolvedValue({
    complete: true,
    pull: {
      merged: false,
      state: 'closed',
      head: { sha: '9'.repeat(40) },
      updated_at: '2026-09-06T12:00:00.000Z',
      merged_at: null,
      merge_commit_sha: null,
    },
    issueComments: {
      items: Array.from({ length: 17 }, () => ({ body: 'x'.repeat(64000) })),
    },
  });
  const push = vi.fn(),
    assert = vi.fn();
  await advanceFactoryDelivery(p.pipelineId, paths, {
    ...deliveryIO,
    push,
    assert,
  });
  expect(requireDelivery(p.pipelineId, paths).outcome).toBe('closed');
  expect(push).not.toHaveBeenCalled();
  expect(assert).not.toHaveBeenCalled();
});
