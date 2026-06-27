import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type RepoConfig,
  type RuntimePaths,
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';

const execFileAsync = promisify(execFile);

export type RepoRegistrySnapshot = {
  home: string;
  path: string;
  repos: RepoConfig[];
  count: number;
  fetchedAt: string;
};

export type RepoHealth = {
  id: string;
  repo: string;
  path: string;
  branch: string | null;
  defaultBranch: string;
  dirty: boolean;
  changeCount: number;
  ahead: number | null;
  behind: number | null;
  changes: string[];
  error?: string;
};

export type RepoHealthSnapshot = {
  home: string;
  path: string;
  repos: RepoHealth[];
  attention: RepoHealth[];
  count: number;
  fetchedAt: string;
};

export async function readRepoRegistrySnapshot(
  paths: RuntimePaths = runtimePaths(),
): Promise<RepoRegistrySnapshot> {
  await ensureRuntimeHome(paths);
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);

  return {
    home: paths.home,
    path: paths.repos,
    repos: registry.repos,
    count: registry.repos.length,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readRepoHealthSnapshot(
  paths: RuntimePaths = runtimePaths(),
): Promise<RepoHealthSnapshot> {
  const registry = await readRepoRegistrySnapshot(paths);
  const repos = await Promise.all(registry.repos.map(readGitRepoStatus));

  return {
    home: registry.home,
    path: registry.path,
    repos,
    attention: repos.filter((repo) => repo.dirty || repo.error),
    count: repos.length,
    fetchedAt: new Date().toISOString(),
  };
}

export async function readGitRepoStatus(repo: {
  id: string;
  path: string;
  github: { owner: string; name: string };
  defaultBranch: string;
}): Promise<RepoHealth> {
  try {
    const [branch, status, upstream] = await Promise.all([
      git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(repo.path, ['status', '--porcelain=v1', '--untracked-files=all']),
      git(repo.path, [
        'rev-list',
        '--left-right',
        '--count',
        '@{upstream}...HEAD',
      ])
        .then((output) => {
          const [behind, ahead] = output.trim().split(/\s+/).map(Number);
          return { ahead: ahead || 0, behind: behind || 0 };
        })
        .catch(() => ({ ahead: null, behind: null })),
    ]);
    const changes = status
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      id: repo.id,
      repo: repoFullName(repo),
      path: repo.path,
      branch: branch.trim(),
      defaultBranch: repo.defaultBranch,
      dirty: changes.length > 0,
      changeCount: changes.length,
      ahead: upstream.ahead,
      behind: upstream.behind,
      changes: changes.slice(0, 20),
    };
  } catch (error) {
    return {
      id: repo.id,
      repo: repoFullName(repo),
      path: repo.path,
      branch: null,
      defaultBranch: repo.defaultBranch,
      dirty: false,
      changeCount: 0,
      ahead: null,
      behind: null,
      changes: [],
      error: errorMessage(error),
    };
  }
}

export function repoFullName(repo: Pick<RepoConfig, 'github'>) {
  return `${repo.github.owner}/${repo.github.name}`;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
