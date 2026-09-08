import { factoryValidationPolicy } from './validation-policy';
import * as gitIo from '../../lib/git';
import * as runtime from '../runtime';
import { captureContext } from './planning-context';
import { localCodingConfig } from './coding-readiness';
import { openDb } from '../../lib/sqlite';
import { prepareFactoryPlanning, updatePlanningIntent } from './planning-store';
import { clearCodingAttention } from './coding-attention';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
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
import {
  prepareSchema,
  listCodingRuns,
  reserveCodingRun,
} from '../coding-runs';
import {
  codingAuthority,
  codingConfig,
  codingDigest,
  codingSnapshot,
  assertReleasedCodingConfig,
  assertCodingAuthoritySnapshot,
  assertCodingSnapshot,
  codingPrompt,
  freezeCodingContext,
  frozenCodingConfig,
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
    JSON.stringify({
      version: 1,
      models: { prReview: 'faux/faux-1' },
      guardrails: { requiredChecks: ['npm test'] },
      factory: { enabled: true, coding },
    }),
  );
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'factory-release-'));
  paths = runtimePaths(join(root, 'runtime'));
  vi.stubEnv('NEONDECK_HOME', paths.home);
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
  vi.restoreAllMocks();
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
    validationPolicy: factoryValidationPolicy('demo', paths),
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

function fixtureGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}
function remoteFixture() {
  const repo = join(root, 'repo'),
    remote = join(root, 'origin.git'),
    upstream = join(root, 'upstream');
  fixtureGit(root, 'clone', '--bare', repo, remote);
  fixtureGit(repo, 'remote', 'add', 'origin', remote);
  fixtureGit(root, 'clone', remote, upstream);
  const push = () => {
    writeFileSync(
      join(upstream, 'AGENTS.md'),
      'Use the new remote instructions',
    );
    fixtureGit(upstream, 'add', 'AGENTS.md');
    fixtureGit(
      upstream,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'Remote instructions',
    );
    fixtureGit(upstream, 'push', 'origin', 'main');
    return fixtureGit(upstream, 'rev-parse', 'HEAD');
  };
  return { repo, remote, push };
}
it('captures planning and initial coding at distinct times, then reuses the frozen coding attempt without fetching', async () => {
  configure({ enabled: true });
  const { repo, push } = remoteFixture();
  const work = readyWork();
  const planning = await prepareFactoryPlanning(
    work.work.id,
    { requestKey: 'plan', expectedVersion: work.work.version, message: 'Plan' },
    paths,
  );
  updatePlanningIntent(
    planning.id,
    (intent) => {
      intent.stage = 'completed';
    },
    paths,
  );
  const sha = push();
  fixtureGit(repo, 'checkout', '-b', 'operator');
  writeFileSync(join(repo, 'dirty.txt'), 'Operator work');
  const head = fixtureGit(repo, 'rev-parse', 'HEAD');
  const main = fixtureGit(repo, 'rev-parse', 'main');
  releaseFactoryWork(work.work.id, releaseInput(work), actor, paths);
  const host = mockHost();
  const run = await dispatchCodingWork(work.work.id, paths, host, readiness);
  expect(run?.snapshot.baseSha).toBe(sha);
  expect(planning.context.repoCommit).not.toBe(sha);
  expect(JSON.parse(run!.snapshot.contextSnapshot)).toMatchObject({
    repoBaseline: {
      source: 'origin',
      branch: 'main',
      ref: `refs/neondeck/factory/commits/${sha}`,
    },
    repoInstructions: { commit: sha, text: 'Use the new remote instructions' },
  });
  expect(fixtureGit(repo, 'rev-parse', 'HEAD')).toBe(head);
  expect(fixtureGit(repo, 'rev-parse', 'main')).toBe(main);
  expect(fixtureGit(repo, 'branch', '--show-current')).toBe('operator');
  expect(readFileSync(join(repo, 'dirty.txt'), 'utf8')).toBe('Operator work');
  fixtureGit(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  const spy = vi.spyOn(gitIo, 'runUnattendedGit');
  expect(
    (await dispatchCodingWork(work.work.id, paths, host, readiness))?.snapshot,
  ).toEqual(run!.snapshot);
  expect(spy).not.toHaveBeenCalled();
  expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
});
it('fails initial coding on remote errors before reserving resources, without a stale local fallback', async () => {
  configure({ enabled: true });
  const { repo } = remoteFixture();
  fixtureGit(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  const work = release(),
    host = mockHost();
  expect(
    await dispatchCodingWork(work.work.id, paths, host, readiness),
  ).toBeNull();
  expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
  expect(listCodingRuns({}, paths)).toEqual([]);
  await expect(
    codingSnapshot(work.work.id, 'synthetic', paths),
  ).rejects.toThrow(/No stale local fallback/);
  expect(
    fixtureGit(
      repo,
      'for-each-ref',
      '--format=%(refname)',
      'refs/neondeck/factory/fetch',
    ),
  ).toBe('');
});
it.each(['disabled', 'config'] as const)(
  'rechecks %s after coding fetch before host operations and never accumulates per-attempt refs',
  async (change) => {
    configure({ enabled: true });
    const { repo, push } = remoteFixture();
    const sha = push();
    const work = release(),
      host = mockHost();
    const original = gitIo.runUnattendedGit;
    vi.spyOn(gitIo, 'runUnattendedGit').mockImplementation(
      async (cwd, args, options) => {
        const result = await original(cwd, args, options);
        if (args.includes('fetch'))
          configure(
            change === 'disabled'
              ? { enabled: false }
              : { model: 'changed-model' },
          );
        return result;
      },
    );
    for (let i = 0; i < 2; i++) {
      configure({ enabled: true, model: 'synthetic-model' });
      clearCodingAttention(work.work.id, paths);
      expect(
        await dispatchCodingWork(work.work.id, paths, host, readiness),
      ).toBeNull();
    }
    expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
    expect(host.launchLocalAttempt).not.toHaveBeenCalled();
    expect(listCodingRuns({}, paths)).toEqual([]);
    expect(
      fixtureGit(
        repo,
        'for-each-ref',
        '--format=%(refname)',
        'refs/neondeck/factory',
      ),
    ).toBe(`refs/neondeck/factory/commits/${sha}`);
  },
);

it('launches an existing unbound reservation from its frozen snapshot without refetching', async () => {
  configure({ enabled: true });
  const { repo, push } = remoteFixture();
  const work = release();
  const snapshot = await codingSnapshot(
    work.work.id,
    'codex-cli 0.150.1',
    paths,
  );
  const reserved = reserveCodingRun(snapshot, paths);
  expect(reserved.host).toBeNull();
  push();
  fixtureGit(repo, 'remote', 'set-url', 'origin', join(root, 'missing.git'));
  const spy = vi.spyOn(gitIo, 'runUnattendedGit');
  const host = mockHost();
  const result = await dispatchCodingWork(work.work.id, paths, host, readiness);
  expect(result?.runId).toBe(reserved.runId);
  expect(result?.snapshot).toEqual(snapshot);
  expect(host.prepareLocalAttempt).toHaveBeenCalledTimes(1);
  expect(host.launchLocalAttempt).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
});

it('admits a tiny task without loading a huge unrelated global skill library while planning still uses it', async () => {
  configure({ enabled: true });
  const repo = join(root, 'repo');
  writeFileSync(join(repo, 'AGENTS.md'), 'Use repository-native skills.');
  fixtureGit(repo, 'add', 'AGENTS.md');
  fixtureGit(
    repo,
    '-c',
    'user.name=Synthetic',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'Instructions',
  );
  const skillDirectory = join(paths.skills, 'unrelated-planning');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: unrelated-planning\ndescription: Global planning guidance.\n---\nUnrelated global instructions.',
  );
  writeFileSync(
    join(skillDirectory, 'REFERENCE.md'),
    'unrelated-support-marker'.repeat(10000),
  );
  const work = release();
  const loader = vi.spyOn(runtime, 'runtimeSkillSessionSnapshotsSync');
  const snapshot = await codingSnapshot(work.work.id, 'synthetic', paths);
  await assertCodingSnapshot(snapshot, paths);
  expect(loader).not.toHaveBeenCalled();
  expect(JSON.parse(snapshot.contextSnapshot)).toMatchObject({
    skills: [],
    repoInstructions: {
      text: 'Use repository-native skills.',
      commit: snapshot.baseSha,
    },
    setup: work.repoContext!.commands,
    references: work.revisions.at(-1)!.spec.references,
    memory: { ids: [], hash: expect.any(String) },
  });
  expect(snapshot.contextSnapshot.length).toBeLessThan(95000);
  const prompt = codingPrompt(snapshot);
  expect(prompt).toContain('Implement only the exact human-released brief');
  expect(prompt).toContain('Update file');
  expect(prompt).toContain('Use repository-native skills.');
  expect(prompt).not.toContain('unrelated-support-marker');
  expect(prompt).not.toContain('Unrelated global instructions.');
  expect(captureContext(work, paths).skills).toContainEqual({
    name: 'unrelated-planning',
    instructions: expect.stringContaining('Unrelated global instructions.'),
  });
  expect(loader).toHaveBeenCalledOnce();
  expect(JSON.stringify(loader.mock.results[0].value).length).toBeGreaterThan(
    95000,
  );
});

it.each(['fingerprinted', 'unfingerprinted'] as const)(
  'preserves historical %s policy and skill payloads on reserved attempts and in repair prompts',
  async (legacy) => {
    configure({ enabled: true });
    const work = release();
    const snapshot = await codingSnapshot(
      work.work.id,
      'codex-cli 0.150.1',
      paths,
    );
    const { repositorySkills: _repositorySkills, ...legacyCoding } =
      frozenCodingConfig(snapshot);
    const policy = JSON.parse(snapshot.policySnapshot);
    snapshot.policySnapshot = JSON.stringify({
      ...policy,
      coding: legacyCoding,
    });
    const historicalRelease = {
      ...work.releases[0],
      codingConfigFingerprint:
        legacy === 'fingerprinted' ? codingDigest(legacyCoding) : null,
    };
    const db = openDb(paths.neondeckDatabase);
    try {
      db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
        JSON.stringify(historicalRelease),
        historicalRelease.id,
      );
    } finally {
      db.close();
    }
    // An old queued release cannot adopt today's native discovery policy.
    await expect(
      codingSnapshot(work.work.id, 'codex-cli 0.150.1', paths),
    ).rejects.toThrow(/release|human release/);
    const originalPolicy = snapshot.policySnapshot;
    expect(() =>
      assertCodingAuthoritySnapshot(
        {
          ...snapshot,
          policySnapshot: JSON.stringify({
            ...policy,
            coding: { ...legacyCoding, repositorySkills: 'native-v1' },
          }),
        },
        paths,
      ),
    ).toThrow('Frozen coding authority changed');
    const { hash: _hash, ...body } = JSON.parse(snapshot.contextSnapshot);
    const skill = {
      name: 'historical-skill',
      description: 'Admitted guidance',
      instructions: 'Keep original instructions.',
      files: [
        {
          path: 'REFERENCE.md',
          encoding: 'utf8',
          content: 'Original supporting content.',
        },
      ],
    };
    body.skills = [{ snapshot: skill, hash: codingDigest(skill) }];
    snapshot.contextSnapshot = JSON.stringify({
      ...body,
      hash: codingDigest(body),
    });
    const original = snapshot.contextSnapshot;
    const reserved = reserveCodingRun(snapshot, paths);
    const loader = vi
      .spyOn(runtime, 'runtimeSkillSessionSnapshotsSync')
      .mockImplementation(() => {
        throw new Error('Global skills unavailable');
      });
    await expect(
      assertCodingSnapshot(snapshot, paths),
    ).resolves.toBeUndefined();
    const host = mockHost();
    const run = await dispatchCodingWork(work.work.id, paths, host, readiness);
    expect(run?.runId).toBe(reserved.runId);
    expect(run?.snapshot.contextSnapshot).toBe(original);
    expect(run?.snapshot.policySnapshot).toBe(originalPolicy);
    expect(host.prepareLocalAttempt).toHaveBeenCalledOnce();
    const prepared = v.parse(
      prepareSchema,
      vi.mocked(host.prepareLocalAttempt).mock.calls[0][0],
    );
    expect(prepared.config).not.toHaveProperty('repositorySkills');
    // Repair launch also maps the parent's frozen config, not current settings.
    expect(
      localCodingConfig(
        frozenCodingConfig(run!.snapshot),
        run!.snapshot.harness.version,
      ),
    ).not.toHaveProperty('repositorySkills');
    expect(codingConfig(paths).coding.repositorySkills).toBe('native-v1');
    // Repairs use codingPrompt(parent.snapshot), retaining this same payload.
    expect(codingPrompt(run!.snapshot)).toContain(original);
    expect(loader).not.toHaveBeenCalled();
    body.skills[0].snapshot.files[0].content = 'Changed support file';
    await expect(
      assertCodingSnapshot(
        {
          ...snapshot,
          contextSnapshot: JSON.stringify({
            ...body,
            hash: codingDigest(body),
          }),
        },
        paths,
      ),
    ).rejects.toThrow('integrity');
    expect(snapshot.contextSnapshot).toBe(original);
  },
);

