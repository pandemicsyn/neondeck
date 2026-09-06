import { createHash } from 'node:crypto';
import { link, open } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import * as v from 'valibot';
import {
  receiptSchema,
  type LocalAttemptHandle,
  type LocalManifest,
} from './host-contract.ts';
import {
  privateDirectory,
  readBytesBounded,
  readSigned,
  writeSigned,
} from './host-io.ts';

const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const gitSha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const resultSchema = v.strictObject({
  receipt: receiptSchema,
  baseSha: gitSha,
  headSha: gitSha,
  statusRef: v.string(),
  diffRef: v.string(),
  untrackedRef: v.string(),
  includesUntracked: v.literal(true),
});
const candidateSchema = v.strictObject({
  version: v.literal(1),
  attemptId: v.string(),
  nonce: v.string(),
  result: resultSchema,
  hashes: v.strictObject({ status: sha, diff: sha, untracked: sha }),
});
export type LocalCandidate = v.InferOutput<typeof resultSchema>;
export function artifactHash(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

export async function readRetainedCandidate(
  handle: LocalAttemptHandle,
  manifest: LocalManifest,
): Promise<LocalCandidate | null> {
  let value: unknown;
  try {
    value = await readSigned(
      join(handle.directory, 'candidate.json'),
      handle.attemptToken,
    );
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
  const candidate = v.parse(candidateSchema, value);
  const { result, hashes } = candidate;
  if (
    candidate.attemptId !== manifest.attemptId ||
    candidate.nonce !== manifest.nonce ||
    result.baseSha !== manifest.ownedWorktree.baseSha ||
    result.receipt.attemptId !== manifest.attemptId ||
    result.receipt.nonce !== manifest.nonce
  )
    throw new Error('Retained candidate identity mismatch');
  const directory = dirname(result.statusRef);
  if (
    dirname(directory) !== handle.directory ||
    !/^candidate-[A-Za-z0-9]{6}$/.test(basename(directory)) ||
    result.statusRef !== join(directory, 'status.txt') ||
    result.diffRef !== join(directory, 'changes.diff') ||
    result.untrackedRef !== join(directory, 'untracked.json')
  )
    throw new Error('Retained candidate artifact path mismatch');
  await privateDirectory(directory);
  const actual = await Promise.all(
    [result.statusRef, result.diffRef, result.untrackedRef].map(async (path) =>
      artifactHash(await readBytesBounded(path, 16 * 1024 * 1024)),
    ),
  );
  if (
    actual[0] !== hashes.status ||
    actual[1] !== hashes.diff ||
    actual[2] !== hashes.untracked
  )
    throw new Error('Retained candidate artifact integrity failed');
  return result;
}

export async function publishCandidate(
  handle: LocalAttemptHandle,
  manifest: LocalManifest,
  result: LocalCandidate,
  hashes: v.InferOutput<typeof candidateSchema>['hashes'],
) {
  const sealed = join(dirname(result.statusRef), 'sealed.json');
  await writeSigned(
    sealed,
    handle.attemptToken,
    v.parse(candidateSchema, {
      version: 1,
      attemptId: manifest.attemptId,
      nonce: manifest.nonce,
      result,
      hashes,
    }),
  );
  // Atomic exclusive publication. Every collector has a fresh private directory;
  // no partial retry or competing publisher ever rewrites retained evidence.
  try {
    await link(sealed, join(handle.directory, 'candidate.json'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
  }
  const parent = await open(handle.directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  const retained = await readRetainedCandidate(handle, manifest);
  if (!retained) throw new Error('Candidate publication missing');
  return retained;
}
