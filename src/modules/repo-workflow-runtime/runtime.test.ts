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
