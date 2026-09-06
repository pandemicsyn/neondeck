import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import { workspaceSchema } from './host-contract.ts';
const exec = promisify(execFile);
const gitOverrides = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];
const gitOptions = (cwd: string) => ({
  cwd,
  timeout: 10_000,
  maxBuffer: 4 * 1024 * 1024,
  env: {
    PATH: '/usr/bin:/bin',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  },
});

export async function hostGit(cwd: string, args: string[]) {
  // Config inspection itself performs no attribute conversion. Include effective
  // repository/worktree config and includes, and return keys only, never commands.
  try {
    const config = await exec(
      '/usr/bin/git',
      [
        ...gitOverrides,
        'config',
        '--includes',
        '--null',
        '--name-only',
        '--get-regexp',
        '^filter\\..*\\.(clean|process)$',
      ],
      gitOptions(cwd),
    );
    const keys = v.parse(
      v.array(v.pipe(v.string(), v.regex(/^filter\..*\.(clean|process)$/))),
      config.stdout.split('\0').filter(Boolean),
    );
    if (keys.length)
      throw new Error(
        'Executable Git clean/process filters are unsupported for host reads',
      );
  } catch (error) {
    // git config exits 1 only when no matching variable exists. All other
    // observation failures fail closed before status/diff can run a filter.
    if (!(error instanceof Error && 'code' in error && error.code === 1))
      throw error;
  }
  if (args[0] === 'status' || args[0] === 'diff') {
    const index = await exec(
      '/usr/bin/git',
      [...gitOverrides, 'ls-files', '--stage', '-z'],
      gitOptions(cwd),
    );
    if (/(?:^|\0)160000 /.test(index.stdout))
      throw new Error('Submodule collection requires a supervised collector');
  }
  const { stdout } = await exec(
    '/usr/bin/git',
    [...gitOverrides, ...args],
    gitOptions(cwd),
  );
  return stdout;
}
export function inside(root: string, child: string) {
  const part = relative(root, child);
  return (
    part !== '' &&
    part !== '..' &&
    !part.startsWith(`..${sep}`) &&
    !isAbsolute(part)
  );
}
export async function verifyOwnedWorktree(
  input: unknown,
  requireBase: boolean,
) {
  const workspace = v.parse(workspaceSchema, input);
  const [root, storage, source] = await Promise.all([
    realpath(workspace.root),
    realpath(workspace.storageRoot),
    realpath(workspace.sourceRoot),
  ]);
  if (
    root !== workspace.root ||
    storage !== workspace.storageRoot ||
    source !== workspace.sourceRoot ||
    root === source ||
    !inside(storage, root) ||
    (await lstat(workspace.root)).isSymbolicLink()
  )
    throw new Error('Worktree path ownership mismatch');
  const common = async (path: string) =>
    realpath(
      resolve(
        path,
        (await hostGit(path, ['rev-parse', '--git-common-dir'])).trim(),
      ),
    );
  if ((await common(root)) !== (await common(source)))
    throw new Error('Worktree belongs to another repository');
  if (
    (await realpath(
      (await hostGit(root, ['rev-parse', '--show-toplevel'])).trim(),
    )) !== root
  )
    throw new Error('Not a worktree root');
  if ((await lstat(resolve(root, '.git'))).isDirectory())
    throw new Error('Primary checkout is not an owned worktree');
  if (
    (await hostGit(root, ['symbolic-ref', '--short', 'HEAD'])).trim() !==
    workspace.branch
  )
    throw new Error('Factory branch identity changed');
  if (
    requireBase &&
    (await hostGit(root, ['rev-parse', 'HEAD'])).trim() !== workspace.baseSha
  )
    throw new Error('Worktree base changed before launch');
  if (
    !(await hostGit(source, ['worktree', 'list', '--porcelain']))
      .split('\n')
      .includes(`worktree ${root}`)
  )
    throw new Error('Unregistered worktree');
  return workspace;
}
