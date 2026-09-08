import { randomUUID } from 'node:crypto';
import { mkdir, rm, open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { openDb, isSqliteBusy } from '../../lib/sqlite';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  artifactHash,
  privateDirectory,
  readBytesBounded,
  readSigned,
  writeSigned,
} from '../coding-runs';
import { candidateCheckInputSchema } from '../factory-delivery';

const controllerSchema = v.strictObject({
  host: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  pid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  start: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});
type TrialController = v.InferOutput<typeof controllerSchema>;
const exec = promisify(execFile);
async function observeController(pid: number): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Controller observation unsupported');
  let stdout: string;
  try {
    ({ stdout } = await exec(
      '/bin/ps',
      ['-p', String(pid), '-o', 'pid=,lstart='],
      {
        timeout: 3000,
        maxBuffer: 4096,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
      },
    ));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 1 &&
      'stdout' in error &&
      error.stdout === '' &&
      'stderr' in error &&
      error.stderr === ''
    )
      return null;
    throw error;
  }
  const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s*$/.exec(
    stdout,
  );
  if (!match || Number(match[1]) !== pid)
    throw new Error('Controller observation invalid');
  return match[2].replace(/\s+/g, ' ');
}
export async function captureTrialController(
  pid = process.pid,
): Promise<TrialController> {
  const start = await observeController(pid);
  if (!start) throw new Error('Controller is not alive');
  return v.parse(controllerSchema, { host: hostname(), pid, start });
}
/** Read-only identity check. No PID is ever signalled, including reused PIDs. */
export async function trialControllerState(
  controller: TrialController | undefined,
): Promise<'alive' | 'dead' | 'unknown'> {
  if (!controller || controller.host !== hostname()) return 'unknown';
  try {
    const start = await observeController(controller.pid);
    return start === controller.start ? 'alive' : 'dead';
  } catch {
    return 'unknown';
  }
}
export async function trialCancellationRequested(directory: string) {
  const handle = await trialHandle(directory);
  try {
    v.parse(
      v.strictObject({ cancelled: v.literal(true) }),
      await readSigned(
        join(directory, 'controller-cancel.json'),
        handle.attemptToken,
      ),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
export async function requestTrialCancellation(directory: string) {
  const handle = await trialHandle(directory);
  await writeSigned(
    join(directory, 'controller-cancel.json'),
    handle.attemptToken,
    { cancelled: true },
  );
}
export const trialOwnershipSchema = v.strictObject({
  controller: v.optional(controllerSchema),
  controllerTaskId: v.optional(v.pipe(v.string(), v.uuid())),
  runId: v.pipe(v.string(), v.uuid()),
  repoId: v.string(),
  source: v.string(),
  root: v.string(),
  ref: v.string(),
  baseSha: v.nullable(v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/))),
  // Git operations have no durable death receipt. Interrupted creation is retained.
  gitSettled: v.boolean(),
  jobs: v.pipe(
    v.array(
      v.strictObject({ jobId: v.string(), request: candidateCheckInputSchema }),
    ),
    v.maxLength(32),
  ),
});
export type TrialOwnership = v.InferOutput<typeof trialOwnershipSchema>;
export async function trialHandle(directory: string) {
  await privateDirectory(join(directory, '..'));
  await privateDirectory(directory);
  const attemptToken = v.parse(
    v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    (await readBytesBounded(join(directory, 'token'), 64)).toString('utf8'),
  );
  return { directory, attemptToken };
}
export async function readTrialOwnership(directory: string) {
  const handle = await trialHandle(directory);
  return v.parse(
    trialOwnershipSchema,
    await readSigned(join(directory, 'ownership.json'), handle.attemptToken),
  );
}
export async function saveTrialOwnership(
  directory: string,
  owner: TrialOwnership,
) {
  const handle = await trialHandle(directory);
  await writeSigned(
    join(directory, 'ownership.json'),
    handle.attemptToken,
    v.parse(trialOwnershipSchema, owner),
  );
}

const taskSettlementSchema = v.strictObject({
  runId: v.pipe(v.string(), v.uuid()),
  repoId: v.string(),
  controller: controllerSchema,
  controllerTaskId: v.pipe(v.string(), v.uuid()),
  state: v.literal('settled'),
});
const settledLocalTasks = new Map<string, string>();
function taskSettlement(owner: TrialOwnership) {
  if (!owner.controller || !owner.controllerTaskId) return null;
  return v.parse(taskSettlementSchema, {
    runId: owner.runId,
    repoId: owner.repoId,
    controller: owner.controller,
    controllerTaskId: owner.controllerTaskId,
    state: 'settled',
  });
}
/** Called only after the execution/cleanup promise settles, never on map loss.
 * Keep a bounded local proof if the same I/O failure also prevents the marker. */
export async function markTrialControllerTaskSettled(
  directory: string,
  owner: TrialOwnership,
) {
  const proof = taskSettlement(owner);
  if (!proof) throw new Error('Controller task identity missing');
  settledLocalTasks.set(directory, JSON.stringify(proof));
  while (settledLocalTasks.size > 256)
    settledLocalTasks.delete(settledLocalTasks.keys().next().value!);
  const handle = await trialHandle(directory);
  await writeSigned(
    join(directory, 'controller-task-settled.json'),
    handle.attemptToken,
    proof,
  );
}
export async function trialControllerTaskSettled(
  directory: string,
  owner: TrialOwnership,
) {
  const expected = taskSettlement(owner);
  if (!expected) return false;
  if (settledLocalTasks.get(directory) === JSON.stringify(expected))
    return true;
  try {
    const handle = await trialHandle(directory);
    const proof = v.parse(
      taskSettlementSchema,
      await readSigned(
        join(directory, 'controller-task-settled.json'),
        handle.attemptToken,
      ),
    );
    return JSON.stringify(proof) === JSON.stringify(expected);
  } catch {
    return false;
  } // Unreadable/partial/mismatched state never proves settlement.
}

const recoveryClaimSchema = v.strictObject({
  nonce: v.pipe(v.string(), v.uuid()),
  controller: controllerSchema,
});
/** SQLite supplies the cross-process exclusion that mkdir alone cannot safely
 * reclaim after death. Its OS lock disappears when the holder exits; the
 * stable private database file is never deleted/replaced during run lifetime. */
async function recoveryGuard(directory: string) {
  const path = join(directory, 'recovery-guard.sqlite');
  try {
    const file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await file.close();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new Error('Unsafe recovery guard');
  const db = openDb(path, { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
    return () => db.close();
  } catch (error) {
    db.close();
    if (isSqliteBusy(error)) return null;
    throw error;
  }
}
/** A dead claimant can be continued only with authenticated completed cleanup
 * and exclusive OS-backed exclusion. Missing/partial/unproven claims remain. */
export async function claimTrialRecovery(directory: string) {
  const handle = await trialHandle(directory);
  const close = await recoveryGuard(directory);
  if (!close) return null;
  const claim = join(directory, 'recovery.lock');
  try {
    let created = false;
    try {
      await mkdir(claim, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
    }
    await privateDirectory(claim);
    const readClaim = async () =>
      v.parse(
        recoveryClaimSchema,
        await readSigned(join(claim, 'owner.json'), handle.attemptToken),
      );
    if (!created) {
      try {
        const prior = await readClaim();
        if ((await trialControllerState(prior.controller)) !== 'dead') {
          close();
          return null;
        }
        if (JSON.stringify(await readClaim()) !== JSON.stringify(prior)) {
          close();
          return null;
        }
        const owner = await readTrialOwnership(directory);
        if (!(await trialCleanupRecorded(directory, owner))) {
          close();
          return null;
        }
      } catch {
        close();
        return null;
      }
    }
    const proof = {
      nonce: randomUUID(),
      controller: await captureTrialController(),
    };
    await writeSigned(join(claim, 'owner.json'), handle.attemptToken, proof);
    return {
      close,
      release: async () => {
        try {
          await privateDirectory(claim);
          if (JSON.stringify(await readClaim()) !== JSON.stringify(proof))
            throw new Error('Recovery claim ownership changed');
          await rm(claim, { recursive: true });
        } finally {
          close();
        }
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}

const cleanupReceiptSchema = v.strictObject({
  runId: v.pipe(v.string(), v.uuid()),
  repoId: v.string(),
  ownershipHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
function cleanupOwnershipHash(owner: TrialOwnership) {
  // Controller identity can change only in explicit recovery observations;
  // resource identity and the complete set of settled jobs remain bound.
  const { controller: _controller, ...resources } = v.parse(
    trialOwnershipSchema,
    owner,
  );
  return artifactHash(JSON.stringify(resources));
}
export async function recordTrialCleanup(
  directory: string,
  owner: TrialOwnership,
) {
  if (!owner.gitSettled) throw new Error('Cleanup settlement unproven');
  const handle = await trialHandle(directory);
  await writeSigned(
    join(directory, 'cleanup-receipt.json'),
    handle.attemptToken,
    {
      runId: owner.runId,
      repoId: owner.repoId,
      ownershipHash: cleanupOwnershipHash(owner),
    },
  );
}
export async function trialCleanupRecorded(
  directory: string,
  owner: TrialOwnership,
) {
  const handle = await trialHandle(directory);
  let receipt: v.InferOutput<typeof cleanupReceiptSchema>;
  try {
    receipt = v.parse(
      cleanupReceiptSchema,
      await readSigned(
        join(directory, 'cleanup-receipt.json'),
        handle.attemptToken,
      ),
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
  if (
    !owner.gitSettled ||
    receipt.runId !== owner.runId ||
    receipt.repoId !== owner.repoId ||
    receipt.ownershipHash !== cleanupOwnershipHash(owner)
  )
    throw new Error('Cleanup receipt ownership mismatch');
  return true;
}
