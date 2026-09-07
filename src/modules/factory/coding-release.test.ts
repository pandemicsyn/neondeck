import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyFactorySpec } from '../../../shared/factory';
import type { FactoryCodingConfig } from '../../../shared/factory-coding';
import {
  ensureRuntimeHome,
  runtimePaths,
  type RuntimePaths,
} from '../../runtime-home';
import * as v from 'valibot';
import { prepareSchema, listCodingRuns } from '../coding-runs';
import {
  codingConfig,
  codingDigest,
  codingSnapshot,
  assertReleasedCodingConfig,
  assertCodingAuthoritySnapshot,
} from './coding-context';
import { dispatchCodingWork, type CodingHost } from './coding-service';
import {
  submitFactoryWork,
  saveFactorySpec,
  releaseFactoryWork,
  getFactoryWork,
} from './service';

let root: string;
let paths: RuntimePaths;
const actor = { kind: 'human' as const, id: 'synthetic-operator' };
function configure(changes: Partial<FactoryCodingConfig>) {
  const coding = { ...codingConfig(paths).coding, ...changes };
  writeFileSync(
    paths.config,
    JSON.stringify({ version: 1, factory: { enabled: true, coding } }),
  );
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'factory-release-'));
  paths = runtimePaths(join(root, 'runtime'));
  await ensureRuntimeHome(paths);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-b', 'main');
  git(
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=test@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
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
          github: { owner: 'example', name: 'demo' },
        },
      ],
    }),
  );
  const executable = join(root, 'synthetic-cli');
  writeFileSync(executable, 'synthetic identity only');
  vi.stubEnv('FACTORY_RELEASE_TEST_KEY', 'synthetic-auth-only');
  configure({
    enabled: false,
    executable,
    model: 'synthetic-model',
    auth: { kind: 'api-key', env: 'FACTORY_RELEASE_TEST_KEY' },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function readyWork() {
  const work = submitFactoryWork(
    {
      requestKey: 'intake',
      title: 'Synthetic task',
      body: 'Update file',
      repoId: 'demo',
    },
    actor,
    paths,
  );
  return saveFactorySpec(
    work.work.id,
    {
      expectedVersion: work.work.version,
      expectedSpecVersion: work.work.specVersion,
      expectedRepoFingerprint: work.repoFingerprint,
      spec: {
        ...emptyFactorySpec(),
        outcome: 'Update file',
        scope: 'file.txt',
        approach: 'Edit file',
        acceptanceCriteria: [{ id: 'ac', text: 'File updated' }],
      },
    },
    actor,
    paths,
  );
}
function release() {
  const work = readyWork();
  return releaseFactoryWork(work.work.id, releaseInput(work), actor, paths);
}
function releaseInput(work: ReturnType<typeof readyWork>) {
  return {
    requestKey: 'release',
    expectedVersion: work.work.version,
    specVersion: work.work.specVersion,
    specHash: work.revisions.at(-1)!.hash,
    sourceVersion: work.source.version,
    repoFingerprint: work.repoFingerprint,
    policyVersion: 'isolated-local-v1',
    expectedCodingConfigFingerprint: codingDigest(codingConfig(paths).coding),
  };
}
const readiness = async () => ({
  ready: true,
  enabled: true,
  supportedVersion: 'synthetic',
  installedVersion: 'codex-cli 0.150.1',
  blockers: [],
});
function mockHost(): CodingHost {
  const uncertain = async () => ({
    state: 'needs-reconcile' as const,
    reason: 'synthetic host',
  });
  return {
    prepareLocalAttempt: vi.fn<CodingHost['prepareLocalAttempt']>(
      async (input: unknown) => {
        const parsed = v.parse(prepareSchema, input);
        return {
          directory: parsed.directory,
          attemptToken: parsed.attemptToken,
        };
      },
    ),
    launchLocalAttempt: vi.fn<CodingHost['launchLocalAttempt']>(uncertain),
    inspectLocalAttempt: vi.fn<CodingHost['inspectLocalAttempt']>(uncertain),
    reconcileLocalAttempt:
      vi.fn<CodingHost['reconcileLocalAttempt']>(uncertain),
    cancelLocalAttempt: vi.fn<CodingHost['cancelLocalAttempt']>(uncertain),
    collectLocalAttempt: vi.fn<CodingHost['collectLocalAttempt']>(),
  };
}
it('blocks disabled queued work before allocating a run or host', async () => {
  const work = release();
  const host = mockHost();
  await expect(
    dispatchCodingWork(work.work.id, paths, host, readiness),
  ).rejects.toThrow('disabled');
  expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
  expect(host.launchLocalAttempt).not.toHaveBeenCalled();
  expect(listCodingRuns({}, paths)).toEqual([]);
});
it.each([false, true])(
  'admits a persisted full digest released with enabled=%s, without rewriting it',
  async (enabled) => {
    configure({ enabled });
    const work = release();
    const host = mockHost();
    configure({ enabled: true });
    const run = await dispatchCodingWork(work.work.id, paths, host, readiness);
    expect(run).not.toBeNull();
    expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
    expect(() =>
      assertCodingAuthoritySnapshot(run!.snapshot, paths),
    ).not.toThrow();
    expect(getFactoryWork(work.work.id, paths).releases).toEqual(work.releases);
    configure({ enabled: false });
    expect(() => assertCodingAuthoritySnapshot(run!.snapshot, paths)).toThrow(
      'disabled',
    );
  },
);
const mutations: Partial<FactoryCodingConfig>[] = [
  { adapter: { id: 'opencode', contractVersion: 1, cliVersion: '1.0.0' } },
  { executable: '/synthetic/other-cli' },
  { model: 'other-model' },
  { auth: { kind: 'api-key', env: 'SYNTHETIC_KEY' } },
  { auth: { kind: 'codex-local', path: '/synthetic/auth.json' } },
  { path: '/synthetic/bin:/usr/bin' },
  { wallTimeMs: 1000 },
  { maxOutputBytes: 1024 },
];
it.each(mutations)(
  'rejects enabled plus reviewed setting drift: %j',
  async (mutation) => {
    const work = release();
    configure({ enabled: true });
    const snapshot = await codingSnapshot(work.work.id, 'synthetic', paths);
    configure(mutation);
    expect(() => assertReleasedCodingConfig(work.work.id, paths)).toThrow(
      'since human release',
    );
    const host = mockHost();
    expect(
      await dispatchCodingWork(work.work.id, paths, host, readiness),
    ).toBeNull();
    expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
    expect(listCodingRuns({}, paths)).toEqual([]);
    // Existing attempts keep their frozen selection, but cannot substitute new settings.
    expect(() => assertCodingAuthoritySnapshot(snapshot, paths)).not.toThrow();
    const coding = codingConfig(paths).coding;
    expect(() =>
      assertCodingAuthoritySnapshot(
        {
          ...snapshot,
          policySnapshot: JSON.stringify({
            release: work.releases[0].policy,
            coding,
          }),
          harness: {
            ...snapshot.harness,
            provider: coding.adapter?.id ?? 'codex',
            model: coding.model!,
            version: coding.adapter?.cliVersion ?? 'synthetic',
          },
        },
        paths,
      ),
    ).toThrow('Frozen coding authority changed');
  },
);
it('still rejects an enabled-only change to a fresh reviewed release request', () => {
  const work = readyWork();
  const input = releaseInput(work);
  configure({ enabled: true });
  expect(() => releaseFactoryWork(work.work.id, input, actor, paths)).toThrow(
    'Coding configuration changed',
  );
  expect(getFactoryWork(work.work.id, paths).releases).toEqual([]);
});
it('blocks launch if coding is disabled after host preparation', async () => {
  const work = release();
  configure({ enabled: true });
  const host = mockHost();
  vi.mocked(host.prepareLocalAttempt).mockImplementation(async (input) => {
    configure({ enabled: false });
    const parsed = v.parse(prepareSchema, input);
    return { directory: parsed.directory, attemptToken: parsed.attemptToken };
  });
  const run = await dispatchCodingWork(work.work.id, paths, host, readiness);
  expect(run?.cancelRequestedAt).toBeTruthy();
  expect(host.prepareLocalAttempt).toHaveBeenCalledTimes(1);
  expect(host.launchLocalAttempt).not.toHaveBeenCalled();
});
