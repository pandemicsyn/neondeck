import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeSigned, artifactHash, hostGit } from '../coding-runs';
export const candidateEvidenceFixtureRoots: string[] = [];
export async function candidateEvidenceFixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), 'candidate-evidence-')),
  );
  candidateEvidenceFixtureRoots.push(home);
  const source = join(home, 'source'),
    storage = join(home, 'worktrees'),
    root = join(storage, 'candidate'),
    directory = join(home, 'attempt');
  await mkdir(source);
  await mkdir(storage);
  await mkdir(directory, { mode: 0o700 });
  const git = (cwd: string, args: string[]) =>
    execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' });
  git(source, ['init', '-q']);
  await writeFile(join(source, 'a.txt'), 'base\n');
  git(source, ['add', '.']);
  git(source, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'base',
  ]);
  const baseSha = git(source, ['rev-parse', 'HEAD']).trim();
  git(source, ['worktree', 'add', '-qb', 'agent/factory-fixture', root]);
  await writeFile(join(root, 'a.txt'), 'candidate\n');
  await writeFile(join(root, 'new.txt'), 'new\n');
  const handle = { directory, attemptToken: 'a'.repeat(64) };
  const nonce = 'b'.repeat(32),
    attemptId = 'fixture-attempt';
  const receipt = {
    version: 1,
    attemptId,
    nonce,
    at: Date.now(),
    supervisor: {
      pid: 999999,
      pgid: 999999,
      start: 'fixture',
      command: 'fixture',
    },
    group: null,
    state: 'finished',
    reason: 'cancelled',
    exitCode: null,
    signal: null,
    sessionId: null,
    terminal: null,
    outputBytes: 0,
    noWriter: true,
    authCleanup: 'absent',
  };
  await writeSigned(join(directory, 'manifest.json'), handle.attemptToken, {
    version: 1,
    attemptId,
    nonce,
    cliVersion: 'fixture',
    directory,
    ownedWorktree: {
      id: 'w',
      repoId: 'r',
      root,
      sourceRoot: source,
      storageRoot: storage,
      branch: 'agent/factory-fixture',
      baseSha,
    },
    config: {
      executable: '/usr/bin/true',
      model: 'fixture',
      sandbox: 'workspace-write',
      path: '/usr/bin:/bin',
      wallTimeMs: 1000,
      maxOutputBytes: 1000,
      maxLineBytes: 1000,
      termGraceMs: 100,
    },
  });
  await writeSigned(
    join(directory, 'receipt.json'),
    handle.attemptToken,
    receipt,
  );
  const capture = join(directory, 'candidate-ABCDEF');
  await mkdir(capture, { mode: 0o700 });
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
    baseSha,
    '--',
  ]);
  const bytes = Buffer.from('new\n');
  const untracked = JSON.stringify([
    {
      path: 'new.txt',
      kind: 'file',
      mode: '100644',
      bytes: bytes.length,
      sha256: artifactHash(bytes),
      contentBase64: bytes.toString('base64'),
    },
  ]);
  const result = {
    receipt,
    baseSha,
    headSha: baseSha,
    statusRef: join(capture, 'status.txt'),
    diffRef: join(capture, 'changes.diff'),
    untrackedRef: join(capture, 'untracked.json'),
    includesUntracked: true,
  };
  await writeFile(result.statusRef, status, { mode: 0o600 });
  await writeFile(result.diffRef, diff, { mode: 0o600 });
  await writeFile(result.untrackedRef, untracked, { mode: 0o600 });
  await writeSigned(join(directory, 'candidate.json'), handle.attemptToken, {
    version: 1,
    attemptId,
    nonce,
    result,
    hashes: {
      status: artifactHash(status),
      diff: artifactHash(diff),
      untracked: artifactHash(untracked),
    },
  });
  return { handle, root, git, source, result };
}
