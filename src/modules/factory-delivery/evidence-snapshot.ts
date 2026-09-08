import { spawn } from 'node:child_process';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import * as v from 'valibot';
import { inside } from '../coding-runs';
import { CandidateEvidenceError } from './evidence-errors';

const blobShaSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));

export const candidateFileLimit = 2 * 1024 * 1024;
const scanLimit = 1024 * 1024 * 1024;
export type SnapshotBudget = { scanned: number; changed: number };
export type SnapshotGit = (
  args: string[],
  input?: string | Buffer,
) => Promise<string>;

function sameFile(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
async function checkPath(root: string, path: string) {
  if (!inside(root, path) || (await realpath(dirname(path))) !== dirname(path))
    throw new CandidateEvidenceError('path-invalid');
}

// Git consumes an already-open regular file descriptor: no pathname re-open,
// filters, stat-cache shortcut, or full unchanged blob buffered in JavaScript.
function hashDescriptor(root: string, fd: number): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(
      '/usr/bin/git',
      ['-c', 'core.fsmonitor=false', 'hash-object', '--stdin', '--no-filters'],
      {
        cwd: root,
        stdio: [fd, 'pipe', 'ignore'],
        timeout: 10_000,
        killSignal: 'SIGKILL',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          LC_ALL: 'C',
        },
      },
    );
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('ascii');
      if (output.length > 128) child.kill('SIGKILL');
    });
    child.on('error', () =>
      reject(new CandidateEvidenceError('capture-failed')),
    );
    child.on('close', (code) => {
      const parsed = v.safeParse(blobShaSchema, output.trim());
      if (code !== 0 || !parsed.success)
        reject(new CandidateEvidenceError('capture-failed'));
      else accept(parsed.output);
    });
  });
}

export async function snapshotEntry(
  root: string,
  name: string,
  existingBlob: string | undefined,
  budget: SnapshotBudget,
  git: SnapshotGit,
): Promise<{ mode: string; blob: string } | null> {
  const path = resolve(root, name);
  let before;
  try {
    await checkPath(root, path);
    before = await lstat(path, { bigint: true });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return null;
    throw error;
  }
  // A tracked file replaced by a directory is a deletion; descendants are enumerated separately.
  if (before.isDirectory()) return null;
  const mode = before.isSymbolicLink()
    ? '120000'
    : before.mode & 0o111n
      ? '100755'
      : '100644';
  let bytes: Buffer;
  let rawHash: string | undefined;
  if (before.isSymbolicLink()) {
    bytes = await readlink(path, { encoding: 'buffer' });
  } else if (before.isFile()) {
    const size = Number(before.size);
    // Large new files cannot qualify for reuse; reject before scanning them.
    if (!existingBlob && size > candidateFileLimit)
      throw new CandidateEvidenceError('file-too-large', {
        path: name,
        observedBytes: Number(before.size),
        limitBytes: candidateFileLimit,
      });
    budget.scanned += size;
    if (budget.scanned > scanLimit)
      throw new CandidateEvidenceError('scan-budget-exceeded', {
        observedBytes: budget.scanned,
        limitBytes: scanLimit,
      });
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!sameFile(before, await file.stat({ bigint: true })))
        throw new CandidateEvidenceError('stale');
      rawHash = await hashDescriptor(root, file.fd);
      if (!sameFile(before, await file.stat({ bigint: true })))
        throw new CandidateEvidenceError('stale');
      if (rawHash === existingBlob) {
        await checkPath(root, path);
        if (!sameFile(before, await lstat(path, { bigint: true })))
          throw new CandidateEvidenceError('stale');
        return { mode, blob: rawHash };
      }
      if (size > candidateFileLimit)
        throw new CandidateEvidenceError('file-too-large', {
          path: name,
          observedBytes: Number(before.size),
          limitBytes: candidateFileLimit,
        });
      bytes = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      bytes = bytes.subarray(0, offset);
      if (
        !sameFile(before, await file.stat({ bigint: true })) ||
        bytes.length !== size
      )
        throw new CandidateEvidenceError('stale');
    } finally {
      await file.close();
    }
  } else throw new CandidateEvidenceError('unsupported-file');
  if (bytes.length > candidateFileLimit)
    throw new CandidateEvidenceError('file-too-large', {
      path: name,
      observedBytes: Number(before.size),
      limitBytes: candidateFileLimit,
    });
  budget.changed += bytes.length;
  if (budget.changed > 32 * 1024 * 1024)
    throw new CandidateEvidenceError('total-too-large', {
      observedBytes: budget.changed,
      limitBytes: 32 * 1024 * 1024,
    });
  const blob = (
    await git(['hash-object', '-w', '--stdin', '--no-filters'], bytes)
  ).trim();
  if (!v.safeParse(blobShaSchema, blob).success)
    throw new CandidateEvidenceError('capture-failed');
  if (rawHash && blob !== rawHash) throw new CandidateEvidenceError('stale');
  await checkPath(root, path);
  if (!sameFile(before, await lstat(path, { bigint: true })))
    throw new CandidateEvidenceError('stale');
  return { mode, blob };
}
