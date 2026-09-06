import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import {
  handleSchema,
  cancelSchema,
  manifestSchema,
  type LocalAttemptHandle,
} from './host-contract.ts';
import { decodeSigned, signedEnvelope } from './host-io.ts';

const intentSchema = v.strictObject({
  version: v.literal(1),
  directory: v.string(),
  requestedAt: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function ensureParent(handle: LocalAttemptHandle) {
  const parent = dirname(handle.directory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const info = lstatSync(parent);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    realpathSync(parent) !== parent
  )
    throw new Error('Cancellation parent must be canonical, private and owned');
}
function syncParent(path: string) {
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function withLocalLaunchGate<T>(
  handle: LocalAttemptHandle,
  action: () => T,
): T {
  ensureParent(handle);
  const gate = `${handle.directory}.authorization-gate`;
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      mkdirSync(gate, { mode: 0o700 });
      break;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'EEXIST'
      ))
        throw error;
      if (Date.now() >= deadline)
        throw new Error(
          'Launch authorization gate is uncertain; retain ownership',
        );
      Atomics.wait(waitCell, 0, 0, 5);
    }
  }
  try {
    return action();
  } finally {
    rmdirSync(gate);
  }
}
function readSignedSync(path: string, token: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 64 * 1024)
      throw new Error('Invalid cancellation artifact');
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 64 * 1024) throw new Error('Oversized cancellation artifact');
    return decodeSigned(bytes.subarray(0, size).toString('utf8'), token);
  } finally {
    closeSync(fd);
  }
}
export function localCancellationRequested(
  handle: LocalAttemptHandle,
  nonce: string,
): boolean {
  try {
    const intent = v.parse(
      intentSchema,
      readSignedSync(`${handle.directory}.cancel.json`, handle.attemptToken),
    );
    if (intent.directory !== handle.directory)
      throw new Error('Cancellation directory mismatch');
    return true;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  // Preserve recovery of pre-gate attempts created by the preceding host revision.
  try {
    const intent = v.parse(
      cancelSchema,
      readSignedSync(
        join(handle.directory, 'cancel.json'),
        handle.attemptToken,
      ),
    );
    if (intent.nonce !== nonce)
      throw new Error('Cancellation identity mismatch');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
/** Synchronous durable invalidation, valid even before prepare creates the attempt. */
export function publishLocalCancellation(input: LocalAttemptHandle): void {
  const handle = v.parse(handleSchema, input);
  withLocalLaunchGate(handle, () => {
    try {
      const manifest = v.parse(
        manifestSchema,
        readSignedSync(
          join(handle.directory, 'manifest.json'),
          handle.attemptToken,
        ),
      );
      if (manifest.directory !== handle.directory)
        throw new Error('Cancellation manifest mismatch');
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
    const path = `${handle.directory}.cancel.json`;
    const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(
        fd,
        signedEnvelope(handle.attemptToken, {
          version: 1,
          directory: handle.directory,
          requestedAt: Date.now(),
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    syncParent(path);
  });
}
