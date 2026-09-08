import { lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  hostGit,
  artifactHash,
  privateDirectory,
  readBytesBounded,
  readSigned,
} from '../coding-runs';
import {
  saveTrialOwnership,
  trialHandle,
  recordTrialCleanup,
  trialCleanupRecorded,
  type TrialOwnership,
} from './trial-store';
import * as v from 'valibot';
import { repoWorkflowRunSchema } from '../../../shared/repo-workflow-runs';

export async function assertTrialCheckout(owner: TrialOwnership) {
  const { source, root, baseSha } = owner;
  if (
    (await realpath(source)) !== source ||
    (await realpath(root)) !== root ||
    root === source ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new Error('Checkout identity changed');
  if (
    !(await hostGit(source, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .includes(`worktree ${root}`)
  )
    throw new Error('Checkout registration changed');
  const common = async (cwd: string) =>
    realpath(
      resolve(
        cwd,
        (await hostGit(cwd, ['rev-parse', '--git-common-dir'])).trim(),
      ),
    );
  if (
    (await common(root)) !== (await common(source)) ||
    (await lstat(join(root, '.git'))).isDirectory() ||
    (await hostGit(root, ['rev-parse', 'HEAD'])).trim() !== baseSha
  )
    throw new Error('Checkout ownership changed');
}
export async function cleanupTrial(directory: string, owner: TrialOwnership) {
  await privateDirectory(directory);
  if (
    !owner.gitSettled ||
    owner.root !== join(directory, 'checkout') ||
    owner.ref !== `refs/neondeck-workflow-tests/${owner.runId}`
  )
    throw new Error('Cleanup lacks settled ownership');
  if (await trialCleanupRecorded(directory, owner)) return;
  const mutateGit = async (args: string[]) => {
    // A controller can disappear while Git is still writing. Only successful
    // completion plus a durable receipt authorizes subsequent cleanup/unlock.
    owner.gitSettled = false;
    await saveTrialOwnership(directory, owner);
    await hostGit(owner.source, args);
    owner.gitSettled = true;
    await saveTrialOwnership(directory, owner);
  };
  if (owner.source) {
    let exists = true;
    try {
      await lstat(owner.root);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      exists = false;
    }
    if (exists) {
      await assertTrialCheckout(owner);
      await mutateGit(['worktree', 'remove', '--force', '--', owner.root]);
    }
    if (owner.baseSha)
      await mutateGit(['update-ref', '-d', owner.ref, owner.baseSha]);
  }
  // Keep worker settlement receipts until this durable cleanup proof exists.
  await recordTrialCleanup(directory, owner);
  for (const job of owner.jobs) {
    const path = join(directory, `check-${artifactHash(job.jobId)}`);
    try {
      await privateDirectory(path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        continue;
      throw error;
    }
    await rm(path, { recursive: true });
  }
}
/** Call only after terminal persistence, under the live controller or exclusive recovery claim. */
export async function releaseTrialLock(
  directory: string,
  owner: TrialOwnership,
) {
  if (!(await trialCleanupRecorded(directory, owner)))
    throw new Error('Cleanup receipt missing');
  const handle = await trialHandle(directory);
  const terminal = v.parse(
    repoWorkflowRunSchema,
    await readSigned(join(directory, 'result.json'), handle.attemptToken),
  );
  if (
    terminal.runId !== owner.runId ||
    terminal.repoId !== owner.repoId ||
    terminal.cleanup !== 'complete' ||
    terminal.phase !== 'complete' ||
    terminal.status === 'running'
  )
    throw new Error('Terminal cleanup state missing');
  const lock = join(directory, '..', `repo-${artifactHash(owner.repoId)}.lock`);
  try {
    await privateDirectory(lock);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  if (
    (await readBytesBounded(join(lock, 'run-id'), 64)).toString('utf8') !==
    owner.runId
  )
    return; // A later run owns it; never remove or recreate its lock.
  await rm(lock, { recursive: true });
}
export async function trialLockBelongsTo(
  directory: string,
  repoId: string,
  runId: string,
) {
  const lock = join(directory, '..', `repo-${artifactHash(repoId)}.lock`);
  try {
    await privateDirectory(lock);
    return (
      (await readBytesBounded(join(lock, 'run-id'), 64)).toString('utf8') ===
      runId
    );
  } catch (error) {
    // Another observer may finish terminal unlock between either read.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
