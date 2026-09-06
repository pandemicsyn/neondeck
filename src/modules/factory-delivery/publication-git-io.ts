import { lstat } from 'node:fs/promises';
import * as v from 'valibot';
import { runUnattendedGit } from '../../lib/git';
import { sha } from './publication-contract';
function environment() {
  const env = { ...process.env };
  // Keep configured author, credentials, signing and hooks, but reject inherited
  // Git redirection/identity overrides or common hook bypass switches.
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG.*|AUTHOR_.*|COMMITTER_.*)$/.test(
        key,
      ) ||
      [
        'HUSKY',
        'HUSKY_SKIP_HOOKS',
        'SKIP',
        'PRE_COMMIT_ALLOW_NO_CONFIG',
      ].includes(key)
    )
      delete env[key];
  }
  return env;
}
export const git = (cwd: string, args: string[]) =>
  runUnattendedGit(cwd, args, {
    env: environment(),
    timeoutMs: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
export async function object(
  cwd: string,
  ref: string,
  kind: 'commit' | 'tree',
) {
  return v.parse(
    sha,
    (await git(cwd, ['rev-parse', '--verify', `${ref}^{${kind}}`])).trim(),
  );
}
export async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
