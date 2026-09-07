import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  writeFile,
  rm,
  stat,
  cp,
  readdir,
  symlink,
  utimes,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
  prepareLocalAttempt,
  launchLocalAttempt,
  inspectLocalAttempt,
  cancelLocalAttempt,
  collectLocalAttempt,
  loadLocalManifest,
  reconcileLocalAttempt,
  publishLocalCancellation,
} from './local-host.ts';
import {
  type LocalAttemptHandle,
  type PrepareLocalAttemptInput,
  receiptSchema,
} from './host-contract.ts';
import { readSigned, writeSigned } from './host-io.ts';
import {
  codexArguments,
  codexEnvironment,
  CodexEvents,
} from './codex-adapter.ts';
import { listCodingAdapters } from './adapters/registry.ts';
import { executableIdentity } from './adapter-host.ts';
import { inspectCodexReadiness } from './codex-readiness.ts';
import { groupAbsent, processTable, sameProcess } from './host-process.ts';
import { inside } from './host-workspace.ts';
const exec = promisify(execFile);
const folders: string[] = [];
const handles: LocalAttemptHandle[] = [];
const mock = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'scripts/mockdex.mjs',
);
async function fixture(
  scenario: PrepareLocalAttemptInput['config']['mockScenario'] = 'success',
) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-host-')));
  folders.push(dir);
  const source = join(dir, 'source');
  const storage = join(dir, 'worktrees');
  const root = join(storage, 'owned');
  await mkdir(source);
  await mkdir(storage);
  const git = (cwd: string, args: string[]) =>
    exec('/usr/bin/git', args, {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
    });
  await git(source, ['init', '-q']);
  await writeFile(join(source, 'base.txt'), 'base\n');
  await git(source, ['add', '.']);
  await git(source, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const baseSha = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(source, ['worktree', 'add', '-qb', 'agent/factory-test', root]);
  const config: PrepareLocalAttemptInput = {
    directory: join(dir, 'attempt'),
    attemptToken: randomBytes(32).toString('hex'),
    attemptId: 'attempt-1',
    ownedWorktree: {
      id: 'wt-1',
      repoId: 'repo-1',
      root,
      storageRoot: storage,
      sourceRoot: source,
      branch: 'agent/factory-test',
      baseSha,
    },
    config: {
      executable: mock,
      model: 'fixture-model',
      sandbox: 'workspace-write',
      path: `${dirname(process.execPath)}:/usr/bin:/bin`,
      wallTimeMs: 5000,
      maxOutputBytes: 64 * 1024,
      maxLineBytes: 16 * 1024,
      termGraceMs: 50,
      mockScenario: scenario,
    },
    prompt: 'Create a deterministic candidate.',
  };
  return config;
}
async function finish(handle: LocalAttemptHandle) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = await inspectLocalAttempt(handle);
    if (state.state === 'finished') return state.receipt;
    await delay(50);
  }
  throw new Error(JSON.stringify(await inspectLocalAttempt(handle)));
}
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await cancelLocalAttempt(handle).catch(() => {});
    await finish(handle).catch(() => {});
  }
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function controller(
  handle: LocalAttemptHandle,
  action: 'launch' | 'inspect' | 'cancel',
  keepAlive = false,
  entryOverride?: string,
) {
  const entry =
    entryOverride ?? new URL('./local-host.ts', import.meta.url).href;
  const code = `import * as host from ${JSON.stringify(entry)};
    let data = ''; for await (const chunk of process.stdin) data += chunk;
    const result = await host[${JSON.stringify(action + 'LocalAttempt')}](JSON.parse(data));
    console.log(JSON.stringify(result)); ${keepAlive ? 'setInterval(() => {}, 1000);' : ''}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(handle));
  const text = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Controller timed out')),
      8000,
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('\n')) {
        clearTimeout(timeout);
        resolve(stdout.trim());
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && !stdout) {
        clearTimeout(timeout);
        reject(new Error(stderr));
      }
    });
  });
  return {
    child,
    value: v.parse(v.object({ state: v.string() }), JSON.parse(text)),
  };
}
describe('supervised local host (synthetic CLI only)', () => {
  it('launches a version-two pinned Codex manifest through the same host', async () => {
    const input = await fixture();
    input.expectedExecutableIdentity = await executableIdentity(
      input.config.executable,
    );
    input.config.adapter = {
      id: 'codex',
      contractVersion: 1,
      cliVersion: 'mockdex codex-contract 0.150.1',
    };
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    const { manifest } = await loadLocalManifest(handle);
    expect(manifest.version).toBe(2);
    expect(manifest.executableIdentity).toBeDefined();
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      state: 'finished',
      noWriter: true,
      terminal: 'completed',
    });
  });
  it('rejects a replacement before even running its version command with an admitted pin', async () => {
    const input = await fixture();
    const executable = join(dirname(input.directory), 'admitted-cli.mjs');
    const marker = join(dirname(input.directory), 'replacement-executed');
    await writeFile(executable, await readFile(mock), { mode: 0o700 });
    input.config.executable = executable;
    input.expectedExecutableIdentity = await executableIdentity(executable);
    input.config.adapter = {
      id: 'codex',
      contractVersion: 1,
      cliVersion: 'mockdex codex-contract 0.150.1',
    };
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');console.log('mockdex codex-contract 0.150.1');\n`,
    );
    await expect(prepareLocalAttempt(input)).rejects.toThrow(
      'identity changed',
    );
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('inspects and reconciles completed historical stat-only manifests without repinning', async () => {
    const input = await fixture();
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    const receipt = await finish(handle);
    expect(receipt.noWriter).toBe(true);
    const { manifest } = await loadLocalManifest(handle);
    const { sha256: _digest, ...statOnly } = manifest.executableIdentity!;
    await writeSigned(
      join(handle.directory, 'manifest.json'),
      handle.attemptToken,
      {
        ...manifest,
        executableIdentity: statOnly,
      },
    );
    expect(
      (await loadLocalManifest(handle)).manifest.executableIdentity,
    ).toEqual(statOnly);
    expect(await inspectLocalAttempt(handle)).toMatchObject({ receipt });
    expect(await reconcileLocalAttempt(handle)).toMatchObject({ receipt });
    expect(
      (await loadLocalManifest(handle)).manifest.executableIdentity,
    ).toEqual(statOnly);
  });
  it('rejects same-size timestamp-restored executable edits before a prepared launch', async () => {
    const input = await fixture();
    const executable = join(dirname(input.directory), 'same-size-cli.mjs');
    const marker = join(dirname(input.directory), 'replacement-ran');
    const original = await readFile(mock, 'utf8');
    const replacement = `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');console.log('mockdex codex-contract 0.150.1');\n`;
    expect(replacement.length).toBeLessThan(original.length);
    await writeFile(executable, original, { mode: 0o700 });
    const timestamp = new Date('2026-01-01T00:00:00Z');
    await utimes(executable, timestamp, timestamp);
    input.config.executable = executable;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    const { manifest } = await loadLocalManifest(handle);
    await writeFile(executable, replacement.padEnd(original.length, ' '));
    await utimes(executable, timestamp, timestamp);
    const changed = await executableIdentity(executable);
    expect({ ...changed, sha256: manifest.executableIdentity?.sha256 }).toEqual(
      manifest.executableIdentity,
    );
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      reason: 'host-preflight-failed',
      sessionId: null,
    });
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('blocks changed executable identity even when the version string stays pinned', async () => {
    const input = await fixture();
    const executable = join(dirname(input.directory), 'changed-cli.mjs');
    const source = await readFile(mock, 'utf8');
    await writeFile(executable, source, { mode: 0o700 });
    input.config.executable = executable;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await writeFile(executable, source + '\n// changed after preparation\n');
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      state: 'finished',
      noWriter: true,
      reason: 'host-preflight-failed',
      sessionId: null,
    });
  });

  it('collects an untracked candidate after group death and retains primary checkout', async () => {
    const input = await fixture();
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    const receipt = await finish(handle);
    expect(receipt).toMatchObject({
      noWriter: true,
      exitCode: 0,
      terminal: 'completed',
      reason: null,
    });
    const candidate = await collectLocalAttempt(handle);
    expect(candidate.includesUntracked).toBe(true);
    expect(await readFile(candidate.statusRef, 'utf8')).toContain(
      'mockdex-result.txt',
    );
    expect(await readFile(candidate.untrackedRef, 'utf8')).toContain(
      'contentBase64',
    );
    expect(
      await readFile(join(input.ownedWorktree.sourceRoot, 'base.txt'), 'utf8'),
    ).toBe('base\n');
    await expect(
      stat(join(input.ownedWorktree.sourceRoot, 'mockdex-result.txt')),
    ).rejects.toThrow(/ENOENT/);
    const again = await launchLocalAttempt(handle);
    expect(again.state).toBe('finished');
  });
  it.each(['failure', 'malformed', 'oversized', 'stall'] as const)(
    'bounds and retains %s runs',
    async (scenario) => {
      const input = await fixture(scenario);
      input.config.wallTimeMs = 600;
      const handle = await prepareLocalAttempt(input);
      handles.push(handle);
      await launchLocalAttempt(handle);
      const receipt = await finish(handle);
      expect(receipt.noWriter).toBe(true);
      expect(receipt.reason).not.toBeNull();
      expect(
        (await stat(join(handle.directory, 'stdout.jsonl'))).size,
      ).toBeLessThanOrEqual(input.config.maxOutputBytes);
      expect((await stat(input.ownedWorktree.root)).isDirectory()).toBe(true);
    },
  );
  it('persists cancellation before launch without starting a CLI', async () => {
    const handle = await prepareLocalAttempt(await fixture());
    handles.push(handle);
    await cancelLocalAttempt(handle);
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      reason: 'cancelled',
      noWriter: true,
      group: null,
    });
    await expect(stat(join(handle.directory, 'stdout.jsonl'))).rejects.toThrow(
      /ENOENT/,
    );
  });
  it('cancels a running group including child dev server', async () => {
    const handle = await prepareLocalAttempt(await fixture('child-dev-server'));
    handles.push(handle);
    await launchLocalAttempt(handle);
    for (let index = 0; index < 60; index++) {
      if (
        (
          await readFile(join(handle.directory, 'stdout.jsonl'), 'utf8').catch(
            () => '',
          )
        ).includes('aggregated_output')
      )
        break;
      await delay(50);
    }
    await cancelLocalAttempt(handle);
    const receipt = await finish(handle);
    expect(receipt.reason).toBe('cancelled');
    expect(receipt.group && (await groupAbsent(receipt.group))).toBe(true);
  });
  it.each(['completion', 'cancellation'] as const)(
    'keeps inspection stopping throughout long TERM grace after %s',
    async (outcome) => {
      const input = await fixture(
        outcome === 'completion' ? 'success' : 'stall',
      );
      input.config.termGraceMs = 7500;
      input.config.wallTimeMs = 20_000;
      const handle = await prepareLocalAttempt(input);
      handles.push(handle);
      await launchLocalAttempt(handle);
      let observed = await inspectLocalAttempt(handle);
      const startingDeadline = Date.now() + 5000;
      while (
        !(
          observed.state === 'cancelling' ||
          (observed.state === 'running' && observed.receipt.group)
        ) &&
        Date.now() < startingDeadline
      ) {
        await delay(25);
        observed = await inspectLocalAttempt(handle);
      }
      if (outcome === 'cancellation') {
        if (observed.state !== 'running')
          throw new Error('Expected a running group before cancellation');
        await cancelLocalAttempt(handle);
      }
      while (observed.state === 'running' && Date.now() < startingDeadline) {
        await delay(25);
        observed = await inspectLocalAttempt(handle);
      }
      if (observed.state !== 'cancelling' || !observed.receipt.group)
        throw new Error('Expected a stopping owned process group');
      const firstHeartbeat = observed.receipt.at;
      const group = observed.receipt.group;
      expect(await groupAbsent(group)).toBe(false);
      let latestStoppingAt = firstHeartbeat;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        observed = await inspectLocalAttempt(handle);
        if (observed.state === 'finished') break;
        expect(observed.state).toBe('cancelling');
        if (observed.state !== 'cancelling')
          throw new Error('Lost stopping ownership during grace');
        expect(observed.receipt.noWriter).toBe(false);
        latestStoppingAt = observed.receipt.at;
        await delay(200);
      }
      // Observe fresh signed receipts beyond inspect's five-second stale limit.
      expect(latestStoppingAt - firstHeartbeat).toBeGreaterThan(5500);
      expect(observed.state).toBe('finished');
      if (observed.state !== 'finished')
        throw new Error('Termination timed out');
      expect(observed.receipt.noWriter).toBe(true);
      expect(observed.receipt.reason).toBe(
        outcome === 'completion' ? null : 'cancelled',
      );
      expect(await groupAbsent(group)).toBe(true);
    },
  );
  it('rejects attempt state overlapping either checkout before writing credentials', async () => {
    const input = await fixture();
    input.selectedAuth = { kind: 'api-key', value: 'synthetic-path-guard-key' };
    const source = input.ownedWorktree.sourceRoot;
    const snapshot = async (root: string) => {
      const paths = (await readdir(root, { recursive: true })).sort();
      return Promise.all(
        paths.map(async (path) => ({
          path,
          bytes: (await stat(join(root, path))).isFile()
            ? await readFile(join(root, path))
            : null,
        })),
      );
    };
    const roots = [source, input.ownedWorktree.root];
    const before = await Promise.all(roots.map(snapshot));
    for (const root of roots) {
      for (const directory of [
        join(root, '.neondeck-attempt'),
        join(root, '..attempt'),
        root,
        dirname(root),
        `${root}/../${root.split('/').at(-1)}`,
      ]) {
        await expect(
          prepareLocalAttempt({ ...input, directory }),
        ).rejects.toThrow('Attempt state must not overlap');
      }
      await expect(stat(join(root, '.neondeck-attempt'))).rejects.toThrow(
        /ENOENT/,
      );
      await expect(stat(join(root, '..attempt'))).rejects.toThrow(/ENOENT/);
      await expect(stat(join(root, 'home'))).rejects.toThrow(/ENOENT/);
      await expect(stat(join(dirname(root), 'home'))).rejects.toThrow(/ENOENT/);
    }
    const alias = join(dirname(input.directory), 'source-alias');
    await symlink(source, alias);
    await expect(
      prepareLocalAttempt({
        ...input,
        directory: join(alias, '.neondeck-attempt'),
      }),
    ).rejects.toThrow('canonical');
    expect(await Promise.all(roots.map(snapshot))).toEqual(before);
    await expect(stat(input.directory)).rejects.toThrow(/ENOENT/);
  });
  it('distinguishes parent components from double-dot-prefixed descendants', () => {
    const root = resolve('/owned');
    for (const path of ['..attempt', '..attempt/nested', 'child/../leaf'])
      expect(inside(root, resolve(root, path))).toBe(true);
    for (const path of [
      '.',
      '..',
      '../sibling',
      '../owned-other',
      'child/../../escaped',
    ])
      expect(inside(root, resolve(root, path))).toBe(false);
  });
  it('validates a double-dot-prefixed managed worktree and collects its untracked evidence', async () => {
    const input = await fixture();
    const root = join(input.ownedWorktree.storageRoot, '..owned');
    await exec(
      '/usr/bin/git',
      ['worktree', 'move', input.ownedWorktree.root, root],
      {
        cwd: input.ownedWorktree.sourceRoot,
      },
    );
    input.ownedWorktree.root = root;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    await finish(handle);
    await writeFile(join(root, '..evidence'), 'double-dot child content');
    const candidate = await collectLocalAttempt(handle);
    expect(
      JSON.parse(await readFile(candidate.untrackedRef, 'utf8')),
    ).toContainEqual(
      expect.objectContaining({
        path: '..evidence',
        contentBase64: Buffer.from('double-dot child content').toString(
          'base64',
        ),
      }),
    );
  });
  it('rejects primary checkout and wrong branch identity', async () => {
    const input = await fixture();
    input.ownedWorktree.root = input.ownedWorktree.sourceRoot;
    await expect(prepareLocalAttempt(input)).rejects.toThrow('path ownership');
    input.ownedWorktree.root = join(input.ownedWorktree.storageRoot, 'owned');
    input.ownedWorktree.branch = 'agent/factory-wrong';
    await expect(prepareLocalAttempt(input)).rejects.toThrow('branch identity');
  });
  it('quarantines tampered receipt, token mismatch, and contradictory no-writer proof', async () => {
    const handle = await prepareLocalAttempt(await fixture());
    handles.push(handle);
    await launchLocalAttempt(handle);
    await finish(handle);
    const receipt = v.parse(
      receiptSchema,
      await readSigned(
        join(handle.directory, 'receipt.json'),
        handle.attemptToken,
      ),
    );
    await writeSigned(
      join(handle.directory, 'receipt.json'),
      handle.attemptToken,
      { ...receipt, noWriter: false },
    );
    expect((await inspectLocalAttempt(handle)).state).toBe('needs-reconcile');
    await writeSigned(
      join(handle.directory, 'receipt.json'),
      handle.attemptToken,
      receipt,
    );
    expect(
      (await inspectLocalAttempt({ ...handle, attemptToken: 'a'.repeat(64) }))
        .state,
    ).toBe('needs-reconcile');
  });
  it('allowlists environment and keeps selected auth out of manifest and arguments', async () => {
    const input = await fixture();
    input.selectedAuth = { kind: 'api-key', value: 'synthetic-private-key' };
    const handle = await prepareLocalAttempt(input);
    const { manifest } = await loadLocalManifest(handle);
    const env = codexEnvironment(manifest);
    expect(env.HOME).toBe(join(handle.directory, 'home'));
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('synthetic-private-key');
    expect(codexArguments(manifest).join(' ')).not.toContain(
      'synthetic-private-key',
    );
    expect(
      (await stat(join(handle.directory, 'home/.codex/auth.json'))).mode &
        0o777,
    ).toBe(0o600);
    expect(codexArguments(manifest)).toContain(
      'cli_auth_credentials_store="file"',
    );
  });
  it('requires the pinned version and never falls back', async () => {
    const input = await fixture();
    // System utilities differ across GNU/BSD hosts in their --version output.
    // Keep this fixture's unsupported response short and deterministic.
    input.config.executable = join(
      dirname(input.directory),
      'unsupported-version.mjs',
    );
    await writeFile(
      input.config.executable,
      "#!/usr/bin/env node\nconsole.log('synthetic-unsupported-cli 9.9.9');\n",
      { mode: 0o700 },
    );
    expect(
      await inspectCodexReadiness(input.config, dirname(input.directory)),
    ).toMatchObject({
      ready: false,
      version: 'synthetic-unsupported-cli 9.9.9',
      reason: 'unsupported-cli-version',
    });
    input.config.executable = '/missing/codex';
    expect(
      await inspectCodexReadiness(input.config, dirname(input.directory)),
    ).toMatchObject({ ready: false, reason: 'cli-unavailable' });
  });
  it('rejects duplicate terminal and session events', () => {
    const events = new CodexEvents();
    events.accept('{"type":"thread.started","thread_id":"test"}');
    events.accept('{"type":"turn.started"}');
    events.accept('{"type":"turn.completed"}');
    expect(() => events.accept('{"type":"turn.failed"}')).toThrow(
      'Contradictory',
    );
    expect(() =>
      events.accept('{"type":"thread.started","thread_id":"second"}'),
    ).toThrow('Duplicate');
  });
  it('survives controller death and enforces its budget without the controller', async () => {
    const input = await fixture('stall');
    input.config.wallTimeMs = 800;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    const first = await controller(handle, 'launch', true);
    first.child.kill('SIGKILL');
    const receipt = await finish(handle);
    expect(receipt).toMatchObject({
      noWriter: true,
      reason: 'wall-time-limit',
    });
    expect((await controller(handle, 'inspect')).value.state).toBe('finished');
  });
  it('a fresh controller completes durable cancellation of the same group', async () => {
    const handle = await prepareLocalAttempt(await fixture('stall'));
    handles.push(handle);
    const first = await controller(handle, 'launch', true);
    first.child.kill('SIGKILL');
    await controller(handle, 'cancel');
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      reason: 'cancelled',
    });
  });
  it('fences concurrent launch and rejects collection while live', async () => {
    const handle = await prepareLocalAttempt(await fixture('stall'));
    handles.push(handle);
    await Promise.all([launchLocalAttempt(handle), launchLocalAttempt(handle)]);
    await expect(collectLocalAttempt(handle)).rejects.toThrow('writer state');
    await cancelLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      reason: 'cancelled',
    });
  });
  it('reports total output exhaustion distinctly', async () => {
    const input = await fixture();
    input.config.maxOutputBytes = 120;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      reason: 'output-limit',
    });
  });
  it('rejects a missing terminal event even with exit zero', async () => {
    const input = await fixture();
    const executable = join(dirname(input.directory), 'missing-terminal.mjs');
    await writeFile(
      executable,
      '#!/usr/bin/env node\n' +
        `if (process.argv.includes('--version')) console.log('mockdex codex-contract 0.150.1'); else { console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'})); console.log(JSON.stringify({type:'turn.started'})); }`,
      { mode: 0o700 },
    );
    input.config.executable = executable;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      exitCode: 0,
      terminal: null,
      reason: 'provider-terminal-missing-or-failed',
    });
  });
  it('retains an attempt if executable readiness changes after preparation', async () => {
    const input = await fixture();
    const executable = join(dirname(input.directory), 'removed-cli.mjs');
    await writeFile(executable, await readFile(mock), { mode: 0o700 });
    input.config.executable = executable;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await rm(executable);
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      group: null,
      reason: 'host-preflight-failed',
    });
  });
  it('redacts selected auth fields before persisting chunked stdout and stderr', async () => {
    const input = await fixture();
    const executable = join(dirname(input.directory), 'echo-auth.mjs');
    await writeFile(
      executable,
      '#!/usr/bin/env node\n' +
        `import {readFileSync} from 'node:fs';
      if (process.argv.includes('--version')) console.log('mockdex codex-contract 0.150.1');
      else { const auth=JSON.parse(readFileSync(process.env.CODEX_HOME+'/auth.json','utf8'));
        console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'})); console.log(JSON.stringify({type:'turn.started'}));
        const secret=auth.tokens.access_token;
        process.stdout.write(JSON.stringify({type:'item.completed',text:secret}).slice(0,40));
        setTimeout(() => {process.stdout.write(JSON.stringify({type:'item.completed',text:secret}).slice(40)+'\\n'); console.error(auth.tokens.refresh_token); console.log(JSON.stringify({type:'turn.completed'}));},20);
      }`,
      { mode: 0o700 },
    );
    input.config.executable = executable;
    input.selectedAuth = {
      kind: 'auth-json',
      value: JSON.stringify({
        tokens: {
          access_token: 'synthetic-access-credential',
          refresh_token: 'synthetic-refresh-credential',
          id_token: 'synthetic-id-credential',
        },
      }),
    };
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      reason: null,
    });
    const output = await readFile(
      join(handle.directory, 'stdout.jsonl'),
      'utf8',
    );
    const stderr = await readFile(join(handle.directory, 'stderr.log'), 'utf8');
    expect(output).toContain('[REDACTED]');
    expect(stderr).toContain('[REDACTED]');
    expect(output + stderr).not.toContain('synthetic-access-credential');
    expect(output + stderr).not.toContain('synthetic-refresh-credential');
    await expect(
      stat(join(handle.directory, 'home/.codex/auth.json')),
    ).rejects.toThrow(/ENOENT/);
    expect(
      await readFile(join(handle.directory, 'receipt.json'), 'utf8'),
    ).not.toContain('synthetic-access-credential');
  });
  it('recovers dead supervisor only after its authenticated whole group is absent', async () => {
    const input = await fixture('stall');
    input.config.wallTimeMs = 500;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    let inspected = await inspectLocalAttempt(handle);
    for (let index = 0; index < 60; index++) {
      inspected = await inspectLocalAttempt(handle);
      if (inspected.state === 'running' && inspected.receipt.group) break;
      await delay(20);
    }
    if (inspected.state !== 'running' || !inspected.receipt.group)
      throw new Error('Expected authenticated live group');
    process.kill(inspected.receipt.supervisor.pid, 'SIGKILL');
    await delay(100);
    expect((await reconcileLocalAttempt(handle)).state).toBe('needs-reconcile');
    await cancelLocalAttempt(handle);
    const until = Date.now() + 9000;
    let result = await reconcileLocalAttempt(handle);
    while (result.state !== 'finished' && Date.now() < until) {
      await delay(100);
      result = await reconcileLocalAttempt(handle);
    }
    expect(result.state).toBe('finished');
    if (result.state !== 'finished')
      throw new Error('Expected recovered terminal receipt');
    expect(result.receipt).toMatchObject({
      noWriter: true,
      reason: 'cancelled',
      exitCode: null,
    });
    expect((await launchLocalAttempt(handle)).state).toBe('finished');
  });
  it('makes temporary credential cleanup failure visible without revoking provider auth', async () => {
    const input = await fixture();
    const executable = join(dirname(input.directory), 'cleanup-failure.mjs');
    await writeFile(
      executable,
      '#!/usr/bin/env node\n' +
        `import {chmodSync} from 'node:fs';
      if (process.argv.includes('--version')) console.log('mockdex codex-contract 0.150.1');
      else {chmodSync(process.env.CODEX_HOME,0o755); console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'})); console.log(JSON.stringify({type:'turn.started'})); console.log(JSON.stringify({type:'turn.completed'}));}`,
      { mode: 0o700 },
    );
    input.config.executable = executable;
    input.selectedAuth = { kind: 'api-key', value: 'synthetic-cleanup-key' };
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      authCleanup: 'failed',
      reason: 'credential-cleanup-failed',
    });
    expect(
      await readFile(join(handle.directory, 'home/.codex/auth.json'), 'utf8'),
    ).toContain('synthetic-cleanup-key');
  });
  it('preserves the original candidate across concurrent collection and later worktree edits', async () => {
    const input = await fixture();
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    await finish(handle);
    const [first, second] = await Promise.all([
      collectLocalAttempt(handle),
      collectLocalAttempt(handle),
    ]);
    expect(second).toEqual(first);
    const paths = [
      first.statusRef,
      first.diffRef,
      first.untrackedRef,
      join(handle.directory, 'candidate.json'),
    ];
    const before = await Promise.all(paths.map((path) => readFile(path)));
    await writeFile(
      join(input.ownedWorktree.root, 'base.txt'),
      'external edit after collection\n',
    );
    await writeFile(
      join(input.ownedWorktree.root, 'mockdex-result.txt'),
      'different untracked bytes\n',
    );
    expect(await collectLocalAttempt(handle)).toEqual(first);
    const after = await Promise.all(paths.map((path) => readFile(path)));
    expect(after).toEqual(before);
    await writeFile(first.diffRef, 'corrupt retained artifact');
    await expect(collectLocalAttempt(handle)).rejects.toThrow('integrity');
    expect(await readFile(first.diffRef, 'utf8')).toBe(
      'corrupt retained artifact',
    );
    expect(await readFile(join(handle.directory, 'candidate.json'))).toEqual(
      before[3],
    );
  });
  it('keeps the anchor watchdog alive when CLI exits after supervisor IPC disappears', async () => {
    const input = await fixture('stall');
    input.config.wallTimeMs = 1500;
    const executable = join(dirname(input.directory), 'late-exit.mjs');
    await writeFile(
      executable,
      '#!/usr/bin/env node\n' +
        `import {spawn} from 'node:child_process'; import {writeFileSync,existsSync} from 'node:fs';
      if(process.argv.includes('--version')) console.log('mockdex codex-contract 0.150.1');
      else { const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{}); require("node:http").createServer((q,s)=>s.end("alive")).listen(0,"127.0.0.1");'],{stdio:'ignore'});
        writeFileSync('server.pid',String(child.pid));
        console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'})); console.log(JSON.stringify({type:'turn.started'}));
        setInterval(()=>{if(existsSync('exit-now')){writeFileSync('cli-exited','yes');process.exit(0);}},20);
      }`,
      { mode: 0o700 },
    );
    input.config.executable = executable;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    let observed = await inspectLocalAttempt(handle);
    for (let index = 0; index < 80; index++) {
      observed = await inspectLocalAttempt(handle);
      if (
        observed.state === 'running' &&
        observed.receipt.group &&
        (await stat(join(input.ownedWorktree.root, 'server.pid')).then(
          () => true,
          () => false,
        ))
      )
        break;
      await delay(20);
    }
    if (observed.state !== 'running' || !observed.receipt.group)
      throw new Error('Expected authenticated anchor');
    const group = observed.receipt.group;
    process.kill(observed.receipt.supervisor.pid, 'SIGKILL');
    await delay(100);
    await writeFile(join(input.ownedWorktree.root, 'exit-now'), 'exit');
    for (let index = 0; index < 40; index++) {
      if (
        await stat(join(input.ownedWorktree.root, 'cli-exited')).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(20);
    }
    await delay(200);
    const leader = (await processTable()).find(
      (row) => row.pid === group.pid && !row.zombie,
    );
    expect(leader && sameProcess(group, leader)).toBe(true);
    const until = Date.now() + 9000;
    while (!(await groupAbsent(group)) && Date.now() < until) await delay(100);
    expect(await groupAbsent(group)).toBe(true);
    const result = await reconcileLocalAttempt(handle);
    expect(result.state).toBe('finished');
    if (result.state !== 'finished')
      throw new Error('Expected recovered failure');
    expect(result.receipt.reason).toBe('supervisor-lost');
  });
  it('launches mockdex from a real packed package under node_modules without TS stripping', async () => {
    const input = await fixture();
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    const installation = await realpath(
      await mkdtemp(join(tmpdir(), 'factory-packed-')),
    );
    folders.push(installation);
    const repository = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../..',
    );
    await exec('npm', ['run', 'build:server'], {
      cwd: repository,
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const packed = await exec(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        installation,
      ],
      { cwd: repository, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    );
    const listing = v.parse(
      v.array(v.object({ filename: v.string() })),
      JSON.parse(packed.stdout),
    );
    if (!listing[0]) throw new Error('Missing npm tarball');
    const installed = join(installation, 'node_modules/neondeck');
    await mkdir(installed, { recursive: true });
    await exec('/usr/bin/tar', [
      '-xzf',
      join(installation, listing[0].filename),
      '-C',
      installed,
      '--strip-components=1',
    ]);
    await cp(
      await realpath(join(repository, 'node_modules/valibot')),
      join(installation, 'node_modules/valibot'),
      { recursive: true },
    );
    const entry = pathToFileURL(join(installed, 'dist/local-host.mjs')).href;
    await controller(handle, 'launch', false, entry);
    const receipt = await finish(handle);
    expect(receipt).toMatchObject({
      noWriter: true,
      reason: null,
      terminal: 'completed',
    });
    expect(receipt.supervisor.command).toContain(
      '/node_modules/neondeck/dist/assets/coding-runs/local-supervisor.mjs',
    );
    expect(receipt.group?.command).toContain(
      '/node_modules/neondeck/dist/assets/coding-runs/local-anchor.mjs',
    );
    expect(
      await readFile(
        join(input.ownedWorktree.root, 'mockdex-result.txt'),
        'utf8',
      ),
    ).toContain('mockdex');
  });
  it.each(['clean', 'process'] as const)(
    'rejects effective local %s filters before collection can launch their child',
    async (filterKind) => {
      const input = await fixture();
      const handle = await prepareLocalAttempt(input);
      handles.push(handle);
      await launchLocalAttempt(handle);
      await finish(handle);
      const script = join(dirname(input.directory), 'forbidden-filter.mjs');
      const marker = join(dirname(input.directory), 'filter-was-launched');
      await writeFile(
        script,
        `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
      writeFileSync(${JSON.stringify(marker)},'launched');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      setTimeout(()=>{child.kill('SIGKILL');process.exit(1)},2000);
      process.stdin.resume();`,
        { mode: 0o600 },
      );
      await writeFile(
        join(input.ownedWorktree.root, '.gitattributes'),
        'base.txt filter=forbidden\n',
      );
      await writeFile(
        join(input.ownedWorktree.root, 'base.txt'),
        'modified attributed content\n',
      );
      const shellQuote = (value: string) =>
        "'" + value.replaceAll("'", "'\"'\"'") + "'";
      await exec(
        '/usr/bin/git',
        [
          'config',
          `filter.forbidden.${filterKind}`,
          `${shellQuote(process.execPath)} ${shellQuote(script)}`,
        ],
        { cwd: input.ownedWorktree.root },
      );
      await expect(collectLocalAttempt(handle)).rejects.toThrow(
        'Executable Git clean/process filters',
      );
      await expect(stat(marker)).rejects.toThrow(/ENOENT/);
      await expect(
        stat(join(handle.directory, 'candidate.json')),
      ).rejects.toThrow(/ENOENT/);
      expect(
        await readFile(join(input.ownedWorktree.root, 'base.txt'), 'utf8'),
      ).toBe('modified attributed content\n');
    },
  );
  it('publishes durable cancellation before prepare creates the attempt directory', async () => {
    const input = await fixture();
    publishLocalCancellation({
      directory: input.directory,
      attemptToken: input.attemptToken,
    });
    await expect(stat(input.directory)).rejects.toThrow(/ENOENT/);
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      reason: 'cancelled',
      group: null,
    });
    await expect(
      stat(join(input.ownedWorktree.root, 'mockdex-result.txt')),
    ).rejects.toThrow(/ENOENT/);
  });
  it('rejects revocation before the anchor authorization point without launching the provider', async () => {
    const input = await fixture();
    input.testPauseBeforeSpawn = true;
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    for (let index = 0; index < 100; index++) {
      if (
        await stat(join(handle.directory, 'test-spawn.ready')).then(
          () => true,
          () => false,
        )
      )
        break;
      await delay(20);
    }
    expect(
      (await stat(join(handle.directory, 'test-spawn.ready'))).isFile(),
    ).toBe(true);
    publishLocalCancellation(handle);
    await rm(join(handle.directory, 'test-spawn.pause'));
    expect(await finish(handle)).toMatchObject({
      noWriter: true,
      reason: 'cancelled',
    });
    await expect(
      stat(join(input.ownedWorktree.root, 'mockdex-result.txt')),
    ).rejects.toThrow(/ENOENT/);
  });
  it('rejects submodule collection before nested Git can invoke its local filter', async () => {
    const input = await fixture();
    const handle = await prepareLocalAttempt(input);
    handles.push(handle);
    await launchLocalAttempt(handle);
    await finish(handle);
    const nested = join(input.ownedWorktree.root, 'nested');
    await mkdir(nested);
    await exec('/usr/bin/git', ['init', '-q'], { cwd: nested });
    await writeFile(join(nested, 'file.txt'), 'original\n');
    await exec('/usr/bin/git', ['add', 'file.txt'], { cwd: nested });
    await exec(
      '/usr/bin/git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-qm',
        'nested',
      ],
      { cwd: nested },
    );
    const sha = (
      await exec('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: nested })
    ).stdout.trim();
    await exec(
      '/usr/bin/git',
      ['update-index', '--add', '--cacheinfo', `160000,${sha},nested`],
      { cwd: input.ownedWorktree.root },
    );
    const marker = join(dirname(input.directory), 'nested-filter-launched');
    const script = join(dirname(input.directory), 'nested-filter.mjs');
    await writeFile(
      script,
      `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'launched'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setTimeout(()=>{child.kill('SIGKILL');process.exit(1)},2000);process.stdin.resume();`,
    );
    const quote = (value: string) =>
      "'" + value.replaceAll("'", "'\"'\"'") + "'";
    await exec(
      '/usr/bin/git',
      [
        'config',
        'filter.nested.clean',
        `${quote(process.execPath)} ${quote(script)}`,
      ],
      { cwd: nested },
    );
    await writeFile(join(nested, '.gitattributes'), 'file.txt filter=nested\n');
    await writeFile(join(nested, 'file.txt'), 'modified\n');
    await expect(collectLocalAttempt(handle)).rejects.toThrow(
      'Submodule collection',
    );
    await expect(stat(marker)).rejects.toThrow(/ENOENT/);
    await expect(
      stat(join(handle.directory, 'candidate.json')),
    ).rejects.toThrow(/ENOENT/);
  });
});

