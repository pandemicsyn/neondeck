import { runExecFile } from '../../lib/exec';
import {
  type RepoConfig,
  type RuntimePaths,
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import { listActiveRepoWorktrees, type WorktreeRecord } from '../../worktrees';

export type RepoRegistrySnapshot = {
  home: string;
  path: string;
  repos: Array<RepoConfig & { activeWorktrees?: RepoRegistryWorktreeLink[] }>;
  count: number;
  fetchedAt: string;
};

export type RepoRegistryWorktreeLink = Pick<
  WorktreeRecord,
  | 'id'
  | 'prNumber'
  | 'headRef'
  | 'headSha'
  | 'localPath'
  | 'lifecycleStatus'
  | 'adopted'
  | 'updatedAt'
>;

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

export type RepoDiffSummary = {
  ok: boolean;
  repo: string;
  path: string;
  baseRef: string;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  fileCount: number;
  additions: number;
  deletions: number;
  binaryFiles: number;
  error?: string;
};

export async function readRepoRegistrySnapshot(
  paths: RuntimePaths = runtimePaths(),
): Promise<RepoRegistrySnapshot> {
  await ensureRuntimeHome(paths);
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);

  return {
    home: paths.home,
    path: paths.repos,
    repos: registry.repos.map((repo) => ({
      ...repo,
      activeWorktrees: listActiveRepoWorktrees(repo.id, paths).map(
        worktreeLink,
      ),
    })),
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

export async function readGitDiffSummary(repo: {
  path: string;
  github: { owner: string; name: string };
  defaultBranch: string;
}): Promise<RepoDiffSummary> {
  try {
    const [nameStatus, numstat] = await Promise.all([
      git(repo.path, ['diff', '--name-status', 'HEAD']),
      git(repo.path, ['diff', '--numstat', 'HEAD']),
    ]);
    const statuses = new Map(
      nameStatus
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [status, ...paths] = line.split(/\s+/);
          return [paths.at(-1) ?? 'unknown', status ?? 'M'] as const;
        }),
    );
    const files = numstat
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [additions, deletions, ...paths] = line.split(/\s+/);
        const path = paths.join(' ') || 'unknown';
        const binary = additions === '-' || deletions === '-';
        return {
          path,
          status: statuses.get(path) ?? 'M',
          additions: binary ? 0 : Number(additions ?? 0),
          deletions: binary ? 0 : Number(deletions ?? 0),
          binary,
        };
      });

    return {
      ok: true,
      repo: repoFullName(repo),
      path: repo.path,
      baseRef: repo.defaultBranch,
      files: files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
      fileCount: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      binaryFiles: files.filter((file) => file.binary).length,
    };
  } catch (error) {
    return {
      ok: false,
      repo: repoFullName(repo),
      path: repo.path,
      baseRef: repo.defaultBranch,
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      error: errorMessage(error),
    };
  }
}

export function repoFullName(repo: Pick<RepoConfig, 'github'>) {
  return `${repo.github.owner}/${repo.github.name}`;
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await runExecFile('git', args, { cwd });
  return stdout;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function worktreeLink(worktree: WorktreeRecord): RepoRegistryWorktreeLink {
  return {
    id: worktree.id,
    prNumber: worktree.prNumber,
    headRef: worktree.headRef,
    headSha: worktree.headSha,
    localPath: worktree.localPath,
    lifecycleStatus: worktree.lifecycleStatus,
    adopted: worktree.adopted,
    updatedAt: worktree.updatedAt,
  };
}
