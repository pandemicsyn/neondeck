import { upsertMemory } from '../modules/memory';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
  runtimePaths,
  ensureRuntimeHome,
  type RuntimePaths,
} from '../runtime-home';
import { emptyFactorySpec, type FactoryDetail } from '../../shared/factory';
import { connection, issue } from '../modules/factory/testing/github-fixture';
import {
  factoryCodingConfigSchema,
  factoryCodingPageSchema,
  factoryCodingRunSchema,
  factoryCodingEventsSchema,
} from '../../shared/factory-coding';
import {
  prepareSchema,
  type PrepareLocalAttemptInput,
  type LocalInspection,
  type LocalReceipt,
} from '../modules/coding-runs';
import {
  getCodingRun,
  listCodingRuns,
  reserveCodingRun,
  updateCodingRun,
} from '../modules/coding-runs';
import { updateFactoryConfig } from '../modules/config';
import { verifyWorktreeChecks } from '../modules/worktree-verification';
import { openDb } from '../lib/sqlite';
import {
  submitFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
  getFactoryWork,
  transitionFactoryWork,
  dbRun,
  reconcileGitHubSource,
} from '../modules/factory/service';
import {
  dispatchCodingWork,
  tickFactoryCoding,
  reconcileCodingRun,
  publicCodingRun,
  codingHandle,
  type CodingHost,
} from '../modules/factory/coding-service';
import {
  codingConfig,
  codingDigest,
  codingSnapshot,
  assertCodingAuthoritySnapshot,
  frozenCodingConfig,
  assertPinnedCodingExecutable,
} from '../modules/factory/coding-context';
import {
  factoryCodingRuns,
  saveFactoryCodingConfig,
} from '../modules/factory/coding-operator';
import {
  cleanupWorktrees,
  createWorktree,
  lockWorktree,
  syncWorktree,
  releaseWorktreeLock,
} from '../modules/worktrees';
import { listActiveRepoWorktrees } from '../modules/worktrees';
import {
  requestPreparedDiffRevision,
  readPreparedDiff,
  markPreparedDiffPushed,
} from '../modules/prepared-diffs';
import { approvePreparedDiffPushState } from '../modules/prepared-diffs';
import { assertWorktreeMutationAllowed } from '../modules/worktrees';
import { fenceInvalidFactoryCoding } from '../modules/factory/coding-invalidation';
import * as codingRuns from '../modules/coding-runs';
import { readCodingAttention } from '../modules/factory/coding-attention';
import { createFactoryCodingRoutes } from './routes/factory-coding';
const actor = { kind: 'human' as const, id: 'operator' };
let paths: RuntimePaths;
let root: string;
let repo: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const ready = async () => ({
  ready: true,
  enabled: true,
  supportedVersion: 'codex-cli 0.150.1',
  installedVersion: 'codex-cli 0.150.1',
  blockers: [],
});
let prepared: PrepareLocalAttemptInput | undefined;
let finished = false;
let host: CodingHost;
const receipt = (): LocalReceipt => ({
  version: 1,
  attemptId: prepared!.attemptId,
  nonce: 'mock-receipt',
  at: Date.now(),
  supervisor: { pid: 100, pgid: 100, start: 'test', command: 'test' },
  group: { pid: 101, pgid: 101, start: 'test', command: 'test' },
  state: finished ? 'finished' : 'running',
  reason: null,
  exitCode: finished ? 0 : null,
  signal: null,
  sessionId: 'synthetic-session',
  terminal: finished ? 'completed' : null,
  outputBytes: 0,
  noWriter: finished,
  authCleanup: finished ? 'removed' : 'pending',
});
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'factory-bridge-'));
  paths = runtimePaths(join(root, 'runtime'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.test');
  writeFileSync(
    join(repo, 'AGENTS.md'),
    'Run npm test before presenting the candidate.',
  );
  writeFileSync(join(repo, 'file.txt'), 'original\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial');
  await ensureRuntimeHome(paths);
  writeFileSync(
    join(root, 'synthetic-codex'),
    'synthetic CLI identity fixture',
  );
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      factory: {
        enabled: true,
        coding: {
          enabled: true,
          executable: join(root, 'synthetic-codex'),
          model: 'test-model',
          auth: { kind: 'api-key', env: 'FACTORY_TEST_KEY' },
        },
      },
    }),
  );
  writeFileSync(
    paths.repos,
    JSON.stringify({
      version: 1,
      repos: [
        {
          id: 'demo',
          path: repo,
          defaultBranch: 'main',
          github: { owner: 'test', name: 'repo' },
        },
      ],
    }),
  );
  vi.stubEnv('FACTORY_TEST_KEY', 'synthetic-auth-only');
  prepared = undefined;
  finished = false;
  host = {
    prepareLocalAttempt: vi.fn(async (input) => {
      prepared = v.parse(prepareSchema, input);
      return {
        directory: prepared.directory,
        attemptToken: prepared.attemptToken,
      };
    }),
    launchLocalAttempt: vi.fn(async (): Promise<LocalInspection> => ({
      state: 'running',
      receipt: receipt(),
    })),
    inspectLocalAttempt: vi.fn(async (): Promise<LocalInspection> => ({
      state: finished ? 'finished' : 'running',
      receipt: receipt(),
    })),
    reconcileLocalAttempt: vi.fn(async (): Promise<LocalInspection> => ({
      state: 'needs-reconcile',
      reason: 'synthetic uncertain process',
    })),
    cancelLocalAttempt: vi.fn(async (): Promise<LocalInspection> => ({
      state: 'running',
      receipt: receipt(),
    })),
    collectLocalAttempt: vi.fn(async () => ({
      receipt: receipt(),
      baseSha: prepared!.ownedWorktree.baseSha,
      headSha: git(prepared!.ownedWorktree.root, 'rev-parse', 'HEAD'),
      statusRef: '/synthetic/status',
      diffRef: '/synthetic/diff',
      untrackedRef: '/synthetic/untracked',
      includesUntracked: true as const,
    })),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function release(key = 'one', initial?: FactoryDetail) {
  let d =
    initial ??
    submitFactoryWork(
      {
        requestKey: key,
        title: 'Change file',
        body: 'Change file',
        repoId: 'demo',
      },
      actor,
      paths,
    );
  d = saveFactorySpec(
    d.work.id,
    {
      expectedVersion: d.work.version,
      expectedSpecVersion: d.work.specVersion,
      expectedRepoFingerprint: d.repoFingerprint,
      spec: {
        ...emptyFactorySpec(),
        outcome: 'Change file',
        scope: 'file.txt',
        approach: 'Update content',
        acceptanceCriteria: [{ id: 'test', text: 'Content updated' }],
      },
    },
    actor,
    paths,
  );
  return releaseFactoryWork(
    d.work.id,
    {
      requestKey: `release-${key}`,
      expectedVersion: d.work.version,
      specVersion: d.work.specVersion,
      specHash: d.revisions.at(-1)!.hash,
      sourceVersion: d.source.version,
      repoFingerprint: d.repoFingerprint,
      policyVersion: 'isolated-local-v1',
      expectedCodingConfigFingerprint: codingDigest(codingConfig(paths).coding),
    },
    actor,
    paths,
  );
}
function expireLocks() {
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare(
      "UPDATE worktree_locks SET expires_at='2000-01-01T00:00:00.000Z'",
    ).run();
  } finally {
    db.close();
  }
}
describe('factory coding bridge', () => {
  it('keeps executable identity private in run pages, details, and events', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    const identity = run.snapshot.harness.executableIdentity!;
    expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/);
    const routes = createFactoryCodingRoutes(paths);
    const page = v.parse(
      factoryCodingPageSchema,
      await (await routes.request('/runs')).json(),
    );
    const detail = v.parse(
      factoryCodingRunSchema,
      await (await routes.request(`/runs/${run.runId}`)).json(),
    );
    const events = v.parse(
      factoryCodingEventsSchema,
      await (await routes.request(`/runs/${run.runId}/events`)).json(),
    );
    const { provider, version, model } = run.snapshot.harness;
    for (const projection of [
      page.items[0].run,
      detail,
      publicCodingRun(run, paths),
    ]) {
      expect(projection.record.snapshot.harness).toEqual({
        provider,
        version,
        model,
      });
      expect(JSON.stringify(projection)).not.toContain(identity.sha256);
      expect(
        v.parse(factoryCodingRunSchema, projection).record.snapshot.harness,
      ).toEqual({ provider, version, model });
      expect(
        v.safeParse(factoryCodingRunSchema, {
          ...projection,
          record: {
            ...projection.record,
            snapshot: {
              ...projection.record.snapshot,
              harness: run.snapshot.harness,
            },
          },
        }).success,
      ).toBe(false);
    }
    expect(events.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(identity.sha256);
    expect(JSON.stringify(events)).not.toContain(identity.canonical);
    expect(
      getCodingRun(run.runId, paths)?.snapshot.harness.executableIdentity,
    ).toEqual(identity);
    expect(codingConfig(paths).coding.executable).toBe(
      join(root, 'synthetic-codex'),
    );
  });
  it('retains stat-only historical run evidence without granting fresh execution authority', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    const { sha256: _digest, ...statOnly } =
      run.snapshot.harness.executableIdentity!;
    const snapshot = {
      ...run.snapshot,
      harness: { ...run.snapshot.harness, executableIdentity: statOnly },
    };
    rmSync(join(root, 'synthetic-codex'));
    await expect(assertPinnedCodingExecutable(snapshot)).rejects.toThrow(
      'no original executable content digest',
    );
    expect(
      publicCodingRun({ ...run, snapshot }, paths).record.snapshot.harness,
    ).toEqual({
      provider: run.snapshot.harness.provider,
      version: run.snapshot.harness.version,
      model: run.snapshot.harness.model,
    });
  });
  it('pins the default Codex version and freezes admitted configuration', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    expect(run.host?.hostId).toBe('local-cli');
    expect(prepared?.config.adapter).toEqual({
      id: 'codex',
      contractVersion: 1,
      cliVersion: 'codex-cli 0.150.1',
    });
    expect(prepared?.expectedExecutableIdentity).toEqual(
      run.snapshot.harness.executableIdentity,
    );
    expect(run.snapshot.harness.executableIdentity).toBeDefined();
    const original = frozenCodingConfig(run.snapshot);
    updateFactoryConfig(
      {
        coding: {
          ...original,
          model: 'different-model',
          adapter: {
            id: 'kilo',
            contractVersion: 1,
            cliVersion: 'different-version',
          },
          executable: '/synthetic/unselected-cli',
          auth: { kind: 'auth-json', env: 'UNSELECTED_AUTH' },
          path: '/synthetic/new-path',
          wallTimeMs: 1000,
          maxOutputBytes: 1024,
        },
      },
      paths,
    );
    expect(frozenCodingConfig(run.snapshot)).toEqual(original);
    expect(assertCodingAuthoritySnapshot(run.snapshot, paths).coding).toEqual(
      original,
    );
    expect(getCodingRun(run.runId, paths)?.cancelRequestedAt).toBeNull();
    expect((await reconcileCodingRun(run.runId, paths, host)).status).toBe(
      'running',
    );
    finished = true;
    expect((await reconcileCodingRun(run.runId, paths, host)).status).toBe(
      'candidate',
    );
    expect(host.cancelLocalAttempt).not.toHaveBeenCalled();
    expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
  });
  it('keeps the initial attempt frozen when defaults change after reservation during preparation', async () => {
    const work = release();
    const original = codingConfig(paths).coding;
    const prepare = host.prepareLocalAttempt;
    host.prepareLocalAttempt = vi.fn(async (input) => {
      const handle = await prepare(input);
      updateFactoryConfig(
        {
          coding: {
            ...original,
            model: 'future-model',
            auth: { kind: 'api-key', env: 'FUTURE_KEY' },
          },
        },
        paths,
      );
      return handle;
    });
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    expect(run.status).toBe('running');
    expect(run.cancelRequestedAt).toBeNull();
    expect(prepared?.config.model).toBe(original.model);
    expect(prepared?.selectedAuth).toEqual({
      kind: 'api-key',
      value: 'synthetic-auth-only',
    });
    expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
    expect(host.cancelLocalAttempt).not.toHaveBeenCalled();
  });
  it.each(['reviewed', 'historical-null'] as const)(
    'rechecks %s defaults after asynchronous preflight before reservation',
    async (releaseKind) => {
      const work = release();
      if (releaseKind === 'historical-null') {
        const { codingConfigFingerprint: _fingerprint, ...historical } =
          work.releases[0];
        dbRun(paths, (db) =>
          db
            .prepare('UPDATE factory_releases SET record=? WHERE id=?')
            .run(JSON.stringify(historical), historical.id),
        );
        expect(
          getFactoryWork(work.work.id, paths).releases[0]
            .codingConfigFingerprint,
        ).toBeNull();
        expect(codingConfig(paths).coding.adapter).toBeNull();
      }
      const inspect = codingRuns.inspectCodingExecutableIdentity;
      const probe = vi
        .spyOn(codingRuns, 'inspectCodingExecutableIdentity')
        .mockImplementationOnce(async (executable) => {
          const identity = await inspect(executable);
          updateFactoryConfig(
            {
              coding: {
                ...codingConfig(paths).coding,
                model: 'changed-during-preflight',
              },
            },
            paths,
          );
          return identity;
        });
      try {
        expect(
          await dispatchCodingWork(work.work.id, paths, host, ready),
        ).toBeNull();
        expect(listCodingRuns({}, paths)).toHaveLength(0);
        expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
        expect(readCodingAttention(work.work.id, paths)?.reason).toContain(
          releaseKind === 'historical-null'
            ? 'changed during admission preflight'
            : 'since human release',
        );
        expect(
          getFactoryWork(work.work.id, paths).releases[0]
            .codingConfigFingerprint,
        ).toBe(
          releaseKind === 'historical-null'
            ? null
            : work.releases[0].codingConfigFingerprint,
        );
      } finally {
        probe.mockRestore();
      }
    },
  );
  it('treats explicit factory disable as a durable stop even when defaults are later restored', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    updateFactoryConfig({ enabled: false }, paths);
    expect(getCodingRun(run.runId, paths)?.cancelRequestedAt).toBeTruthy();
    updateFactoryConfig({ enabled: true }, paths);
    expect(getCodingRun(run.runId, paths)?.cancelRequestedAt).toBeTruthy();
    await reconcileCodingRun(run.runId, paths, host);
    expect(host.cancelLocalAttempt).toHaveBeenCalled();
  });
  it('blocks queued configuration drift with retained attention before host allocation', async () => {
    const work = release();
    updateFactoryConfig(
      {
        coding: {
          ...codingConfig(paths).coding,
          model: 'changed-after-release',
        },
      },
      paths,
    );
    expect(
      await dispatchCodingWork(work.work.id, paths, host, ready),
    ).toBeNull();
    expect(readCodingAttention(work.work.id, paths)?.reason).toContain(
      'since human release',
    );
    expect(listCodingRuns({}, paths)).toHaveLength(0);
    expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
  });
  it('normalizes historical config and release records without authorizing a new adapter', async () => {
    const work = release();
    const snapshot = await codingSnapshot(
      work.work.id,
      'codex-cli 0.150.1',
      paths,
    );
    const { adapter: _adapter, ...legacyCoding } = codingConfig(paths).coding;
    const legacySnapshot = {
      ...snapshot,
      policySnapshot: JSON.stringify({
        release: work.releases[0].policy,
        coding: legacyCoding,
      }),
    };
    const { codingConfigFingerprint: _fingerprint, ...legacyRelease } =
      work.releases[0];
    dbRun(paths, (db) =>
      db
        .prepare('UPDATE factory_releases SET record=? WHERE id=?')
        .run(JSON.stringify(legacyRelease), legacyRelease.id),
    );
    expect(() =>
      assertCodingAuthoritySnapshot(legacySnapshot, paths),
    ).not.toThrow();
    const { executableIdentity: _identity, ...legacyHarness } =
      legacySnapshot.harness;
    await expect(
      assertPinnedCodingExecutable({
        ...legacySnapshot,
        harness: legacyHarness,
      }),
    ).rejects.toThrow(
      'legacy coding attempt has no original executable identity',
    );
    updateFactoryConfig(
      {
        coding: {
          ...codingConfig(paths).coding,
          adapter: { id: 'opencode', contractVersion: 1, cliVersion: '1.0.0' },
        },
      },
      paths,
    );
    expect(
      await dispatchCodingWork(work.work.id, paths, host, ready),
    ).toBeNull();
    expect(readCodingAttention(work.work.id, paths)?.reason).toContain(
      'Legacy release',
    );
    expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
  });
  it('claims preparation once across concurrent controllers and replay', async () => {
    const work = release();
    const results = await Promise.allSettled([
      dispatchCodingWork(work.work.id, paths, host, ready),
      dispatchCodingWork(work.work.id, paths, host, ready),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(host.prepareLocalAttempt).toHaveBeenCalledTimes(1);
    expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
    expect(listActiveRepoWorktrees('demo', paths)).toHaveLength(1);
    expect(listCodingRuns({}, paths)).toHaveLength(1);
    await dispatchCodingWork(work.work.id, paths, host, ready);
    expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe('original\n');
    expect(prepared!.prompt).toContain('Run npm test');
    expect(prepared!.prompt).not.toContain('synthetic-auth-only');
  });
  it('keeps a released source valid across observational refresh, but fences changed content', async () => {
    const github = {
      ...connection,
      repoId: 'demo',
      owner: 'test',
      name: 'repo',
    };
    const config = JSON.parse(readFileSync(paths.config, 'utf8'));
    config.factory.github = [github];
    writeFileSync(paths.config, JSON.stringify(config));
    const input = { ...github, connectionId: github.id, issue };
    const initial = dbRun(paths, (db) =>
      reconcileGitHubSource(db, input, paths),
    );
    const released = release('github-refresh', initial);
    const run = (await dispatchCodingWork(
      released.work.id,
      paths,
      host,
      ready,
    ))!;
    const frozenSource = run.snapshot.sourceSnapshot;
    const refreshed = dbRun(paths, (db) =>
      reconcileGitHubSource(
        db,
        {
          ...input,
          issue: { ...issue, updated_at: '2026-09-02T00:00:00Z' },
        },
        paths,
      ),
    );
    expect(refreshed.source.version).toBe(released.source.version);
    expect(refreshed.source.attention).toBeNull();
    const stillRunning = await reconcileCodingRun(run.runId, paths, host);
    expect(stillRunning.status).toBe('running');
    expect(stillRunning.cancelRequestedAt).toBeNull();
    expect(stillRunning.snapshot.sourceSnapshot).toBe(frozenSource);
    expect(host.cancelLocalAttempt).not.toHaveBeenCalled();
    dbRun(paths, (db) =>
      reconcileGitHubSource(
        db,
        {
          ...input,
          issue: {
            ...issue,
            body: 'Deliberately changed brief',
            updated_at: '2026-09-03T00:00:00Z',
          },
        },
        paths,
      ),
    );
    expect(getCodingRun(run.runId, paths)?.cancelRequestedAt).not.toBeNull();
    await reconcileCodingRun(run.runId, paths, host);
    expect(host.cancelLocalAttempt).toHaveBeenCalled();
  });
  it('collects a candidate after restart and retains unpublished clean commits under force cleanup', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    writeFileSync(
      join(prepared!.ownedWorktree.root, 'file.txt'),
      'candidate\n',
    );
    git(prepared!.ownedWorktree.root, 'add', '.');
    git(prepared!.ownedWorktree.root, 'commit', '-m', 'candidate');
    finished = true;
    const result = await reconcileCodingRun(run.runId, paths, host);
    expect(result.status).toBe('candidate');
    expect(getFactoryWork(work.work.id, paths).work.lifecycle).toBe('queued');
    const projection = publicCodingRun(result, paths);
    expect(projection.displayStatus).toBe('candidate-awaiting-review');
    expect(projection.diff?.preparedDiffId).toBeTruthy();
    expect(
      readPreparedDiff(projection.diff!.preparedDiffId, paths)
        ?.pushApprovalStatus,
    ).toBe('not-requested');
    const approvalDb = openDb(paths.neondeckDatabase);
    try {
      expect(
        approvalDb
          .prepare(
            'SELECT id FROM prepared_diff_approvals WHERE prepared_diff_id=?',
          )
          .all(projection.diff!.preparedDiffId),
      ).toHaveLength(0);
    } finally {
      approvalDb.close();
    }

    expect(JSON.stringify(projection)).not.toContain(result.ownershipToken);
    expect(projection.record).not.toHaveProperty('host');
    expect(projection.record).not.toHaveProperty('deadProof');
    expireLocks();
    const cleanup = await cleanupWorktrees(
      {
        worktreeId: result.workspace!.worktreeId,
        force: true,
        confirmPreparedDiff: true,
      },
      paths,
    );
    expect(cleanup.ok).toBe(true);
    expect('results' in cleanup && cleanup.results[0].outcome).toBe('retained');
    expect(
      (
        await lockWorktree(
          { worktreeId: result.workspace!.worktreeId, owner: 'generic' },
          paths,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await syncWorktree(
          { worktreeId: result.workspace!.worktreeId, force: true },
          paths,
        )
      ).ok,
    ).toBe(false);
    expect(() =>
      assertWorktreeMutationAllowed(
        { repoId: 'demo', worktreeId: result.workspace!.worktreeId },
        paths,
      ),
    ).toThrow('Factory');
    const diff = projection.diff!.preparedDiffId;
    expect(
      (
        await requestPreparedDiffRevision(
          { preparedDiffId: diff, instructions: 'repair' },
          paths,
        )
      ).ok,
    ).toBe(false);
    expect(() =>
      markPreparedDiffPushed(
        diff,
        {
          commitSha: result.candidate!.headSha,
          remote: 'origin',
          branch: 'main',
        },
        paths,
      ),
    ).toThrow('Factory');
    expect(() =>
      approvePreparedDiffPushState(
        diff,
        {
          approvedCommitSha: result.candidate!.headSha,
          policyHash: 'test',
          policyDecision: 'allow',
          reason: undefined,
          approverSurface: undefined,
          approvedAt: new Date().toISOString(),
        },
        paths,
      ),
    ).toThrow('Factory');
    expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
  });
  it('fences stale credential changes during preparation without launch or automatic retry', async () => {
    const work = release();
    host.prepareLocalAttempt = vi.fn(async (input) => {
      prepared = v.parse(prepareSchema, input);
      vi.stubEnv('FACTORY_TEST_KEY', 'changed-synthetic-auth');
      return {
        directory: prepared.directory,
        attemptToken: prepared.attemptToken,
      };
    });
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    expect(run.status).toBe('needs-reconcile');
    expect(run.cancelRequestedAt).toBeTruthy();
    expect(host.launchLocalAttempt).not.toHaveBeenCalled();
    await dispatchCodingWork(work.work.id, paths, host, ready);
    expect(host.prepareLocalAttempt).toHaveBeenCalledTimes(1);
  });
  it('cancels invalidated release after restart and keeps uncertain locks', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    const current = getFactoryWork(work.work.id, paths);
    transitionFactoryWork(
      work.work.id,
      { expectedVersion: current.work.version, action: 'pause' },
      actor,
      paths,
    );
    host.inspectLocalAttempt = vi.fn(async (): Promise<LocalInspection> => ({
      state: 'needs-reconcile',
      reason: 'synthetic missing receipt',
    }));
    const result = await reconcileCodingRun(run.runId, paths, host);
    expect(result.status).toBe('needs-reconcile');
    expect(result.cancelRequestedAt).toBeTruthy();
    expect(host.cancelLocalAttempt).toHaveBeenCalled();
    expireLocks();
    expect(
      (await releaseWorktreeLock({ lockId: run.workspace!.lockId }, paths)).ok,
    ).toBe(false);
    const cleanup = await cleanupWorktrees(
      { worktreeId: run.workspace!.worktreeId, force: true },
      paths,
    );
    expect('results' in cleanup && cleanup.results[0].outcome).toBe('retained');
  });
  it('retains create-to-bind crash gap using existing owner association', async () => {
    const work = release();
    const snapshot = await codingSnapshot(
      work.work.id,
      'codex-cli 0.150.1',
      paths,
    );
    const run = reserveCodingRun(snapshot, paths);
    const result = await createWorktree(
      {
        repoId: 'demo',
        headSha: snapshot.baseSha,
        baseRef: snapshot.baseSha,
        headRef: `agent/factory-${run.attemptId}`,
        workflowRunId: run.runId,
      },
      paths,
      run,
    );
    expect(result.ok).toBe(true);
    expect(getCodingRun(run.runId, paths)!.workspace).toBeNull();
    const record = listActiveRepoWorktrees('demo', paths)[0];
    const cleanup = await cleanupWorktrees(
      { worktreeId: record.id, force: true },
      paths,
    );
    expect('results' in cleanup && cleanup.results[0].outcome).toBe('retained');
    expect(
      (
        await lockWorktree(
          {
            worktreeId: record.id,
            owner: 'other',
            workflowRunId: run.runId,
            factoryClaim: run,
          },
          paths,
        )
      ).ok,
    ).toBe(false);
  });
  it('rejects stale config edits and bounded API requests; exposes no launch route', async () => {
    const old = codingDigest(codingConfig(paths).coding);
    writeFileSync(
      paths.config,
      JSON.stringify({
        version: 1,
        factory: { enabled: true, coding: { enabled: false } },
      }),
    );
    await expect(
      saveFactoryCodingConfig(
        {
          expectedFingerprint: old,
          config: v.parse(factoryCodingConfigSchema, {}),
        },
        paths,
      ),
    ).rejects.toThrow('configuration changed');
    const routes = createFactoryCodingRoutes(paths);
    expect((await routes.request('/runs?limit=101')).status).toBe(400);
    expect((await routes.request('/runs?after=-1')).status).toBe(400);
    expect((await routes.request('/launch', { method: 'POST' })).status).toBe(
      404,
    );
    expect(factoryCodingRuns({ workItemId: 'none' }, paths).items).toEqual([]);
  });
  it('persists cancellation across disable/re-enable without a polling tick', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    updateFactoryConfig(
      { coding: { ...codingConfig(paths).coding, enabled: false } },
      paths,
    );
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeTruthy();
    updateFactoryConfig(
      { coding: { ...codingConfig(paths).coding, enabled: true } },
      paths,
    );
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeTruthy();
    await reconcileCodingRun(run.runId, paths, host);
    expect(host.cancelLocalAttempt).toHaveBeenCalled();
  });
  it('retains committed cancellation when host publication fails and redelivers without stealing an uncertain gate', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    const handle = codingHandle(run, paths);
    const gate = `${handle.directory}.authorization-gate`;
    mkdirSync(gate, { recursive: true, mode: 0o700 });
    const current = getFactoryWork(work.work.id, paths);
    expect(() =>
      transitionFactoryWork(
        work.work.id,
        { expectedVersion: current.work.version, action: 'pause' },
        actor,
        paths,
      ),
    ).toThrow('gate is uncertain');
    expect(getFactoryWork(work.work.id, paths).work.lifecycle).toBe('paused');
    expect(getCodingRun(run.runId, paths)?.cancelRequestedAt).toBeTruthy();
    expect(existsSync(gate)).toBe(true);
    expect(existsSync(`${handle.directory}.cancel.json`)).toBe(false);
    // Only the test owner removes its own fixture gate; production never steals it.
    rmSync(gate, { recursive: true });
    fenceInvalidFactoryCoding(paths);
    expect(existsSync(`${handle.directory}.cancel.json`)).toBe(true);
    expect(
      publicCodingRun(getCodingRun(run.runId, paths)!, paths).displayStatus,
    ).toBe('cancelling');
    expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
  });
  it('fences release pause synchronously and rejects verification even without its optional lock', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    const current = getFactoryWork(work.work.id, paths);
    transitionFactoryWork(
      work.work.id,
      { expectedVersion: current.work.version, action: 'pause' },
      actor,
      paths,
    );
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeTruthy();
    const runCheck = vi.fn();
    await expect(
      verifyWorktreeChecks(
        {
          worktreeId: run.workspace!.worktreeId,
          checks: ['test'],
          lock: false,
        },
        paths,
        { runCheck },
      ),
    ).rejects.toThrow('Factory');
    expect(runCheck).not.toHaveBeenCalled();
  });
  it('retains reservation after prepare failure and never allocates a second worktree', async () => {
    const work = release();
    host.prepareLocalAttempt = vi.fn(async () => {
      throw new Error('synthetic crash during preparation');
    });
    host.cancelLocalAttempt = vi.fn(async () => {
      throw new Error('no authenticated manifest');
    });
    host.inspectLocalAttempt = vi.fn(async (): Promise<LocalInspection> => ({
      state: 'needs-reconcile',
      reason: 'no authenticated manifest',
    }));
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    expect(run.status).toBe('needs-reconcile');
    expect(run.workspace).not.toBeNull();
    await dispatchCodingWork(work.work.id, paths, host, ready);
    await reconcileCodingRun(run.runId, paths, host);
    expect(host.prepareLocalAttempt).toHaveBeenCalledTimes(1);
    expect(host.launchLocalAttempt).not.toHaveBeenCalled();
    expect(listActiveRepoWorktrees('demo', paths)).toHaveLength(1);
    const other = release('two');
    await expect(
      dispatchCodingWork(other.work.id, paths, host, ready),
    ).rejects.toThrow('writer already reserved');
  });
  it('quarantines failed evidence collection without releasing workspace or accepting candidate', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    finished = true;
    host.collectLocalAttempt = vi.fn(async () => {
      throw new Error('synthetic evidence changed');
    });
    const result = await reconcileCodingRun(run.runId, paths, host);
    expect(result.status).toBe('needs-reconcile');
    expect(result.deadProof).toBeNull();
    expect(result.candidate).toBeNull();
  });
  it('shares readiness failures between loop and HTTP polling, recovers credentials, and still reconciles while disabled', async () => {
    const executable = join(root, 'synthetic-codex');
    writeFileSync(executable, 'unsupported fixture');
    updateFactoryConfig(
      { coding: { ...codingConfig(paths).coding, executable } },
      paths,
    );
    const work = release();
    const probe = vi
      .spyOn(codingRuns, 'inspectCodingAdapterReadiness')
      .mockResolvedValue({
        ready: false,
        version: '',
        reason: 'unsupported-cli-version',
      });
    try {
      vi.stubEnv('FACTORY_TEST_KEY', '');
      const app = createFactoryCodingRoutes(paths);
      for (let n = 0; n < 3; n++) {
        await tickFactoryCoding(paths, host);
        expect((await app.request('/state')).status).toBe(200);
      }
      expect(probe).not.toHaveBeenCalled();
      expect(readCodingAttention(work.work.id, paths)).toBeNull();
      vi.stubEnv('FACTORY_TEST_KEY', 'synthetic-auth-now-present');
      for (let n = 0; n < 3; n++) {
        await tickFactoryCoding(paths, host);
        const state: unknown = await (await app.request('/state')).json();
        expect(JSON.stringify(state)).not.toContain(
          'synthetic-auth-now-present',
        );
        expect(state).toMatchObject({
          readiness: {
            ready: false,
            installedVersion: null,
            blockers: ['unsupported-cli-version'],
          },
        });
      }
      expect(probe).toHaveBeenCalledTimes(1);
      expect(listCodingRuns({}, paths)).toHaveLength(0);
      expect(readCodingAttention(work.work.id, paths)).toBeNull();
      writeFileSync(executable, 'supported replacement fixture');
      probe.mockResolvedValue({
        ready: true,
        version: 'codex-cli 0.150.1',
        reason: null,
      });
      await tickFactoryCoding(paths, host);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
      const run = listCodingRuns({}, paths)[0].record;
      updateFactoryConfig(
        { coding: { ...codingConfig(paths).coding, enabled: false } },
        paths,
      );
      finished = true;
      await tickFactoryCoding(paths, host);
      expect(getCodingRun(run.runId, paths)?.status).toBe('cancelled');
      expect(host.cancelLocalAttempt).toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      probe.mockRestore();
    }
  });
  it('keeps disabled work unreserved and requires authenticated current HTTP control version', async () => {
    const work = release();
    expect(
      await dispatchCodingWork(work.work.id, paths, host, async () => ({
        ...(await ready()),
        ready: false,
      })),
    ).toBeNull();
    expect(listCodingRuns({}, paths)).toHaveLength(0);
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    const routes = createFactoryCodingRoutes(paths);
    const response = await routes.request(`/runs/${run.runId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    expect(response.status).toBe(409);
    expect(getCodingRun(run.runId, paths)!.cancelRequestedAt).toBeNull();
  });
  it.each(['output-limit', 'credential-cleanup-failed'])(
    'rejects completed exit-zero receipts with fatal %s',
    async (reason) => {
      const work = release();
      const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
      finished = true;
      const original = host.collectLocalAttempt;
      host.collectLocalAttempt = vi.fn(async (input) => {
        const evidence = await original(input);
        return {
          ...evidence,
          receipt: {
            ...evidence.receipt,
            reason,
            authCleanup:
              reason === 'credential-cleanup-failed'
                ? ('failed' as const)
                : ('removed' as const),
          },
        };
      });
      const result = await reconcileCodingRun(run.runId, paths, host);
      expect(result.status).toBe('failed');
      expect(result.candidate).toBeNull();
      expect(result.reason).toContain(
        reason === 'credential-cleanup-failed' ? 'credential-cleanup' : reason,
      );
    },
  );
  it('keeps frozen memory context through unrelated learning updates', async () => {
    const work = release();
    const run = (await dispatchCodingWork(work.work.id, paths, host, ready))!;
    const frozen = run.snapshot.contextSnapshot;
    const memory = await upsertMemory(
      {
        scope: 'user',
        key: 'response-style',
        value: 'Prefer concise explanations.',
      },
      paths,
    );
    expect(memory.ok).toBe(true);
    const result = await reconcileCodingRun(run.runId, paths, host);
    expect(result.status).toBe('running');
    expect(result.cancelRequestedAt).toBeNull();
    expect(result.snapshot.contextSnapshot).toBe(frozen);
    expect(host.cancelLocalAttempt).not.toHaveBeenCalled();
  });
  it('returns latest of 27 persisted runs first and continues older pages stably', async () => {
    const work = release();
    const snapshot = await codingSnapshot(
      work.work.id,
      'codex-cli 0.150.1',
      paths,
    );
    const ids: string[] = [];
    const finish = (run: ReturnType<typeof reserveCodingRun>) =>
      updateCodingRun(
        {
          runId: run.runId,
          attemptId: run.attemptId,
          ownershipToken: run.ownershipToken,
          expectedVersion: run.version,
          action: {
            type: 'finish',
            status: 'failed',
            reason: 'Historical synthetic attempt',
            proof: {
              runId: run.runId,
              attemptId: run.attemptId,
              ownershipToken: run.ownershipToken,
              host: null,
              kind: 'never-started',
              evidenceRef: 'synthetic-history',
            },
          },
        },
        paths,
      );
    for (let index = 1; index <= 27; index++) {
      const run = reserveCodingRun(
        {
          ...snapshot,
          requestId: `history-${index}`,
          releaseId: `history-release-${index}`,
        },
        paths,
      );
      ids.push(run.runId);
      if (index < 27) finish(run);
    }
    const routes = createFactoryCodingRoutes(paths);
    const first = v.parse(
      factoryCodingPageSchema,
      await (
        await routes.request(`/runs?workId=${work.work.id}&limit=25`)
      ).json(),
    );
    expect(first.items).toHaveLength(25);
    expect(first.items[0].run.record.runId).toBe(ids[26]);
    expect(first.items[0].run.displayStatus).toBe('reserved');
    expect(first.nextCursor).toBe(3);
    finish(getCodingRun(ids[26], paths)!);
    reserveCodingRun(
      {
        ...snapshot,
        requestId: 'history-new',
        releaseId: 'history-release-new',
      },
      paths,
    );
    const older = v.parse(
      factoryCodingPageSchema,
      await (
        await routes.request(
          `/runs?workId=${work.work.id}&limit=25&after=${first.nextCursor}`,
        )
      ).json(),
    );
    expect(older.items.map((item) => item.run.record.runId)).toEqual([
      ids[1],
      ids[0],
    ]);
    expect(older.nextCursor).toBeNull();
    expect(listCodingRuns({ limit: 1 }, paths)[0].record.runId).toBe(ids[0]);
  });
  it.each(['missing-base', 'oversized-instructions'])(
    'persists actionable %s attention and skips unchanged expensive preflight',
    async (mode) => {
      const work = release();
      if (mode === 'missing-base') git(repo, 'branch', '-m', 'main', 'other');
      else {
        writeFileSync(join(repo, 'AGENTS.md'), 'Instructions '.repeat(4000));
        git(repo, 'add', 'AGENTS.md');
        git(repo, 'commit', '-m', 'large instructions');
      }
      const readiness = vi.fn(ready);
      expect(
        await dispatchCodingWork(work.work.id, paths, host, readiness),
      ).toBeNull();
      const routes = createFactoryCodingRoutes(paths);
      const response = v.parse(
        factoryCodingPageSchema,
        await (await routes.request(`/runs?workId=${work.work.id}`)).json(),
      );
      expect(response.items).toEqual([]);
      expect(response.attention?.reason).toContain(
        mode === 'missing-base'
          ? 'default branch is unavailable'
          : 'Cannot freeze',
      );
      expect(
        await dispatchCodingWork(work.work.id, paths, host, readiness),
      ).toBeNull();
      expect(readiness).toHaveBeenCalledTimes(1);
      expect(listCodingRuns({}, paths)).toEqual([]);
      if (mode === 'missing-base') git(repo, 'branch', '-m', 'other', 'main');
      else {
        writeFileSync(join(repo, 'AGENTS.md'), 'Run tests.');
        git(repo, 'add', 'AGENTS.md');
        git(repo, 'commit', '-m', 'bounded instructions');
      }
      expect(
        (await dispatchCodingWork(work.work.id, paths, host, readiness))
          ?.status,
      ).toBe('running');
      expect(readiness).toHaveBeenCalledTimes(2);
      expect(
        factoryCodingRuns({ workItemId: work.work.id }, paths).attention,
      ).toBeNull();
    },
  );
});
