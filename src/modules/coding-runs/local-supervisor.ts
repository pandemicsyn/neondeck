import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as v from 'valibot';
import {
  handleSchema,
  manifestSchema,
  receiptSchema,
  type LocalReceipt,
} from './host-contract.ts';
import { privateDirectory, readSigned, writeSigned } from './host-io.ts';
import { identify, groupAbsent, signalOwnedGroup } from './host-process.ts';
import { verifyOwnedWorktree } from './host-workspace.ts';
import { inspectCodexReadiness } from './codex-readiness.ts';
import {
  selectedCredentialRedactor,
  removeAttemptCredentials,
} from './codex-auth.ts';
import { localCancellationRequested } from './host-launch-gate.ts';
import { HostOutput } from './host-output.ts';

const abandoned = setTimeout(() => process.exit(1), 10_000);
process.on('disconnect', () => {});
process.once('message', (value: unknown) => {
  clearTimeout(abandoned);
  void supervise(value).catch(() => process.exit(1));
});
async function supervise(value: unknown) {
  const handle = v.parse(handleSchema, value);
  await privateDirectory(handle.directory);
  const manifest = v.parse(
    manifestSchema,
    await readSigned(
      join(handle.directory, 'manifest.json'),
      handle.attemptToken,
    ),
  );
  if (
    manifest.directory !== handle.directory ||
    process.argv[2] !== manifest.nonce
  )
    throw new Error('Supervisor ownership mismatch');
  const receipt: LocalReceipt = {
    version: 1,
    attemptId: manifest.attemptId,
    nonce: manifest.nonce,
    at: Date.now(),
    supervisor: await identify(process.pid, manifest.nonce),
    group: null,
    state: 'running',
    reason: null,
    exitCode: null,
    signal: null,
    sessionId: null,
    terminal: null,
    outputBytes: 0,
    noWriter: false,
    authCleanup: 'pending',
  };
  const persist = async () => {
    receipt.at = Date.now();
    await writeSigned(
      join(handle.directory, 'heartbeat.json'),
      handle.attemptToken,
      v.parse(receiptSchema, receipt),
    );
  };
  const cancelled = () => localCancellationRequested(handle, manifest.nonce);
  await persist();
  let output: HostOutput | undefined;
  let spawnAttempted = false;
  try {
    await verifyOwnedWorktree(manifest.ownedWorktree, true);
    const readiness = await inspectCodexReadiness(
      manifest.config,
      join(handle.directory, 'scratch'),
    );
    if (!readiness.ready || readiness.version !== manifest.cliVersion)
      throw new Error('CLI readiness changed');
    if (await cancelled()) {
      receipt.reason = 'cancelled';
      receipt.noWriter = true;
    } else {
      output = new HostOutput(
        manifest,
        await selectedCredentialRedactor(handle.directory),
      );
      const captured = output;
      spawnAttempted = true;
      const anchor = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              existsSync(new URL('./local-anchor.mjs', import.meta.url))
                ? './local-anchor.mjs'
                : './local-anchor.ts',
              import.meta.url,
            ),
          ),
          manifest.nonce,
        ],
        {
          cwd: handle.directory,
          detached: true,
          env: { PATH: manifest.config.path },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      let exited = false;
      let ready = false;
      let anchorFailed = false;
      let closed = false;
      anchor.on('close', () => {
        closed = true;
      });
      anchor.on('error', () => {
        anchorFailed = true;
      });
      anchor.stdout?.on('data', (data: Buffer) =>
        captured.accept('stdout', data),
      );
      anchor.stderr?.on('data', (data: Buffer) =>
        captured.accept('stderr', data),
      );
      anchor.on('message', (data: unknown) => {
        const event = v.safeParse(
          v.variant('kind', [
            v.strictObject({ kind: v.literal('ready') }),
            v.strictObject({ kind: v.literal('error') }),
            v.strictObject({ kind: v.literal('cancelled') }),
            v.strictObject({
              kind: v.literal('exit'),
              code: v.nullable(v.pipe(v.number(), v.integer())),
              signal: v.nullable(v.string()),
            }),
          ]),
          data,
        );
        if (!event.success) {
          anchorFailed = true;
          return;
        }
        if (event.output.kind === 'ready') ready = true;
        if (event.output.kind === 'cancelled') {
          receipt.reason = 'cancelled';
          exited = true;
        }
        if (event.output.kind === 'error') {
          receipt.reason = 'provider-spawn-failed';
          exited = true;
        }
        if (event.output.kind === 'exit') {
          receipt.exitCode = event.output.code;
          receipt.signal = event.output.signal;
          exited = true;
        }
      });
      const starting = Date.now();
      while (!ready && !anchorFailed && !closed && Date.now() - starting < 5000)
        await delay(20);
      if (!ready || !anchor.pid) throw new Error('Group startup uncertain');
      receipt.group = await identify(anchor.pid, manifest.nonce);
      if (receipt.group.pid !== receipt.group.pgid)
        throw new Error('Invalid process group');
      // Persist authenticated group before permitting a writer to start.
      await persist();
      anchor.send({ manifest, handle }, (error) => {
        if (error) anchorFailed = true;
      });
      const startedAt = Date.now();
      let lastHeartbeat = startedAt;
      while (!exited) {
        if (await cancelled()) {
          receipt.reason = 'cancelled';
          break;
        }
        if (captured.failure) {
          receipt.reason = captured.failure;
          break;
        }
        if (Date.now() - startedAt >= manifest.config.wallTimeMs) {
          receipt.reason = 'wall-time-limit';
          break;
        }
        if (anchorFailed || closed) throw new Error('Group ownership lost');
        if (Date.now() - lastHeartbeat > 500) {
          receipt.outputBytes = captured.bytes;
          receipt.sessionId = captured.events.sessionId;
          await persist();
          lastHeartbeat = Date.now();
        }
        await delay(50);
      }
      receipt.state = 'cancelling';
      await persist();
      await signalOwnedGroup(receipt.group, 'SIGTERM');
      // A live owner must remain inspectable throughout the shutdown grace.
      const graceEndsAt = Date.now() + manifest.config.termGraceMs;
      while (Date.now() < graceEndsAt) {
        await delay(Math.min(500, graceEndsAt - Date.now()));
        await persist();
      }
      // Anchor survives TERM, retaining proof of ownership for the KILL.
      await signalOwnedGroup(receipt.group, 'SIGKILL');
      const killedAt = Date.now();
      lastHeartbeat = killedAt;
      while (
        (!closed || !(await groupAbsent(receipt.group))) &&
        Date.now() - killedAt < 5000
      ) {
        if (Date.now() - lastHeartbeat >= 500) {
          await persist();
          lastHeartbeat = Date.now();
        }
        await delay(25);
      }
      if (!closed || !(await groupAbsent(receipt.group)))
        throw new Error('Writer termination could not be proven');
      receipt.noWriter = true;
    }
  } catch {
    receipt.state = 'needs-reconcile';
    receipt.reason = spawnAttempted
      ? 'supervisor-ownership-or-io-uncertain'
      : 'host-preflight-failed';
    receipt.noWriter = !spawnAttempted;
  }
  if (output) {
    output.finish();
    receipt.sessionId = output.events.sessionId;
    receipt.terminal = output.events.terminal;
    receipt.outputBytes = output.bytes;
    receipt.reason ??= output.failure;
  }
  if (receipt.noWriter) {
    receipt.state = 'finished';
    if (await cancelled()) receipt.reason = 'cancelled';
    receipt.reason ??=
      receipt.exitCode !== 0
        ? 'provider-exit-failed'
        : receipt.terminal !== 'completed'
          ? 'provider-terminal-missing-or-failed'
          : null;
  }
  if (receipt.noWriter) {
    receipt.authCleanup = await removeAttemptCredentials(handle.directory);
    if (receipt.authCleanup === 'failed')
      receipt.reason = 'credential-cleanup-failed';
  }
  await persist();
  await writeSigned(
    join(handle.directory, 'receipt.json'),
    handle.attemptToken,
    v.parse(receiptSchema, receipt),
  );
  process.exit(receipt.noWriter ? 0 : 1);
}
