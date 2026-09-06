import { lstat, mkdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { codingRunRecordSchema } from '../../../shared/coding-runs';
import type { RuntimePaths } from '../../runtime-home';
import { loadLocalManifest } from '../coding-runs';
import { readRetainedCandidate, artifactHash } from '../coding-runs';
import { readBytesBounded } from '../coding-runs';
import { hostGit, inside, verifyOwnedWorktree } from '../coding-runs';
import { readWorktreeRecord } from '../worktrees';
import { codingHandle } from '../factory';

const entrySchema = v.strictObject({
  path: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(4096),
    v.check(
      (path) =>
        !path.startsWith('/') &&
        !path.includes('\\') &&
        !path.includes('\0') &&
        path
          .split('/')
          .every(
            (part) =>
              part !== '' &&
              part !== '.' &&
              part !== '..' &&
              part.toLowerCase() !== '.git',
          ),
    ),
  ),
  kind: v.picklist(['file', 'symlink']),
  mode: v.picklist(['100644', '100755', '120000']),
  bytes: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(0),
    v.maxValue(1024 * 1024),
  ),
  sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
  contentBase64: v.pipe(v.string(), v.maxLength(2 * 1024 * 1024)),
});

/** Read sealed evidence and reject a candidate whose live content/ownership changed. */
export async function readRepairSeed(input: unknown, paths: RuntimePaths) {
  const run = v.parse(codingRunRecordSchema, input);
  if (
    run.status !== 'candidate' ||
    !run.candidate ||
    !run.workspace ||
    !run.deadProof
  )
    throw new Error('Repair requires retained candidate evidence');
  const { handle, manifest } = await loadLocalManifest(
    codingHandle(run, paths),
  );
  const worktree = readWorktreeRecord(run.workspace.worktreeId, paths);
  if (
    worktree.owningWorkflowRunId !== run.runId ||
    worktree.adopted ||
    worktree.localPath !== manifest.ownedWorktree.root
  )
    throw new Error('Prior candidate ownership changed');
  await verifyOwnedWorktree(manifest.ownedWorktree, false);
  const retained = await readRetainedCandidate(handle, manifest);
  if (
    !retained ||
    !retained.receipt.noWriter ||
    retained.statusRef !== run.candidate.statusRef ||
    retained.diffRef !== run.candidate.diffRef ||
    retained.headSha !== run.candidate.headSha
  )
    throw new Error('Prior candidate evidence identity changed');
  const diff = await readBytesBounded(retained.diffRef, 4 * 1024 * 1024);
  const status = await readBytesBounded(retained.statusRef, 4 * 1024 * 1024);
  const entries = v.parse(
    v.pipe(v.array(entrySchema), v.maxLength(10000)),
    JSON.parse(
      (
        await readBytesBounded(retained.untrackedRef, 16 * 1024 * 1024)
      ).toString(),
    ),
  );
  if (
    new Set(entries.map((e) => e.path)).size !== entries.length ||
    entries.reduce((sum, e) => sum + e.bytes, 0) > 4 * 1024 * 1024
  )
    throw new Error('Invalid untracked evidence budget');
  const root = manifest.ownedWorktree.root;
  if (
    (await hostGit(root, ['rev-parse', 'HEAD'])).trim() !== retained.headSha ||
    (await hostGit(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ])) !== status.toString() ||
    (await hostGit(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--binary',
      retained.baseSha,
      '--',
    ])) !== diff.toString()
  )
    throw new Error('Stale repair candidate');
  for (const entry of entries) {
    const path = resolve(root, entry.path);
    if (!inside(root, path)) throw new Error('Candidate path escaped');
    await assertParents(root, entry.path);
    const stat = await lstat(path);
    if (
      entry.kind === 'symlink'
        ? !stat.isSymbolicLink()
        : !stat.isFile() || stat.isSymbolicLink()
    )
      throw new Error('Candidate file kind changed');
    const mode = stat.isSymbolicLink()
      ? '120000'
      : stat.mode & 0o111
        ? '100755'
        : '100644';
    if (mode !== entry.mode)
      throw new Error('Stale untracked repair candidate mode');
    const bytes =
      entry.kind === 'symlink'
        ? Buffer.from(await readlink(path))
        : await readBytesBounded(path, 1024 * 1024);
    const retainedBytes = Buffer.from(entry.contentBase64, 'base64');
    if (
      retainedBytes.toString('base64') !== entry.contentBase64 ||
      retainedBytes.length !== entry.bytes ||
      artifactHash(retainedBytes) !== entry.sha256 ||
      artifactHash(bytes) !== entry.sha256
    )
      throw new Error('Stale untracked repair candidate');
  }
  return { diff, diffRef: retained.diffRef, entries };
}

async function assertParents(root: string, name: string) {
  let current = root;
  for (const part of name.split('/').slice(0, -1)) {
    current = join(current, part);
    const stat = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error('Candidate parent is not a directory');
  }
}

export async function seedRepairWorkspace(
  input: unknown,
  destination: string,
  paths: RuntimePaths,
) {
  const seed = await readRepairSeed(input, paths);
  const root = v.parse(v.pipe(v.string(), v.minLength(1)), destination);
  if (seed.diff.length) {
    await hostGit(root, ['apply', '--check', '--binary', seed.diffRef]);
    await hostGit(root, ['apply', '--binary', seed.diffRef]);
  }
  for (const entry of seed.entries) {
    await assertParents(root, entry.path);
    const target = resolve(root, entry.path);
    if (!inside(root, target)) throw new Error('Repair path escaped');
    await mkdir(dirname(target), { recursive: true });
    const content = Buffer.from(entry.contentBase64, 'base64');
    if (entry.kind === 'symlink') await symlink(content.toString(), target);
    else {
      const mode = entry.mode === '100755' ? 0o755 : 0o644;
      await writeFile(target, content, { flag: 'wx', mode });
    }
  }
  // Source evidence is immutable and source content must remain current throughout.
  await readRepairSeed(input, paths);
}
