import * as v from 'valibot';
import { label, type PublicationWorkspace } from './publication-contract';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { git, exists } from './publication-git-io';

/** Resolve from the registered source, never from candidate-controlled files.
 * Hash the bounded hook directory, including executable modes and helper files.
 */
export async function trustedPublicationHooks(sourceRoot: string) {
  const configured = (
    await git(sourceRoot, ['config', '--get', 'core.hooksPath']).catch(
      (error) => {
        if (error instanceof Error && 'code' in error && error.code === 1)
          return '';
        throw error;
      },
    )
  ).trim();
  const hooksPath = configured
    ? resolve(sourceRoot, configured)
    : resolve(
        sourceRoot,
        (await git(sourceRoot, ['rev-parse', '--git-common-dir'])).trim(),
        'hooks',
      );
  if (hooksPath === '/dev/null' || (configured && !(await exists(hooksPath))))
    throw new Error('Configured repository hooks are unavailable.');
  const hash = createHash('sha256').update(hooksPath);
  let count = 0;
  let bytes = 0;
  if (await exists(hooksPath)) {
    if (
      (await realpath(hooksPath)) !== hooksPath ||
      !(await lstat(hooksPath)).isDirectory()
    )
      throw new Error('Trusted hooks directory must be canonical.');
    async function visit(directory: string, depth: number) {
      if (depth > 4) throw new Error('Trusted hook directory depth exceeded.');
      for (const name of (await readdir(directory)).sort()) {
        if (++count > 128)
          throw new Error('Trusted hook file budget exceeded.');
        const path = join(directory, name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink())
          throw new Error(
            'Trusted hook symlinks require explicit configuration.',
          );
        hash.update(JSON.stringify([path, stat.mode]));
        if (stat.isDirectory()) {
          await visit(path, depth + 1);
          continue;
        }
        if (!stat.isFile() || stat.size + bytes > 2 * 1024 * 1024)
          throw new Error('Trusted hook byte budget exceeded.');
        bytes += stat.size;
        if (
          directory === hooksPath &&
          [
            'pre-commit',
            'prepare-commit-msg',
            'commit-msg',
            'post-commit',
            'pre-push',
            'post-checkout',
          ].includes(name) &&
          !(stat.mode & 0o111)
        )
          throw new Error('Repository hook is not executable.');
        const body = await readFile(path);
        if (body.length !== stat.size)
          throw new Error('Trusted hook changed during read.');
        hash.update(body);
      }
    }
    await visit(hooksPath, 0);
  }
  return { hooksPath, fingerprint: hash.digest('hex') };
}
export async function commitConfiguration(workspace: PublicationWorkspace) {
  const name = v.parse(
    label,
    (await git(workspace.root, ['config', '--get', 'user.name'])).trim(),
  );
  const email = v.parse(
    v.pipe(v.string(), v.email()),
    (await git(workspace.root, ['config', '--get', 'user.email'])).trim(),
  );
  const { hooksPath, fingerprint: hookFingerprint } =
    await trustedPublicationHooks(workspace.sourceRoot);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([name, email, hooksPath, hookFingerprint]))
    .digest('hex');
  return { name, email, hooksPath, fingerprint };
}