it('binds native discovery to new release fingerprints and maps the frozen selection to the host', async () => {
  configure({ enabled: true });
  const { repositorySkills: _repositorySkills, ...legacyCoding } =
    codingConfig(paths).coding;
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      models: { prReview: 'faux/faux-1' },
      guardrails: { requiredChecks: ['npm test'] },
      factory: { enabled: true, coding: legacyCoding },
    }),
  );
  const work = readyWork();
  expect(codingConfig(paths).coding.repositorySkills).toBe('native-v1');
  expect(() =>
    releaseFactoryWork(
      work.work.id,
      {
        ...releaseInput(work),
        expectedCodingConfigFingerprint: codingDigest(legacyCoding),
      },
      actor,
      paths,
    ),
  ).toThrow('Coding configuration changed');
  const released = releaseFactoryWork(
    work.work.id,
    releaseInput(work),
    actor,
    paths,
  );
  expect(released.releases[0].codingConfigFingerprint).toBe(
    codingDigest({ ...legacyCoding, repositorySkills: 'native-v1' }),
  );
  const host = mockHost();
  const run = await dispatchCodingWork(work.work.id, paths, host, readiness);
  expect(frozenCodingConfig(run!.snapshot).repositorySkills).toBe('native-v1');
  const prepared = v.parse(
    prepareSchema,
    vi.mocked(host.prepareLocalAttempt).mock.calls[0][0],
  );
  expect(prepared.config.repositorySkills).toBe('native-v1');
  expect(
    localCodingConfig(
      frozenCodingConfig(run!.snapshot),
      run!.snapshot.harness.version,
    ).repositorySkills,
  ).toBe('native-v1');
});

