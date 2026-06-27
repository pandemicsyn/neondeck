import {
  type RepoConfig,
  type RuntimePaths,
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';

export type RepoRegistrySnapshot = {
  home: string;
  path: string;
  repos: RepoConfig[];
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

export function repoFullName(repo: Pick<RepoConfig, 'github'>) {
  return `${repo.github.owner}/${repo.github.name}`;
}
