import { createHash } from 'node:crypto';
import { lstat, readlink, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as v from 'valibot';
import { loadLocalManifest, inspectLocalAttempt } from './local-host.ts';
import { hostGit, inside, verifyOwnedWorktree } from './host-workspace.ts';
import { atomicWrite, readBytesBounded } from './host-io.ts';

import {
  readRetainedCandidate,
  publishCandidate,
  artifactHash,
  type LocalCandidate,
} from './host-candidate.ts';

// Caller retains all global/workspace ownership until this returns. Collection is
// bounded, never runs Git filters/external diff drivers, and never deletes files.
export async function collectLocalAttempt(input: unknown) {
  const { handle, manifest } = await loadLocalManifest(input);
  const inspected = await inspectLocalAttempt(handle);
  if (inspected.state !== 'finished' || !inspected.receipt.noWriter)
    throw new Error('Cannot collect while writer state is uncertain');
  const retained = await readRetainedCandidate(handle, manifest);
  if (retained) return retained;
  await verifyOwnedWorktree(manifest.ownedWorktree, false);
  const cwd = manifest.ownedWorktree.root;
  const headSha = v.parse(
    v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
    (await hostGit(cwd, ['rev-parse', 'HEAD'])).trim(),
  );
  const status = await hostGit(cwd, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const diff = await hostGit(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    manifest.ownedWorktree.baseSha,
    '--',
  ]);
  const names = (
    await hostGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  if (names.length > 10_000)
    throw new Error(
      'Untracked evidence exceeds file limit; retained for reconciliation',
    );
  let total = 0;
  const untracked: {
    path: string;
    kind: 'file' | 'symlink';
    bytes: number;
    sha256: string;
    contentBase64: string;
  }[] = [];
  for (const name of names) {
    const path = resolve(cwd, name);
    if (!inside(cwd, path)) throw new Error('Untracked path escaped worktree');
    const info = await lstat(path);
    // A symlink is evidence itself; never follow a link into private files.
    const content = info.isSymbolicLink()
      ? Buffer.from(await readlink(path))
      : info.isFile()
        ? await readBytesBounded(path, 1024 * 1024)
        : null;
    if (!content) throw new Error('Unsupported untracked file kind');
    total += content.length;
    if (total > 4 * 1024 * 1024)
      throw new Error(
        'Untracked evidence exceeds byte limit; retained for reconciliation',
      );
    untracked.push({
      path: name,
      kind: info.isSymbolicLink() ? 'symlink' : 'file',
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      contentBase64: content.toString('base64'),
    });
  }
  const capture = await mkdtemp(join(handle.directory, 'candidate-'));
  const statusRef = join(capture, 'status.txt');
  const diffRef = join(capture, 'changes.diff');
  const untrackedRef = join(capture, 'untracked.json');
  const untrackedJson = JSON.stringify(untracked);
  await atomicWrite(statusRef, status);
  await atomicWrite(diffRef, diff);
  await atomicWrite(untrackedRef, untrackedJson);
  // Revalidate bytes, not only filenames/status: an edit can preserve porcelain.
  if (
    (await hostGit(cwd, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      manifest.ownedWorktree.baseSha,
      '--',
    ])) !== diff
  )
    throw new Error('Candidate diff changed while collecting');
  for (const entry of untracked) {
    const path = resolve(cwd, entry.path);
    const current =
      entry.kind === 'symlink'
        ? Buffer.from(await readlink(path))
        : await readBytesBounded(path, 1024 * 1024);
    if (createHash('sha256').update(current).digest('hex') !== entry.sha256)
      throw new Error('Untracked candidate bytes changed while collecting');
  }
  const after = await inspectLocalAttempt(handle);
  if (
    after.state !== 'finished' ||
    !after.receipt.noWriter ||
    (await hostGit(cwd, ['rev-parse', 'HEAD'])).trim() !== headSha ||
    (await hostGit(cwd, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ])) !== status
  )
    throw new Error('Candidate changed while collecting; retain ownership');
  const result: LocalCandidate = {
    receipt: inspected.receipt,
    baseSha: manifest.ownedWorktree.baseSha,
    headSha,
    statusRef,
    diffRef,
    untrackedRef,
    includesUntracked: true,
  };
  return publishCandidate(handle, manifest, result, {
    status: artifactHash(status),
    diff: artifactHash(diff),
    untracked: artifactHash(untrackedJson),
  });
}
