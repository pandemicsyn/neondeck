import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { runUnattendedGit } from '../../lib/git';

export async function gitCommonDir(cwd: string) {
  const raw = (await git(cwd, ['rev-parse', '--git-common-dir'])).trim();
  const full = isAbsolute(raw) ? raw : resolve(cwd, raw);
  return realpath(full);
}

export async function gitStatus(localPath: string, baseRef: string) {
  const [branch, headSha, baseSha, porcelain] = await Promise.all([
    git(localPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then((value) =>
      value.trim(),
    ),
    git(localPath, ['rev-parse', 'HEAD']).then((value) => value.trim()),
    git(localPath, ['rev-parse', baseRef])
      .then((value) => value.trim())
      .catch(() => null),
    git(localPath, ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  const changes = porcelain.split('\n').filter(Boolean);
  return {
    branch,
    headSha,
    baseSha,
    dirty: changes.length > 0,
    changeCount: changes.length,
    changes: changes.slice(0, 50),
  };
}

export async function isGitClean(localPath: string) {
  const status = await git(localPath, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  return status.trim().length === 0;
}

export async function git(cwd: string, args: string[]) {
  return runUnattendedGit(cwd, args);
}
