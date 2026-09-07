import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import * as v from 'valibot';
import {
  codingPinnedExecutableIdentitySchema,
  type CodingExecutableIdentity,
} from '../../../shared/coding-adapters.ts';

// Native coding CLIs may be large self-contained binaries. Read at most 512 MiB
// with a 1 MiB buffer and a finite hashing deadline, never load the binary whole.
export const maxCodingExecutableBytes = 512 * 1024 * 1024;
const hashDeadlineMs = 10_000;
export async function executableIdentity(executable: string) {
  const canonical = await realpath(executable);
  const file = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > maxCodingExecutableBytes)
      throw new Error('CLI executable is not a bounded regular file');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    const deadline = Date.now() + hashDeadlineMs;
    let offset = 0;
    while (offset < before.size) {
      if (Date.now() > deadline)
        throw new Error('CLI executable hashing timed out');
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error('CLI executable changed during hashing');
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await file.stat();
    const current = await stat(canonical);
    const stable = (observed: typeof before) =>
      observed.isFile() &&
      observed.dev === before.dev &&
      observed.ino === before.ino &&
      observed.size === before.size &&
      observed.mtimeMs === before.mtimeMs &&
      observed.ctimeMs === before.ctimeMs;
    if (
      Date.now() > deadline ||
      !stable(after) ||
      !stable(current) ||
      (await realpath(executable)) !== canonical
    )
      throw new Error('CLI executable changed during hashing');
    return v.parse(codingPinnedExecutableIdentitySchema, {
      canonical,
      device: before.dev,
      inode: before.ino,
      size: before.size,
      modified: before.mtimeMs,
      sha256: hash.digest('hex'),
    });
  } finally {
    await file.close();
  }
}
export async function assertExecutableIdentity(
  executable: string,
  expected: CodingExecutableIdentity,
) {
  // Do not upgrade a historical stat-only record by hashing the current path.
  if (!expected.sha256)
    throw new Error(
      'Legacy CLI identity lacks a content digest; new execution requires fresh authority',
    );
  const pinned = v.parse(codingPinnedExecutableIdentitySchema, expected);
  if (
    JSON.stringify(await executableIdentity(executable)) !==
    JSON.stringify(pinned)
  )
    throw new Error('Pinned CLI executable identity changed');
}
