import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import * as v from 'valibot';
import {
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

/** Exclusive across CLI/server processes. Existing claims are never stolen,
 * including partial admissions and claims whose holder may have died. */
export async function claimTrialRecovery(directory: string) {
  const handle = await trialHandle(directory);
  const claim = join(directory, 'recovery.lock');
  try {
    await mkdir(claim, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      return null;
    throw error;
  }
  const nonce = randomUUID();
  await writeSigned(join(claim, 'owner.json'), handle.attemptToken, { nonce });
  return {
    release: async () => {
      await privateDirectory(claim);
      const proof = v.parse(
        v.strictObject({ nonce: v.pipe(v.string(), v.uuid()) }),
        await readSigned(join(claim, 'owner.json'), handle.attemptToken),
      );
      if (proof.nonce !== nonce)
        throw new Error('Recovery claim ownership changed');
      await rm(claim, { recursive: true });
    },
  };
}
