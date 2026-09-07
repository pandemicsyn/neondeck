import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import * as registry from './adapters/registry.ts';
import { codexAdapter } from './adapters/codex.ts';
import { manifestSchema } from './host-contract.ts';
import {
  adapterLaunch,
  prepareAdapterCredentials,
  verifyAdapterWorkspace,
  adapterCredentialRedactor,
  removeAdapterCredentials,
} from './adapter-host.ts';
const folders: string[] = [];
async function fixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'adapter-host-')),
  );
  folders.push(directory);
  await mkdir(join(directory, 'home'), { mode: 0o700 });
  await mkdir(join(directory, 'workspace'));
  return v.parse(manifestSchema, {
    version: 1,
    attemptId: 'attempt',
    cliVersion: 'codex-cli 0.150.1',
    directory,
    nonce: 'a'.repeat(32),
    ownedWorktree: {
      id: 'w',
      repoId: 'r',
      root: join(directory, 'workspace'),
      storageRoot: directory,
      sourceRoot: join(directory, 'source'),
      branch: 'agent/factory-test',
      baseSha: 'b'.repeat(40),
    },
    config: {
      executable: '/usr/bin/false',
      model: 'fixture',
      sandbox: 'workspace-write',
      path: '/usr/bin:/bin',
      wallTimeMs: 1000,
      maxOutputBytes: 4096,
      maxLineBytes: 1024,
      termGraceMs: 50,
    },
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of folders.splice(0))
    await rm(dir, { recursive: true, force: true });
});
describe('host enforces adapter descriptors', () => {
  it('denies inherited secret keys and changing the host HOME', async () => {
    const manifest = await fixture();
    vi.spyOn(registry, 'getCodingAdapter').mockReturnValue({
      ...codexAdapter,
      launch: () => ({ args: [], env: { GITHUB_TOKEN: 'secret' } }),
    });
    expect(() => adapterLaunch(manifest)).toThrow('environment');
    vi.mocked(registry.getCodingAdapter).mockReturnValue({
      ...codexAdapter,
      launch: () => ({ args: [], env: { HOME: '/tmp/operator' } }),
    });
    expect(() => adapterLaunch(manifest)).toThrow('environment');
  });
  it.each(['../outside', 'home/../outside', 'home/.git/token', '/tmp/outside'])(
    'rejects credential path %s even if declared',
    async (path) => {
      const manifest = await fixture();
      vi.spyOn(registry, 'getCodingAdapter').mockReturnValue({
        ...codexAdapter,
        credentialPaths: [path],
        credentials: () => ({
          files: [{ path, content: 'secret' }],
          secrets: ['secret'],
        }),
      });
      await expect(
        prepareAdapterCredentials(manifest, undefined),
      ).rejects.toThrow('destination');
    },
  );
  it('rejects oversized secret arrays before any credential writes', async () => {
    const manifest = await fixture();
    vi.spyOn(registry, 'getCodingAdapter').mockReturnValue({
      ...codexAdapter,
      credentials: () => ({
        files: [],
        secrets: Array.from({ length: 65 }, () => 'secret'),
      }),
    });
    await expect(
      prepareAdapterCredentials(manifest, undefined),
    ).rejects.toThrow();
  });
  it('round trips bounded credentials, redacts and removes only the private copy', async () => {
    const manifest = await fixture();
    await prepareAdapterCredentials(manifest, {
      kind: 'api-key',
      value: 'selected-secret',
    });
    expect((await adapterCredentialRedactor(manifest))('selected-secret')).toBe(
      '[REDACTED]',
    );
    expect(await removeAdapterCredentials(manifest)).toBe('removed');
    expect(await removeAdapterCredentials(manifest)).toBe('absent');
  });
  it('rejects forbidden workspace files and dangling symlinks without deleting them', async () => {
    const manifest = await fixture();
    vi.spyOn(registry, 'getCodingAdapter').mockReturnValue({
      ...codexAdapter,
      forbiddenWorkspacePaths: ['.legacy'],
    });
    expect(() => verifyAdapterWorkspace(manifest)).not.toThrow();
    await symlink(
      join(manifest.directory, 'missing'),
      join(manifest.ownedWorktree.root, '.legacy'),
    );
    expect(() => verifyAdapterWorkspace(manifest)).toThrow(
      'unsupported provider configuration',
    );
  });
  it('rejects workspace traversal and .git guards', async () => {
    const manifest = await fixture();
    vi.spyOn(registry, 'getCodingAdapter').mockReturnValue({
      ...codexAdapter,
      forbiddenWorkspacePaths: ['.git/config'],
    });
    expect(() => verifyAdapterWorkspace(manifest)).toThrow('workspace guard');
  });
  it('rejects a credential parent symlink outside the private home', async () => {
    const manifest = await fixture();
    const outside = join(manifest.directory, 'outside');
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, 'sentinel'), 'keep');
    await symlink(outside, join(manifest.directory, 'home/.codex'));
    await expect(
      prepareAdapterCredentials(manifest, { kind: 'api-key', value: 'secret' }),
    ).rejects.toThrow('canonical');
  });
});
