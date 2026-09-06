import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as v from 'valibot';
import {
  handleSchema,
  prepareSchema,
  manifestSchema,
  receiptSchema,
  type LocalAttemptHandle,
  type LocalInspection,
} from './host-contract.ts';
import {
  atomicWrite,
  privateDirectory,
  readSigned,
  writeSigned,
  message,
} from './host-io.ts';
import {
  groupAbsent,
  identify,
  sameProcess,
  localHostCapability,
} from './host-process.ts';
import { inside, verifyOwnedWorktree } from './host-workspace.ts';
import { inspectCodexReadiness } from './codex-readiness.ts';
import { publishLocalCancellation } from './host-launch-gate.ts';
export { publishLocalCancellation } from './host-launch-gate.ts';
export { reconcileLocalAttempt } from './local-reconcile.ts';
export { collectLocalAttempt } from './local-collect.ts';
export { inspectCodexReadiness } from './codex-readiness.ts';
export { localHostCapability } from './host-process.ts';
export type {
  LocalAttemptHandle,
  PrepareLocalAttemptInput,
  LocalInspection,
  LocalReceipt,
} from './host-contract.ts';

export async function prepareLocalAttempt(
  input: unknown,
): Promise<LocalAttemptHandle> {
  const parsed = v.safeParse(prepareSchema, input);
  if (!parsed.success) throw new Error('Invalid local attempt configuration');
  const value = parsed.output;
  if (value.testPauseBeforeSpawn && !value.config.mockScenario)
    throw new Error(
      'Provider-spawn test pause requires an explicit mock configuration',
    );
  if (!localHostCapability().supported)
    throw new Error('Unsupported local host platform');
  await verifyOwnedWorktree(value.ownedWorktree, true);
  const directory = resolve(value.directory);
  if (
    [value.ownedWorktree.root, value.ownedWorktree.sourceRoot].some(
      (root) =>
        inside(root, directory) ||
        directory === root ||
        inside(directory, root),
    )
  )
    throw new Error(
      'Attempt state must not overlap source or managed worktrees',
    );
  if (
    directory !== value.directory ||
    (await realpath(dirname(directory))) !== dirname(directory)
  )
    throw new Error('Attempt parent must be canonical');
  await mkdir(value.directory, { mode: 0o700 });
  await privateDirectory(value.directory);
  for (const path of [
    'home/.codex',
    'home/.config',
    'home/.local/share',
    'home/.local/state',
    'home/.cache',
    'scratch',
  ])
    await mkdir(join(value.directory, path), { recursive: true, mode: 0o700 });
  const readiness = await inspectCodexReadiness(
    value.config,
    join(value.directory, 'scratch'),
  );
  if (!readiness.ready)
    throw new Error(readiness.reason ?? 'Codex unavailable');
  if (value.selectedAuth) {
    const auth: unknown =
      value.selectedAuth.kind === 'api-key'
        ? { OPENAI_API_KEY: value.selectedAuth.value }
        : JSON.parse(value.selectedAuth.value);
    v.parse(v.record(v.string(), v.unknown()), auth);
    await atomicWrite(
      join(value.directory, 'home/.codex/auth.json'),
      JSON.stringify(auth),
    );
  }
  await atomicWrite(join(value.directory, 'prompt.txt'), value.prompt);
  if (value.testPauseBeforeSpawn)
    await atomicWrite(join(value.directory, 'test-spawn.pause'), 'paused');
  const manifest = v.parse(manifestSchema, {
    version: 1,
    attemptId: value.attemptId,
    cliVersion: readiness.version,
    testPauseBeforeSpawn: value.testPauseBeforeSpawn,
    directory: value.directory,
    ownedWorktree: value.ownedWorktree,
    config: value.config,
    nonce: randomBytes(16).toString('hex'),
  });
  await writeSigned(
    join(value.directory, 'manifest.json'),
    value.attemptToken,
    manifest,
  );
  return { directory: value.directory, attemptToken: value.attemptToken };
}
export async function loadLocalManifest(input: unknown) {
  const handle = v.parse(handleSchema, input);
  await privateDirectory(handle.directory);
  const manifest = v.parse(
    manifestSchema,
    await readSigned(
      join(handle.directory, 'manifest.json'),
      handle.attemptToken,
    ),
  );
  if (manifest.directory !== handle.directory)
    throw new Error('Attempt directory identity mismatch');
  return { handle, manifest };
}
export async function launchLocalAttempt(
  input: unknown,
): Promise<LocalInspection> {
  const { handle, manifest } = await loadLocalManifest(input);
  await verifyOwnedWorktree(manifest.ownedWorktree, true);
  // Permanent launch fence. A crash between claim and spawn MUST NOT retry.
  const claim = await open(
    join(handle.directory, 'launch.claim'),
    'wx',
    0o600,
  ).catch(() => null);
  if (!claim) return inspectLocalAttempt(handle);
  await claim.sync();
  await claim.close();
  const entryUrl = [
    './local-supervisor.mjs',
    './assets/coding-runs/local-supervisor.mjs',
    './local-supervisor.ts',
  ]
    .map((path) => new URL(path, import.meta.url))
    .find((url) => existsSync(url));
  if (!entryUrl)
    return {
      state: 'needs-reconcile',
      reason: 'Supervisor asset missing; launch claim retained',
    };
  const entry = fileURLToPath(entryUrl);
  const supervisor = spawn(process.execPath, [entry, manifest.nonce], {
    cwd: handle.directory,
    detached: true,
    env: { PATH: manifest.config.path },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  supervisor.on('error', () => {});
  supervisor.on('spawn', () =>
    supervisor.send(handle, () => {
      if (supervisor.connected) supervisor.disconnect();
      supervisor.unref();
    }),
  );
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const state = await inspectLocalAttempt(handle);
    if (state.state !== 'needs-reconcile') return state;
    await delay(50);
  }
  return {
    state: 'needs-reconcile',
    reason: 'Supervisor launch unconfirmed; never relaunch this attempt',
  };
}
export async function inspectLocalAttempt(
  input: unknown,
): Promise<LocalInspection> {
  try {
    const { handle, manifest } = await loadLocalManifest(input);
    let raw: unknown;
    try {
      raw = await readSigned(
        join(handle.directory, 'receipt.json'),
        handle.attemptToken,
      );
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      raw = await readSigned(
        join(handle.directory, 'heartbeat.json'),
        handle.attemptToken,
      );
    }
    const receipt = v.parse(receiptSchema, raw);
    if (
      receipt.nonce !== manifest.nonce ||
      receipt.attemptId !== manifest.attemptId
    )
      throw new Error('Receipt identity mismatch');
    if (receipt.at > Date.now() + 1000)
      throw new Error('Receipt timestamp is in the future');
    if (receipt.state === 'finished') {
      if (receipt.authCleanup === 'pending')
        throw new Error('Credential cleanup not settled');
      if (
        !receipt.reason &&
        (receipt.exitCode !== 0 ||
          receipt.terminal !== 'completed' ||
          !receipt.sessionId)
      )
        throw new Error('Receipt contradicts provider outcome');
      if (
        !receipt.noWriter ||
        (receipt.group && !(await groupAbsent(receipt.group)))
      )
        throw new Error('Receipt contradicts live group');
      if (
        !receipt.group &&
        ![
          'cancelled',
          'host-preflight-failed',
          'credential-cleanup-failed',
        ].includes(receipt.reason ?? '')
      )
        throw new Error('Receipt lacks process ownership');
      return { state: 'finished', receipt };
    }
    if (
      receipt.state === 'needs-reconcile' ||
      receipt.noWriter ||
      Date.now() - receipt.at > 5000 ||
      receipt.at > Date.now() + 1000
    )
      throw new Error('Supervisor state uncertain');
    if (
      !sameProcess(
        receipt.supervisor,
        await identify(receipt.supervisor.pid, manifest.nonce),
      )
    )
      throw new Error('Supervisor identity changed');
    return { state: receipt.state, receipt };
  } catch (error) {
    return { state: 'needs-reconcile', reason: message(error) };
  }
}
export async function cancelLocalAttempt(
  input: unknown,
): Promise<LocalInspection> {
  const handle = v.parse(handleSchema, input);
  publishLocalCancellation(handle);
  return inspectLocalAttempt(handle);
}
