import { join } from 'node:path';
import * as v from 'valibot';
import { receiptSchema, type LocalInspection } from './host-contract.ts';
import { loadLocalManifest, inspectLocalAttempt } from './local-host.ts';
import { readBounded, readSigned, writeSigned, message } from './host-io.ts';
import { removeAdapterCredentials } from './adapter-host.ts';
import { localCancellationRequested } from './host-launch-gate.ts';
import { processTable } from './host-process.ts';

// Explicit recovery only. Never starts compute or signals a recovered PID.
// A missing authenticated group identity remains quarantined indefinitely.
export async function reconcileLocalAttempt(
  input: unknown,
): Promise<LocalInspection> {
  const current = await inspectLocalAttempt(input);
  if (current.state !== 'needs-reconcile') return current;
  try {
    const { handle, manifest } = await loadLocalManifest(input);
    await readBounded(join(handle.directory, 'launch.claim'), 1);
    let value: unknown;
    try {
      value = await readSigned(
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
      value = await readSigned(
        join(handle.directory, 'heartbeat.json'),
        handle.attemptToken,
      );
    }
    const receipt = v.parse(receiptSchema, value);
    if (
      receipt.nonce !== manifest.nonce ||
      receipt.attemptId !== manifest.attemptId ||
      !receipt.group ||
      receipt.group.pid !== receipt.group.pgid ||
      !receipt.group.command.split(/\s+/).includes(manifest.nonce) ||
      !receipt.supervisor.command.split(/\s+/).includes(manifest.nonce)
    )
      throw new Error(
        'Authenticated launch/group evidence missing; operator investigation required',
      );
    const rows = await processTable();
    if (
      rows.some(
        (row) =>
          !row.zombie &&
          (row.pid === receipt.supervisor.pid ||
            row.pgid === receipt.group?.pgid),
      )
    )
      throw new Error(
        'Supervisor or owned group still present; retain ownership',
      );
    const cancelled = localCancellationRequested(handle, manifest.nonce);
    const authCleanup = await removeAdapterCredentials(manifest);
    const recovered = v.parse(receiptSchema, {
      ...receipt,
      at: Date.now(),
      state: 'finished',
      noWriter: true,
      reason:
        authCleanup === 'failed'
          ? 'credential-cleanup-failed'
          : cancelled
            ? 'cancelled'
            : 'supervisor-lost',
      authCleanup,
      exitCode: null,
      signal: null,
    });
    await writeSigned(
      join(handle.directory, 'receipt.json'),
      handle.attemptToken,
      recovered,
    );
    return inspectLocalAttempt(handle);
  } catch (error) {
    return { state: 'needs-reconcile', reason: message(error) };
  }
}
