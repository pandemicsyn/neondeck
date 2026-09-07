// A stable group leader keeps the process group authenticated after the CLI exits.
// The supervisor alone kills this group and writes the final receipt afterward.
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { readBounded } from './host-io.ts';
import {
  adapterLaunch,
  executableIdentity,
  verifyAdapterWorkspace,
} from './adapter-host.ts';
import {
  manifestSchema,
  handleSchema,
  type LocalAttemptHandle,
} from './host-contract.ts';
import * as v from 'valibot';
import { join } from 'node:path';
import {
  localCancellationRequested,
  withLocalLaunchGate,
} from './host-launch-gate.ts';

process.on('SIGTERM', () => {});
const keeper = setInterval(() => {}, 1000);
// If the supervisor dies, do not silently orphan a writable CLI. Its own group
// watchdog kills all members; absence of a receipt remains needs-reconcile.
let deadline = Date.now() + 15_000;
setInterval(() => {
  if (Date.now() > deadline) process.kill(-process.pid, 'SIGKILL');
}, 100);
process.once('message', (value: unknown) => {
  const { manifest, handle } = v.parse(
    v.strictObject({ manifest: manifestSchema, handle: handleSchema }),
    value,
  );
  if (
    handle.directory !== manifest.directory ||
    process.argv[2] !== manifest.nonce
  )
    throw new Error('Anchor ownership mismatch');
  deadline =
    Date.now() +
    manifest.config.wallTimeMs +
    manifest.config.termGraceMs +
    5000;
  void run(manifest, handle).catch(() => reply({ kind: 'error' }));
});
async function run(
  manifest: v.InferOutput<typeof manifestSchema>,
  handle: LocalAttemptHandle,
) {
  const prompt = await readBounded(join(manifest.directory, 'prompt.txt'));
  if (manifest.testPauseBeforeSpawn) {
    if (!manifest.config.mockScenario)
      throw new Error('Test pause is not enabled for production');
    writeFileSync(join(manifest.directory, 'test-spawn.ready'), 'ready', {
      flag: 'wx',
      mode: 0o600,
    });
    while (existsSync(join(manifest.directory, 'test-spawn.pause')))
      await delay(20);
  }
  verifyAdapterWorkspace(manifest);
  const launch = adapterLaunch(manifest);
  if (
    manifest.executableIdentity &&
    JSON.stringify(await executableIdentity(manifest.config.executable)) !==
      JSON.stringify(manifest.executableIdentity)
  )
    throw new Error('CLI executable changed');
  const started = withLocalLaunchGate(handle, () => {
    // This synchronous check+spawn under the shared gate is the authorization
    // linearization point. Later cancellation terminates the already-owned group.
    if (localCancellationRequested(handle, manifest.nonce)) return false;
    verifyAdapterWorkspace(manifest);
    const child = spawn(manifest.config.executable, launch.args, {
      cwd: manifest.ownedWorktree.root,
      env: launch.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.once('spawn', () =>
      reply({ kind: 'started', startedAt: Date.now() }),
    );
    child.once('error', () => reply({ kind: 'error' }));
    child.once('exit', (code, signal) =>
      reply({ kind: 'exit', code, signal, endedAt: Date.now() }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    return true;
  });
  if (!started) reply({ kind: 'cancelled' });
}
process.on('disconnect', () => {
  /* watchdog remains responsible for the group */
});
reply({ kind: 'ready' });
void keeper;

// A disconnect can race the connected check. The callback consumes asynchronous
// ERR_IPC_CHANNEL_CLOSED; the catch covers synchronous send failures. Neither
// outcome is allowed to terminate the group watchdog.
function reply(
  value:
    | { kind: 'ready' | 'error' | 'cancelled' }
    | { kind: 'started'; startedAt: number }
    | {
        kind: 'exit';
        code: number | null;
        signal: NodeJS.Signals | null;
        endedAt: number;
      },
) {
  if (!process.connected || !process.send) return;
  try {
    process.send(value, () => {});
  } catch {
    /* parent is gone; watchdog owns cleanup */
  }
}
