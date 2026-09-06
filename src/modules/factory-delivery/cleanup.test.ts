import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimePaths } from '../../runtime-home';
import { cleanupDecision } from '../worktrees';
import type { WorktreeRecord } from '../worktrees';
const f = vi.hoisted(() => ({
  clean: true,
  sha: 'a'.repeat(40),
  pipeline: {
    pipelineId: 'p',
    version: 1,
    outcome: 'merged' as string | null,
    pr: { number: 1 },
    commits: [
      {
        publishedHeadSha: 'a'.repeat(40),
        evidenceRef: '',
        revision: { runId: 'run' },
      },
    ],
    revision: { runId: 'run' },
    coordinator: { terminalObservedAt: '2026-01-01T00:00:00.000Z' },
    effects: [{ state: 'delivered', kind: 'push', revision: { runId: 'run' } }],
    repairs: [] as { status: string }[],
  },
  locks: [] as { expiresAt: string }[],
}));
vi.mock('./store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./store')>()),
  getDeliveryPipeline: () => f.pipeline,
}));
vi.mock('../coding-runs', () => ({
  getCodingRun: () => ({ deadProof: { kind: 'verified-dead' } }),
  getCodingRunForWorktree: () => null,
}));
vi.mock('../worktrees/git', () => ({ isGitClean: async () => f.clean }));
vi.mock('../../repo-edit/git', () => ({ gitCurrentSha: async () => f.sha }));
vi.mock('../worktrees/locks', () => ({
  activeLocksForWorktree: () => f.locks,
}));
let paths: ReturnType<typeof runtimePaths>;
let home: string;
const record = {
  id: 'publication',
  repoId: 'repo',
  owningWorkflowRunId: 'factory-delivery:p',
  localPath: '/private/tmp/publication',
  adopted: false,
  headRef: 'branch',
} as WorktreeRecord;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'delivery-cleanup-'));
  paths = runtimePaths(home);
  const dir = join(home, 'factory-delivery', 'p');
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({
    root: record.localPath,
    worktreeId: record.id,
    branch: record.headRef,
    publishedHeadSha: 'a'.repeat(40),
  });
  const ref = join(
    dir,
    createHash('sha256').update(body).digest('hex') + '.json',
  );
  writeFileSync(ref, body);
  f.pipeline.commits[0]!.evidenceRef = ref;
  f.clean = true;
  f.sha = 'a'.repeat(40);
  f.pipeline.outcome = 'merged';
  f.pipeline.effects = [
    { state: 'delivered', kind: 'push', revision: { runId: 'run' } },
  ];
  f.pipeline.coordinator.terminalObservedAt = '2026-01-01T00:00:00.000Z';
  f.locks = [];
});
it('requires explicit current publication claim even with force', async () => {
  expect((await cleanupDecision(record, { force: true }, paths)).delete).toBe(
    false,
  );
});
it('permits only terminal published clean dead-owned work after24h', async () => {
  expect(
    (
      await cleanupDecision(record, {}, paths, {
        pipelineId: 'p',
        expectedVersion: 1,
      })
    ).delete,
  ).toBe(true);
});
it('retains dirty uncertain failed and grace-period workspaces', async () => {
  const check = () =>
    cleanupDecision(record, { force: true }, paths, {
      pipelineId: 'p',
      expectedVersion: 1,
    });
  f.clean = false;
  expect((await check()).delete).toBe(false);
  f.clean = true;
  f.pipeline.effects = [
    { state: 'uncertain', kind: 'push', revision: { runId: 'run' } },
  ];
  expect((await check()).delete).toBe(false);
  f.pipeline.effects = [
    { state: 'delivered', kind: 'push', revision: { runId: 'run' } },
  ];
  f.pipeline.outcome = 'failed';
  expect((await check()).delete).toBe(false);
  f.pipeline.outcome = 'merged';
  f.pipeline.coordinator.terminalObservedAt = new Date().toISOString();
  expect((await check()).delete).toBe(false);
});
it('retains unexpected head or active lock without deleting audit ownership', async () => {
  f.sha = 'b'.repeat(40);
  expect(
    (
      await cleanupDecision(record, {}, paths, {
        pipelineId: 'p',
        expectedVersion: 1,
      })
    ).delete,
  ).toBe(false);
  f.sha = 'a'.repeat(40);
  f.locks = [{ expiresAt: new Date(Date.now() + 60000).toISOString() }];
  expect(
    (
      await cleanupDecision(record, {}, paths, {
        pipelineId: 'p',
        expectedVersion: 1,
      })
    ).delete,
  ).toBe(false);
  expect(record.owningWorkflowRunId).toBe('factory-delivery:p');
});

afterEach(() => rmSync(home, { recursive: true, force: true }));
it('retains workspace when its publication receipt has changed', async () => {
  writeFileSync(f.pipeline.commits[0]!.evidenceRef, '{}');
  expect(
    (
      await cleanupDecision(record, {}, paths, {
        pipelineId: 'p',
        expectedVersion: 1,
      })
    ).delete,
  ).toBe(false);
});

it('retains the latest local commit when only an older revision was pushed', async () => {
  f.pipeline.effects[0]!.revision = { runId: 'older' };
  expect(
    (
      await cleanupDecision(record, {}, paths, {
        pipelineId: 'p',
        expectedVersion: 1,
      })
    ).delete,
  ).toBe(false);
});
