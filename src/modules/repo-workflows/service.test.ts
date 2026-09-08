import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import {
  repoFactoryWorkflowsSchema,
  repoWorkflowProfileSchema,
  type RepoFactoryWorkflows,
} from '../../../shared/repo-workflows';
import {
  runtimePaths,
  parseAppConfig,
  type RuntimePaths,
  type RepoConfig,
} from '../../runtime-home';
vi.mock('../factory', () => ({ invalidateFactoryRepoContext: vi.fn() }));
vi.mock('../config', async () => ({
  ...(await import('../config/factory-mutation-lock')),
  recordConfigChange: vi.fn(),
}));
import {
  readRepoWorkflows,
  saveRepoWorkflows,
  resolveRepoWorkflow,
} from './service';
import { proposeRepoWorkflows } from './proposal';
import { recordConfigChange } from '../config';
import { invalidateFactoryRepoContext } from '../factory';
import { collectRepoWorkflowEvidence } from './evidence';
let root: string, paths: RuntimePaths, repo: RepoConfig;
const workflows: RepoFactoryWorkflows = {
  defaultProfileId: 'test',
  profiles: [
    {
      id: 'test',
      name: 'Test',
      setupCommands: [{ command: 'npm ci', cwd: '.' }],
      validationCommands: [{ command: 'cargo test', cwd: 'backend' }],
      setupTimeoutMs: 60000,
      validationTimeoutMs: 60000,
      runtime: {
        node: '>=26 <27',
        packageManager: { name: 'npm', version: '^11.0.0' },
      },
      environmentRefs: ['TEST_TOKEN'],
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'repo-workflows-'));
  paths = runtimePaths(root);
  repo = {
    id: 'sample',
    path: join(root, 'repo'),
    github: { owner: 'fixture', name: 'sample' },
    defaultBranch: 'main',
    metadata: { custom: 'retained' },
    factoryWorkflows: structuredClone(workflows),
  };
  mkdirSync(repo.path);
  writeFileSync(paths.config, '{"version":1}');
  writeFileSync(
    paths.repos,
    JSON.stringify({ custom: 'registry', repos: [repo] }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('saves with CAS, preserves metadata and rejects stale writes', () => {
  const before = readRepoWorkflows(repo.id, paths);
  const changed = structuredClone(workflows);
  changed.profiles[0].name = 'Updated';
  const after = saveRepoWorkflows(
    repo.id,
    { expectedFingerprint: before.fingerprint, workflows: changed },
    paths,
  );
  expect(after.fingerprint).not.toBe(before.fingerprint);
  expect(invalidateFactoryRepoContext).toHaveBeenCalledWith(repo.id, paths);
  expect(recordConfigChange).toHaveBeenCalledWith(
    paths,
    expect.objectContaining({
      action: 'config_update_repo_factory_workflows',
      target: repo.id,
    }),
  );
  saveRepoWorkflows(
    repo.id,
    { expectedFingerprint: after.fingerprint, workflows: changed },
    paths,
  );
  expect(recordConfigChange).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(paths.repos, 'utf8'))).toMatchObject({
    custom: 'registry',
    repos: [{ metadata: { custom: 'retained' } }],
  });
  expect(() =>
    saveRepoWorkflows(
      repo.id,
      { expectedFingerprint: before.fingerprint, workflows },
      paths,
    ),
  ).toThrow(/changed/);
  saveRepoWorkflows(
    repo.id,
    { expectedFingerprint: after.fingerprint, workflows: null },
    paths,
  );
  expect(readRepoWorkflows(repo.id, paths).workflows).toBeNull();
});
it('detects repo metadata and required policy changes and fails closed under lock contention', () => {
  const before = readRepoWorkflows(repo.id, paths);
  writeFileSync(
    paths.config,
    JSON.stringify({
      version: 1,
      guardrails: { requiredChecks: ['make test'] },
    }),
  );
  expect(readRepoWorkflows(repo.id, paths).fingerprint).not.toBe(
    before.fingerprint,
  );
  mkdirSync(`${paths.config}.factory-write.lock`);
  expect(() =>
    saveRepoWorkflows(
      repo.id,
      { expectedFingerprint: before.fingerprint, workflows },
      paths,
    ),
  ).toThrow(/locked/);
});
it('never drops mandatory root commands or silently chooses an ambiguous profile', () => {
  repo.metadata = {
    guardrails: { requiredChecks: ['cargo test', 'make lint'] },
  };
  const resolved = resolveRepoWorkflow(
    repo,
    parseAppConfig({ version: 1 }, 'fixture'),
  );
  expect(resolved?.validationCommands).toEqual([
    { command: 'cargo test', cwd: 'backend' },
    { command: 'cargo test', cwd: '.' },
    { command: 'make lint', cwd: '.' },
  ]);
  repo.factoryWorkflows!.defaultProfileId = null;
  expect(() =>
    resolveRepoWorkflow(repo, parseAppConfig({ version: 1 }, 'fixture')),
  ).toThrow(/Select/);
  expect(
    resolveRepoWorkflow(repo, parseAppConfig({ version: 1 }, 'fixture'), 'test')
      ?.id,
  ).toBe('test');
  expect(() =>
    resolveRepoWorkflow(
      repo,
      parseAppConfig({ version: 1 }, 'fixture'),
      'missing',
    ),
  ).toThrow(/no longer/);
});
it('rejects empty effective checks and excessive command expansion', () => {
  repo.factoryWorkflows!.profiles[0].validationCommands = [];
  expect(() =>
    resolveRepoWorkflow(repo, parseAppConfig({ version: 1 }, 'fixture')),
  ).toThrow(/at least one/);
  repo.metadata = {
    guardrails: {
      requiredChecks: Array.from({ length: 17 }, (_, i) => `check${i}`),
    },
  };
  expect(() =>
    resolveRepoWorkflow(repo, parseAppConfig({ version: 1 }, 'fixture')),
  ).toThrow(/16/);
});
it.each(['../escape', '/absolute', 'a/../b', 'a\\b', 'a//b'])(
  'rejects escaping or noncanonical cwd %s',
  (cwd) => {
    expect(
      v.safeParse(repoWorkflowProfileSchema, {
        ...workflows.profiles[0],
        setupCommands: [{ command: 'npm ci', cwd }],
      }).success,
    ).toBe(false);
  },
);
it.each([
  'PATH',
  'NODE_OPTIONS',
  'NEONDECK_HOME',
  'GIT_CONFIG',
  'DYLD_INSERT_LIBRARIES',
  'NPM_CONFIG_USERCONFIG',
])('rejects control environment reference %s', (name) => {
  expect(
    v.safeParse(repoWorkflowProfileSchema, {
      ...workflows.profiles[0],
      environmentRefs: [name],
    }).success,
  ).toBe(false);
});
it('validates unique bounded profiles, semantic versions and command syntax', () => {
  expect(
    v.safeParse(repoFactoryWorkflowsSchema, {
      ...workflows,
      profiles: [...workflows.profiles, ...workflows.profiles],
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(repoWorkflowProfileSchema, {
      ...workflows.profiles[0],
      runtime: { node: 'install-latest' },
    }).success,
  ).toBe(false);
  for (const command of [
    'npm ci && npm test',
    'npm ci\nnpm test',
    'x'.repeat(2001),
  ])
    expect(
      v.safeParse(repoWorkflowProfileSchema, {
        ...workflows.profiles[0],
        setupCommands: [{ command, cwd: '.' }],
      }).success,
    ).toBe(false);
});
function git(...args: string[]) {
  return execFileSync('git', ['-C', repo.path, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_EMAIL: 'fixture@example.test',
    },
  }).trim();
}
function commitFixture() {
  git('init', '-q');
  writeFileSync(
    join(repo.path, 'package.json'),
    '{"scripts":{"test":"vitest"}}',
  );
  symlinkSync('/not-readable', join(repo.path, 'README.md'));
  git('add', '.');
  git('commit', '-qm', 'fixture');
}
it('proposes from pinned regular committed evidence, never dirty/private files or saved state', async () => {
  commitFixture();
  const revision = git('rev-parse', 'HEAD');
  writeFileSync(join(repo.path, 'package.json'), 'private uncommitted content');
  writeFileSync(join(repo.path, '.env'), 'SECRET=private');
  const evidence = await collectRepoWorkflowEvidence(repo.path);
  expect(evidence).toEqual({
    revision,
    evidence: [
      {
        path: 'package.json',
        content: '{"scripts":{"test":"vitest"}}',
        sizeBytes: Buffer.byteLength('{"scripts":{"test":"vitest"}}'),
        truncated: false,
      },
    ],
  });
  const before = readFileSync(paths.repos, 'utf8');
  const model = vi.fn(async () => ({
    workflows,
    rationale: 'Fixture defaults',
    evidencePaths: ['package.json'],
  }));
  const result = await proposeRepoWorkflows(
    repo.id,
    { expectedFingerprint: readRepoWorkflows(repo.id, paths).fingerprint },
    paths,
    model,
  );
  expect(result.proposal.evidenceRevision).toBe(revision);
  expect(model).toHaveBeenCalledOnce();
  expect(readFileSync(paths.repos, 'utf8')).toBe(before);
  await expect(
    proposeRepoWorkflows(
      repo.id,
      { expectedFingerprint: result.fingerprint },
      paths,
      async () => ({ workflows, rationale: 'bad', evidencePaths: ['.env'] }),
    ),
  ).rejects.toThrow(/unavailable/);
  await expect(
    proposeRepoWorkflows(
      repo.id,
      { expectedFingerprint: result.fingerprint },
      paths,
      async () => ({ save: true }),
    ),
  ).rejects.toThrow();
});
it('rejects model output if repository context changes during proposal', async () => {
  commitFixture();
  const before = readRepoWorkflows(repo.id, paths);
  await expect(
    proposeRepoWorkflows(
      repo.id,
      { expectedFingerprint: before.fingerprint },
      paths,
      async () => {
        writeFileSync(
          paths.repos,
          JSON.stringify({ repos: [{ ...repo, defaultBranch: 'other' }] }),
        );
        return { workflows, rationale: 'Fixture', evidencePaths: [] };
      },
    ),
  ).rejects.toThrow(/changed/);
});

it('retains a large pnpm lockfile prefix and presence for proposal without packageManager metadata', async () => {
  commitFixture();
  const lockfile =
    "lockfileVersion: '9.0'\n" + '  fixture-dependency: 1.0.0\n'.repeat(1000);
  expect(Buffer.byteLength(lockfile)).toBeGreaterThan(8192);
  writeFileSync(join(repo.path, 'pnpm-lock.yaml'), lockfile);
  git('add', 'pnpm-lock.yaml');
  git('commit', '-qm', 'large lockfile');
  const revision = git('rev-parse', 'HEAD');
  const model = vi.fn<import('./proposal').RepoWorkflowProposalModel>(
    async () => ({
      workflows,
      rationale: 'Use the committed pnpm lockfile',
      evidencePaths: ['pnpm-lock.yaml'],
    }),
  );
  const result = await proposeRepoWorkflows(
    repo.id,
    { expectedFingerprint: readRepoWorkflows(repo.id, paths).fingerprint },
    paths,
    model,
  );
  const evidence = model.mock.calls[0];
  expect(evidence).toEqual([
    expect.arrayContaining([
      expect.objectContaining({
        path: 'package.json',
        content: '{"scripts":{"test":"vitest"}}',
        truncated: false,
      }),
      {
        path: 'pnpm-lock.yaml',
        content: lockfile.slice(0, 4096),
        sizeBytes: Buffer.byteLength(lockfile),
        truncated: true,
      },
    ]),
    paths,
  ]);
  expect(result.proposal.evidenceRevision).toBe(revision);
  expect(result.proposal.evidencePaths).toEqual(['pnpm-lock.yaml']);
});