it('keeps the existing context budget for oversized repository inputs', async () => {
  configure({ enabled: true });
  const work = release();
  const baseSha = fixtureGit(join(root, 'repo'), 'rev-parse', 'HEAD');
  await expect(
    freezeCodingContext(
      {
        ...work,
        repoContext: {
          ...work.repoContext!,
          commands: { setup: 'x'.repeat(95001) },
        },
      },
      baseSha,
      paths,
    ),
  ).rejects.toThrow('95,000-character budget');
});

it('keeps historical releases readable but rejects coding without validation authority', async () => {
  configure({ enabled: true });
  const released = release();
  const { validationPolicy: _validationPolicy, ...historical } =
    released.releases[0];
  const db = openDb(paths.neondeckDatabase);
  try {
    db.prepare('UPDATE factory_releases SET record=? WHERE id=?').run(
      JSON.stringify(historical),
      historical.id,
    );
  } finally {
    db.close();
  }
  const retained = getFactoryWork(released.work.id, paths);
  expect(retained.releases[0].validationPolicy).toBeUndefined();
  expect(retained.revisions).toEqual(released.revisions);
  expect(() => codingAuthority(released.work.id, paths)).toThrow('ineligible');
  const host = mockHost();
  await expect(
    dispatchCodingWork(released.work.id, paths, host, readiness),
  ).rejects.toThrow('ineligible');
  expect(host.prepareLocalAttempt).not.toHaveBeenCalled();
  expect(host.launchLocalAttempt).not.toHaveBeenCalled();
  expect(listCodingRuns({}, paths)).toEqual([]);
  expect(getFactoryWork(released.work.id, paths).releases).toEqual(
    retained.releases,
  );
});
