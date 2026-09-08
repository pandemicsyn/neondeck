import {
  mkdtemp,
  realpath,
  mkdir,
  symlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  workflowCommandCwd,
  workflowEnvironmentValues,
  runtimeVersionMatches,
  discoverWorkflowToolchain,
  assertWorkflowToolchain,
  redactWorkflowOutput,
} from './index';
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function root() {
  const path = await realpath(
    await mkdtemp(join(tmpdir(), 'workflow-runtime-')),
  );
  roots.push(path);
  return path;
}
it('uses the same semver grammar, including prerelease and zero-major carets', () => {
  expect(runtimeVersionMatches('v26.4.0', '>=26 <27')).toBe(true);
  expect(runtimeVersionMatches('0.0.4', '^0.0.3')).toBe(false);
  expect(runtimeVersionMatches('1.0.0-beta.2', '^1.0.0')).toBe(false);
  expect(runtimeVersionMatches('1.0.0-beta.2', '>=1.0.0-beta.1 <1.0.0')).toBe(
    true,
  );
});
it('rejects absolute, parent and symlink-escaping command directories', async () => {
  const path = await root(),
    other = await root();
  await mkdir(join(path, 'web'));
  await symlink(other, join(path, 'escape'));
  expect(await workflowCommandCwd(path, 'web')).toBe(join(path, 'web'));
  for (const cwd of [path, '../outside', 'web/../web', 'escape', 'missing'])
    await expect(workflowCommandCwd(path, cwd)).rejects.toThrow();
});
it('requires explicit available refs and denies process controls without leaking values', () => {
  for (const name of [
    'HOME',
    'PATH',
    'NODE_OPTIONS',
    'NEONDECK_HOME',
    'GIT_CONFIG_COUNT',
    'NPM_CONFIG_USERCONFIG',
  ])
    expect(() =>
      workflowEnvironmentValues([name], { [name]: 'private-value' }),
    ).toThrow();
  expect(() => workflowEnvironmentValues(['TEST_KEY'], {})).toThrow('TEST_KEY');
  expect(
    workflowEnvironmentValues(['TEST_KEY'], {
      TEST_KEY: 'private-value',
      GITHUB_TOKEN: 'operator',
    }),
  ).toEqual({ TEST_KEY: 'private-value' });
  const secret = 'private\nvalue';
  const output = redactWorkflowOutput(
    [
      secret,
      JSON.stringify(secret),
      Buffer.from(secret).toString('base64'),
    ].join(' '),
    { TEST_KEY: secret },
  );
  expect(output).not.toContain('private');
  expect(output).not.toContain(Buffer.from(secret).toString('base64'));
});
it('discovers a selected installed manager without inheriting PATH and fences executable drift', async () => {
  const path = await root();
  await writeFile(join(path, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const toolchain = await discoverWorkflowToolchain(
    { packageManager: { name: 'bun' } },
    path,
  );
  expect(toolchain.packageManager?.path).toBe(join(path, 'bun'));
  await assertWorkflowToolchain(toolchain);
  await writeFile(join(path, 'bun'), '#!/bin/sh\nexit 1\nchanged\n');
  await expect(assertWorkflowToolchain(toolchain)).rejects.toThrow('changed');
});

it.each([
  'SSH_AUTH_SOCK',
  'GCM_TOKEN',
  'TMP_WORK',
  'TMPDIR',
  'NEONDECKHOME',
  'CDPATH',
  'PYTHONPATH',
  'RUBYOPT',
  'PERL5OPT',
  'BUN_CONFIG',
  'YARN_CACHE_FOLDER',
  'NPM_CONFIG_USERCONFIG',
])(
  'shared save/proposal admission and runtime consistently reject %s',
  async (name) => {
    const v = await import('valibot');
    const {
      repoWorkflowEnvironmentRefSchema,
      saveRepoWorkflowsInputSchema,
      repoWorkflowProposalDraftSchema,
      isReservedRepoWorkflowEnvironmentRef,
    } = await import('../../../shared/repo-workflows');
    expect(isReservedRepoWorkflowEnvironmentRef(name)).toBe(true);
    expect(v.safeParse(repoWorkflowEnvironmentRefSchema, name).success).toBe(
      false,
    );
    expect(() =>
      workflowEnvironmentValues([name], { [name]: 'fixture-value' }),
    ).toThrow();
    const workflows = {
      defaultProfileId: 'test',
      profiles: [
        {
          id: 'test',
          name: 'Test',
          setupCommands: [],
          validationCommands: [{ command: 'node --version', cwd: '.' }],
          setupTimeoutMs: 1000,
          validationTimeoutMs: 1000,
          runtime: {},
          environmentRefs: [name],
        },
      ],
    };
    expect(
      v.safeParse(saveRepoWorkflowsInputSchema, {
        expectedFingerprint: 'a'.repeat(64),
        workflows,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(repoWorkflowProposalDraftSchema, {
        workflows,
        rationale: 'Fixture',
        evidencePaths: [],
      }).success,
    ).toBe(false);
  },
);
it.each([
  'TEST_KEY',
  'GITHUB_TOKEN',
  'APP_TMP_WORK',
  'SSHKEY_LABEL',
  'DATABASE_URL',
])('shared and runtime admission consistently allow %s', async (name) => {
  const v = await import('valibot');
  const {
    repoWorkflowEnvironmentRefSchema,
    isReservedRepoWorkflowEnvironmentRef,
  } = await import('../../../shared/repo-workflows');
  expect(isReservedRepoWorkflowEnvironmentRef(name)).toBe(false);
  expect(v.parse(repoWorkflowEnvironmentRefSchema, name)).toBe(name);
  expect(
    workflowEnvironmentValues([name], { [name]: 'fixture-value' }),
  ).toEqual({ [name]: 'fixture-value' });
});
