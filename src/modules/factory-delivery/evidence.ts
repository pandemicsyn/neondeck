import { execFile } from 'node:child_process';
import { mkdtemp, lstat, readlink, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { CandidateEvidenceError } from './evidence-errors';
import { snapshotEntry } from './evidence-snapshot';
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
    throw new CandidateEvidenceError('path-invalid');
  const info = await lstat(path);
  const bytes = info.isSymbolicLink()
    ? Buffer.from(await readlink(path))
    : info.isFile()
      ? await readBytesBounded(path, 2 * 1024 * 1024)
      : null;
  if (!bytes) throw new CandidateEvidenceError('unsupported-file');
  return {
    bytes,
    mode: info.isSymbolicLink()
      ? '120000'
      : info.mode & 0o111
        ? '100755'
        : '100644',
  };
}
export async function captureCandidateTree(
  root: string,
  directory: string,
  baseSha?: string,
) {
  try {
    return await captureTree(root, directory, baseSha);
  } catch (error) {
    if (error instanceof CandidateEvidenceError) throw error;
    throw new CandidateEvidenceError('capture-failed');
  }
}
async function captureTree(root: string, directory: string, baseSha?: string) {
  const baseline = v.parse(
    sha,
    baseSha ?? (await hostGit(root, ['rev-parse', 'HEAD'])).trim(),
  );
  const baselineBlobs = new Map<string, string>();
  for (const entry of (await hostGit(root, ['ls-tree', '-r', '-z', baseline]))
    .split('\0')
    .filter(Boolean)) {
    const match =
      /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new CandidateEvidenceError('unsupported-file');
    baselineBlobs.set(match[3]!, match[2]!);
  }
  await hostGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const tracked = new Map<string, string>();
  for (const entry of (await hostGit(root, ['ls-files', '--stage', '-z']))
    .split('\0')
    .filter(Boolean)) {
    const match = /^(100644|100755|120000) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(
      entry,
    );
    if (!match) throw new CandidateEvidenceError('unsupported-file');
    tracked.set(match[3]!, match[2]!);
  }
  const names = [
    ...new Set([
      ...baselineBlobs.keys(),
      ...tracked.keys(),
      ...(
        await hostGit(root, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
        ])
      )
        .split('\0')
        .filter(Boolean),
    ]),
  ].sort();
  if (names.length > 10000)
    throw new CandidateEvidenceError('file-count-exceeded');
  const temporary = await mkdtemp(join(directory, 'revision-'));
  const index = join(temporary, 'index');
  const budget = { scanned: 0, changed: 0 };
  try {
    await objectGit(root, index, ['read-tree', '--empty']);
    const entries: string[] = [];
    for (const name of names) {
      const file = await snapshotEntry(
        root,
        name,
        baselineBlobs.get(name),
        budget,
        (args, input) => objectGit(root, index, args, input),
      );
      if (file) entries.push(`${file.mode} ${file.blob}\t${name}\0`);
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
  const { manifest } = await loadLocalManifest(handle).catch(() => {
    throw new CandidateEvidenceError('integrity-failed');
  });
  const inspection = await inspectLocalAttempt(handle).catch(() => {
    throw new CandidateEvidenceError('integrity-failed');
  });
  if (inspection.state !== 'finished' || !inspection.receipt.noWriter)
    throw new CandidateEvidenceError('writer-unsettled');
  await verifyOwnedWorktree(manifest.ownedWorktree, false).catch(() => {
    throw new CandidateEvidenceError('ownership-invalid');
  });
  const retained = await readRetainedCandidate(handle, manifest).catch(() => {
    throw new CandidateEvidenceError('integrity-failed');
  });
  if (!retained || !retained.receipt.noWriter)
    throw new CandidateEvidenceError('candidate-unavailable');
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
    throw new CandidateEvidenceError('stale');
  let rawEntries: unknown;
  try {
    rawEntries = JSON.parse(untrackedBytes.toString('utf8'));
  } catch {
    throw new CandidateEvidenceError('integrity-failed');
  }
  if (
    Array.isArray(rawEntries) &&
    rawEntries.some(
      (entry) => !entry || typeof entry !== 'object' || !('mode' in entry),
    )
  )
    throw new CandidateEvidenceError('integrity-failed');
  const parsedEntries = v.safeParse(untrackedSchema, rawEntries);
  if (!parsedEntries.success)
    throw new CandidateEvidenceError('integrity-failed');
  const entries = parsedEntries.output;
  const names = (
    await hostGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .split('\0')
    .filter(Boolean);
  if (JSON.stringify(names) !== JSON.stringify(entries.map((e) => e.path)))
    throw new CandidateEvidenceError('stale');
  for (const entry of entries) {
    const file = await fileBytes(root, entry.path).catch((error: unknown) => {
      if (error instanceof CandidateEvidenceError) throw error;
      throw new CandidateEvidenceError('stale');
    });
    if (
      file.mode !== entry.mode ||
      (file.mode === '120000') !== (entry.kind === 'symlink') ||
      file.bytes.length !== entry.bytes ||
      artifactHash(file.bytes) !== entry.sha256 ||
      file.bytes.toString('base64') !== entry.contentBase64
    )
      throw new CandidateEvidenceError('stale');
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
      throw new CandidateEvidenceError('ownership-invalid');
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
  } catch {
    if ((await inspect()) !== expected)
      throw new CandidateEvidenceError('ownership-invalid');
  }
  if ((await inspect()) !== expected)
    throw new CandidateEvidenceError('ownership-invalid');
}

export async function captureCandidateEvidence(
  handle: LocalAttemptHandle,
): Promise<CandidateEvidence> {
  const current = await authenticatedCurrent(handle);
  const revision = await captureCandidateTree(
    current.root,
    handle.directory,
    current.baseSha,
  );
  const after = await authenticatedCurrent(handle);
  if (
    JSON.stringify(current) !== JSON.stringify(after) ||
    revision !==
      (await captureCandidateTree(
        current.root,
        handle.directory,
        current.baseSha,
      ))
  )
    throw new CandidateEvidenceError('stale');
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
    throw new CandidateEvidenceError('stale');
  return actual;
}
