import { execFile } from 'node:child_process';
import { mkdtemp, lstat, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { loadLocalManifest, inspectLocalAttempt } from '../coding-runs';
import { readRetainedCandidate, artifactHash } from '../coding-runs';
import { readBytesBounded } from '../coding-runs';
import { hostGit, inside, verifyOwnedWorktree } from '../coding-runs';
import type { LocalAttemptHandle } from '../coding-runs';

const sha = v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/));
const hash = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const candidateEvidenceSchema = v.strictObject({
  attemptId: v.string(),
  repoId: v.string(),
  worktreeId: v.string(),
  root: v.string(),
  baseSha: sha,
  headSha: sha,
  revision: sha,
  treeSha: sha,
  evidenceDigest: hash,
  statusHash: hash,
  diffHash: hash,
  untrackedHash: hash,
});
export type CandidateEvidence = v.InferOutput<typeof candidateEvidenceSchema>;
const untrackedSchema = v.array(
  v.strictObject({
    path: v.string(),
    kind: v.picklist(['file', 'symlink']),
    mode: v.picklist(['100644', '100755', '120000']),
    bytes: v.number(),
    sha256: hash,
    contentBase64: v.string(),
  }),
);

// Private alternate index; immutable objects only, no checkout/index/branch mutation or hooks/filters.
function objectGit(
  root: string,
  index: string,
  args: string[],
  input?: string | Buffer,
): Promise<string> {
  return new Promise((accept, reject) => {
    const child = execFile(
      '/usr/bin/git',
      ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        cwd: root,
        timeout: 10000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_INDEX_FILE: index,
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
      },
      (error, stdout) => (error ? reject(error) : accept(stdout)),
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}
async function fileBytes(root: string, name: string) {
  const path = resolve(root, name);
  if (!inside(root, path) || (await realpath(dirname(path))) !== dirname(path))
    throw new Error('Candidate path escaped or traversed symlink');
  const info = await lstat(path);
  const bytes = info.isSymbolicLink()
    ? Buffer.from(await readlink(path))
    : info.isFile()
      ? await readBytesBounded(path, 2 * 1024 * 1024)
      : null;
  if (!bytes) throw new Error('Unsupported candidate file');
  return {
    bytes,
    mode: info.isSymbolicLink()
      ? '120000'
      : info.mode & 0o111
        ? '100755'
        : '100644',
  };
}
export async function captureCandidateTree(root: string, directory: string) {
  await hostGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const names = [
    ...new Set(
      (
        await hostGit(root, [
          'ls-files',
          '--cached',
          '--others',
          '--exclude-standard',
          '-z',
        ])
      )
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  if (names.length > 10000) throw new Error('Candidate file budget exceeded');
  const temporary = await mkdtemp(join(directory, 'revision-'));
  const index = join(temporary, 'index');
  let total = 0;
  try {
    await objectGit(root, index, ['read-tree', '--empty']);
    const entries: string[] = [];
    for (const name of names) {
      let file;
      try {
        file = await fileBytes(root, name);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          continue;
        throw error;
      }
      total += file.bytes.length;
      if (total > 32 * 1024 * 1024)
        throw new Error('Candidate byte budget exceeded');
      const blob = v.parse(
        sha,
        (
          await objectGit(
            root,
            index,
            ['hash-object', '-w', '--stdin', '--no-filters'],
            file.bytes,
          )
        ).trim(),
      );
      entries.push(`${file.mode} ${blob}\t${name}\0`);
    }
    await objectGit(
      root,
      index,
      ['update-index', '-z', '--index-info'],
      entries.join(''),
    );
    return v.parse(sha, (await objectGit(root, index, ['write-tree'])).trim());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function authenticatedCurrent(handle: LocalAttemptHandle) {
  const { manifest } = await loadLocalManifest(handle);
  const inspection = await inspectLocalAttempt(handle);
  if (inspection.state !== 'finished' || !inspection.receipt.noWriter)
    throw new Error('Candidate writer is not settled');
  await verifyOwnedWorktree(manifest.ownedWorktree, false);
  const retained = await readRetainedCandidate(handle, manifest);
  if (!retained || !retained.receipt.noWriter)
    throw new Error('Authenticated retained candidate is required');
  const root = manifest.ownedWorktree.root;
  const headSha = (await hostGit(root, ['rev-parse', 'HEAD'])).trim();
  const status = await hostGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const diff = await hostGit(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    retained.baseSha,
    '--',
  ]);
  const [oldStatus, oldDiff, untrackedBytes] = await Promise.all(
    [retained.statusRef, retained.diffRef, retained.untrackedRef].map((p) =>
      readBytesBounded(p, 16 * 1024 * 1024),
    ),
  );
  if (
    headSha !== retained.headSha ||
    !oldStatus.equals(Buffer.from(status)) ||
    !oldDiff.equals(Buffer.from(diff))
  )
    throw new Error('Stale candidate: HEAD/status/diff drift');
  const rawEntries: unknown = JSON.parse(untrackedBytes.toString('utf8'));
  if (
    Array.isArray(rawEntries) &&
    rawEntries.some(
      (entry) => !entry || typeof entry !== 'object' || !('mode' in entry),
    )
  )
    throw new Error(
      'Legacy retained candidate mode is unproven; recollect through a fresh supervised attempt',
    );
  const entries = v.parse(untrackedSchema, rawEntries);
  const names = (
    await hostGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  if (JSON.stringify(names) !== JSON.stringify(entries.map((e) => e.path)))
    throw new Error('Stale candidate: untracked paths drift');
  for (const entry of entries) {
    const file = await fileBytes(root, entry.path);
    if (
      file.mode !== entry.mode ||
      (file.mode === '120000') !== (entry.kind === 'symlink') ||
      file.bytes.length !== entry.bytes ||
      artifactHash(file.bytes) !== entry.sha256 ||
      file.bytes.toString('base64') !== entry.contentBase64
    )
      throw new Error('Stale candidate: untracked bytes drift');
  }
  return {
    attemptId: manifest.attemptId,
    repoId: manifest.ownedWorktree.repoId,
    worktreeId: manifest.ownedWorktree.id,
    root,
    baseSha: retained.baseSha,
    headSha,
    statusHash: artifactHash(status),
    diffHash: artifactHash(diff),
    untrackedHash: artifactHash(untrackedBytes),
  };
}
export function candidateEvidenceRetentionRef(evidence: CandidateEvidence) {
  const value = v.parse(candidateEvidenceSchema, evidence);
  const owner = artifactHash(
    JSON.stringify({
      repoId: value.repoId,
      worktreeId: value.worktreeId,
      attemptId: value.attemptId,
      baseSha: value.baseSha,
      headSha: value.headSha,
    }),
  );
  return `refs/neondeck/evidence/v1/${owner}/${value.treeSha}`;
}
// Called only after signed attempt/receipt/artifact and current-byte validation.
// References are immutable CAS-created reachability roots. No cleanup is
// authorized here: retain history indefinitely until an explicit policy exists.
async function retainEvidenceTree(
  evidence: CandidateEvidence,
  directory: string,
) {
  const ref = candidateEvidenceRetentionRef(evidence);
  const inspect = async () =>
    (
      await hostGit(evidence.root, [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(symref)',
        ref,
      ])
    ).trim();
  const expected = `${ref}\0${evidence.treeSha}\0`;
  const existing = await inspect();
  if (existing) {
    if (existing !== expected)
      throw new Error('Evidence retention ref ownership mismatch');
    return;
  }
  try {
    await objectGit(evidence.root, join(directory, 'unused-retention-index'), [
      'update-ref',
      '--no-deref',
      ref,
      evidence.treeSha,
      '0'.repeat(40),
    ]);
  } catch (error) {
    if ((await inspect()) !== expected) throw error;
  }
  if ((await inspect()) !== expected)
    throw new Error('Evidence retention ref binding mismatch');
}

export async function captureCandidateEvidence(
  handle: LocalAttemptHandle,
): Promise<CandidateEvidence> {
  const current = await authenticatedCurrent(handle);
  const revision = await captureCandidateTree(current.root, handle.directory);
  const after = await authenticatedCurrent(handle);
  if (
    JSON.stringify(current) !== JSON.stringify(after) ||
    revision !== (await captureCandidateTree(current.root, handle.directory))
  )
    throw new Error('Candidate drift while freezing revision');
  const bound = { ...current, revision, treeSha: revision };
  const evidence = v.parse(candidateEvidenceSchema, {
    ...bound,
    evidenceDigest: artifactHash(JSON.stringify(bound)),
  });
  await retainEvidenceTree(evidence, handle.directory);
  return evidence;
}
export async function assertCandidateEvidenceCurrent(
  handle: LocalAttemptHandle,
  evidence: CandidateEvidence,
) {
  const expected = v.parse(candidateEvidenceSchema, evidence);
  const actual = await captureCandidateEvidence(handle);
  if (
    actual.evidenceDigest !== expected.evidenceDigest ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  )
    throw new Error('Stale candidate evidence digest');
  return actual;
}
