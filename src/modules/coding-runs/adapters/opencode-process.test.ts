import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { manifestSchema } from '../host-contract.ts';
import { opencodeAdapter } from './opencode.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// Transport conformance only. Production process supervision/death proof is
// exercised by the shared-host integration suite on supported Linux hosts.
async function run(prompt: string, provider = 'opencode') {
  const root = await mkdtemp(join(tmpdir(), 'opencode-wire-'));
  roots.push(root);
  const workspace = join(root, 'work');
  await mkdir(workspace);
  const manifest = v.parse(manifestSchema, {
    version: 2,
    executableIdentity: {
      canonical: '/tmp/mock-opencode',
      device: 1,
      inode: 1,
      size: 1,
      modified: 1,
    },
    attemptId: 'fixture',
    cliVersion: 'mock-opencode 1.18.29',
    directory: root,
    nonce: 'a'.repeat(32),
    ownedWorktree: {
      id: 'wt',
      repoId: 'repo',
      root: workspace,
      storageRoot: root,
      sourceRoot: join(root, 'source'),
      branch: 'agent/factory-test',
      baseSha: 'a'.repeat(40),
    },
    config: {
      executable: resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../scripts/mock-opencode.mjs',
      ),
      model: `${provider}/fixture-model`,
      sandbox: 'workspace-write',
      path: `${dirname(process.execPath)}:/usr/bin:/bin`,
      wallTimeMs: 3000,
      maxOutputBytes: 65536,
      maxLineBytes: 16384,
      termGraceMs: 50,
      mockScenario: 'success',
      adapter: {
        id: 'opencode',
        contractVersion: 1,
        cliVersion: 'mock-opencode 1.18.29',
      },
    },
  });
  for (const file of opencodeAdapter.credentials(
    {
      kind: 'api-key',
      value: 'synthetic-api-key',
    },
    manifest.config,
  ).files) {
    await mkdir(dirname(join(root, file.path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(root, file.path), file.content, { mode: 0o600 });
  }
  const launch = opencodeAdapter.launch(manifest);
  const output = await new Promise<{
    stdout: string;
    stderr: string;
    failed: boolean;
  }>((resolveResult) => {
    const child = execFile(
      manifest.config.executable,
      launch.args,
      { cwd: workspace, env: launch.env, timeout: 3000, maxBuffer: 65536 },
      (error, stdout, stderr) =>
        resolveResult({ stdout, stderr, failed: error !== null }),
    );
    child.stdin?.end(prompt);
  });
  return { ...output, workspace };
}

describe('OpenCode fake executable transport', () => {
  it.each(['opencode', 'anthropic', 'openai'])(
    'runs %s stdin prompt with private auth and two model steps',
    async (provider) => {
      const first = await run('Prepare synthetic candidate', provider);
      expect(first.failed).toBe(false);
      expect(first.stderr).toBe('');
      const events = opencodeAdapter.createEvents();
      first.stdout
        .trimEnd()
        .split('\n')
        .forEach((line) => events.accept(line));
      expect(events.terminal).toBe('completed');
      expect(
        await readFile(
          join(first.workspace, 'mock-opencode-result.txt'),
          'utf8',
        ),
      ).toContain('Synthetic OpenCode');
      const second = await run('Prepare next synthetic candidate', provider);
      const next = opencodeAdapter.createEvents();
      second.stdout
        .trimEnd()
        .split('\n')
        .forEach((line) => next.accept(line));
      expect(next.sessionId).not.toBe(events.sessionId);
    },
  );
  it('retains absent terminal evidence as incomplete even with zero exit', async () => {
    const output = await run('fixture:absent-terminal');
    expect(output.failed).toBe(false);
    const events = opencodeAdapter.createEvents();
    output.stdout
      .trimEnd()
      .split('\n')
      .forEach((line) => events.accept(line));
    expect(events.sessionId).toBeTruthy();
    expect(events.terminal).toBeNull();
  });
  it.each(['duplicate-terminal', 'contradictory-terminal', 'truncated'])(
    'rejects synthetic %s',
    async (scenario) => {
      const output = await run(`fixture:${scenario}`);
      const events = opencodeAdapter.createEvents();
      expect(() =>
        output.stdout
          .trimEnd()
          .split('\n')
          .forEach((line) => events.accept(line)),
      ).toThrow('Invalid or contradictory');
      expect(events.terminal).toBe('failed');
    },
  );
  it('keeps process failure distinct from provider stop', async () => {
    const output = await run('fixture:nonzero-exit');
    expect(output.failed).toBe(true);
    const events = opencodeAdapter.createEvents();
    output.stdout
      .trimEnd()
      .split('\n')
      .forEach((line) => events.accept(line));
    expect(events.terminal).toBe('completed');
    // The shared host must also require exit zero and death proof.
  });
});