// This matrix is collected in the foundation but only executes on a supported
// host after the provider's separately reviewed compiled registration lands.
const optionalHostProviders = [
  {
    id: 'opencode',
    version: 'mock-opencode 1.18.29',
    script: 'mock-opencode.mjs',
    model: 'openai/fixture-model',
  },
  {
    id: 'kilo',
    version: 'mock-kilo-factory 7.4.23',
    script: 'mock-kilo-factory.mjs',
    model: 'kilo/fixture-model',
  },
] as const;
for (const provider of optionalHostProviders) {
  describe.skipIf(
    process.platform !== 'linux' ||
      !listCodingAdapters().some((adapter) => adapter.id === provider.id),
  )(`${provider.id} shared host conformance (synthetic Linux CLI)`, () => {
    async function providerFixture(
      scenario: PrepareLocalAttemptInput['config']['mockScenario'] = 'success',
      prompt = 'Create a deterministic candidate.',
    ) {
      const input = await fixture(scenario);
      input.config.executable = resolve(dirname(mock), provider.script);
      input.config.model = provider.model;
      input.config.adapter = {
        id: provider.id,
        contractVersion: 1,
        cliVersion: provider.version,
      };
      input.expectedExecutableIdentity = await executableIdentity(
        input.config.executable,
      );
      input.selectedAuth = {
        kind: 'api-key',
        value: 'synthetic-host-fixture-key',
      };
      input.prompt = prompt;
      return input;
    }
    it.each(['failure', 'malformed', 'stall'] as const)(
      'settles %s only with death proof and credential cleanup',
      async (scenario) => {
        const input = await providerFixture(scenario);
        if (scenario === 'stall') input.config.wallTimeMs = 600;
        const handle = await prepareLocalAttempt(input);
        handles.push(handle);
        await launchLocalAttempt(handle);
        const receipt = await finish(handle);
        expect(receipt.noWriter).toBe(true);
        expect(receipt.authCleanup).toBe('removed');
        expect(receipt.reason).not.toBeNull();
        if (scenario === 'malformed')
          expect(receipt.reason).toBe('malformed-provider-output');
        if (scenario === 'stall')
          expect(receipt.reason).toBe('wall-time-limit');
        expect(receipt.group && (await groupAbsent(receipt.group))).toBe(true);
      },
    );
    it('rejects missing terminal evidence after actual provider exit', async () => {
      const input = await providerFixture('success', 'fixture:absent-terminal');
      const handle = await prepareLocalAttempt(input);
      handles.push(handle);
      await launchLocalAttempt(handle);
      expect(await finish(handle)).toMatchObject({
        noWriter: true,
        terminal: null,
        reason: 'provider-terminal-missing-or-failed',
        authCleanup: 'removed',
      });
    });
    it('removes a live owned child before cancellation settles', async () => {
      const input = await providerFixture('child-dev-server');
      input.config.termGraceMs = 500;
      const handle = await prepareLocalAttempt(input);
      handles.push(handle);
      await launchLocalAttempt(handle);
      let observed = await inspectLocalAttempt(handle);
      for (let i = 0; i < 100; i++) {
        observed = await inspectLocalAttempt(handle);
        if (
          (observed.state === 'running' || observed.state === 'cancelling') &&
          observed.receipt.sessionId
        )
          break;
        await delay(20);
      }
      await cancelLocalAttempt(handle);
      const receipt = await finish(handle);
      expect(receipt).toMatchObject({
        noWriter: true,
        reason: 'cancelled',
        authCleanup: 'removed',
      });
      expect(receipt.group && (await groupAbsent(receipt.group))).toBe(true);
    });
    it('retains uncertain supervisor death and never starts a replacement', async () => {
      const input = await providerFixture('stall');
      input.config.wallTimeMs = 1000;
      const handle = await prepareLocalAttempt(input);
      handles.push(handle);
      await launchLocalAttempt(handle);
      let observed = await inspectLocalAttempt(handle);
      for (let i = 0; i < 100; i++) {
        observed = await inspectLocalAttempt(handle);
        if (
          observed.state === 'running' &&
          observed.receipt.group &&
          observed.receipt.sessionId
        )
          break;
        await delay(20);
      }
      if (observed.state !== 'running' || !observed.receipt.group)
        throw new Error('Expected authenticated provider group');
      process.kill(observed.receipt.supervisor.pid, 'SIGKILL');
      await delay(100);
      expect((await reconcileLocalAttempt(handle)).state).toBe(
        'needs-reconcile',
      );
      expect((await launchLocalAttempt(handle)).state).toBe('needs-reconcile');
      await cancelLocalAttempt(handle);
      const until = Date.now() + 9000;
      let result = await reconcileLocalAttempt(handle);
      while (result.state !== 'finished' && Date.now() < until) {
        await delay(100);
        result = await reconcileLocalAttempt(handle);
      }
      expect(result.state).toBe('finished');
      if (result.state !== 'finished')
        throw new Error('Expected recovered dead provider');
      expect(result.receipt).toMatchObject({
        noWriter: true,
        reason: 'cancelled',
        authCleanup: 'removed',
      });
      expect((await launchLocalAttempt(handle)).state).toBe('finished');
    });
  });
}
