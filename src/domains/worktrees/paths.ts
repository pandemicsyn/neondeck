import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  type RepoConfig,
  type RuntimePaths,
  type WorktreeCleanupConfig,
  ensureRuntimeHome,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
} from '../../runtime-home';
import { WorktreeError } from './errors';
import { git, gitCommonDir } from './git';
import {
  type RepoContext,
  type WorktreeCleanupPolicy,
  type WorktreeRecord,
  type WorktreeStorageKind,
} from './schemas';

export async function validateManagedWorktreeRoot(
  record: WorktreeRecord,
  paths: RuntimePaths,
) {
  const context = await repoContext(record.repoId, paths);
  const sourceRepoRoot = await realpath(context.repo.path);
  const storageRoot =
    record.storageKind === 'repo-local'
      ? await realpath(resolve(sourceRepoRoot, '.neondeck', 'worktrees'))
      : await realpath(paths.worktrees);
  const rootStat = await lstat(record.localPath);
  if (rootStat.isSymbolicLink()) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree root must not be a symlink: ${record.localPath}.`,
    );
  }
  const root = await realpath(record.localPath);
  if (!isInside(storageRoot, root)) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree root resolves outside declared root ${storageRoot}.`,
    );
  }
  const [sourceCommon, targetCommon] = await Promise.all([
    gitCommonDir(sourceRepoRoot),
    gitCommonDir(root),
  ]);
  if (sourceCommon !== targetCommon) {
    throw new WorktreeError(
      'REPO_MISMATCH',
      'Managed worktree no longer shares git common dir with the configured repo.',
    );
  }
}

export async function repoContext(
  repoId: string,
  paths: RuntimePaths,
): Promise<RepoContext> {
  await ensureRuntimeHome(paths);
  const [registry, config] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const repo = registry.repos.find((item) => item.id === repoId);
  if (!repo) {
    throw new WorktreeError(
      'REPO_NOT_FOUND',
      `Repository "${repoId}" is not configured.`,
    );
  }

  return {
    repo,
    appDefaultStorage: config.worktrees?.defaultStorage,
    appCleanup: cleanupPolicy(config.worktrees?.cleanup),
  };
}

export function cleanupPolicy(
  config?: WorktreeCleanupConfig,
): WorktreeCleanupPolicy {
  return {
    retainFailed: config?.retainFailed ?? true,
    retainPreparedDiff: config?.retainPreparedDiff ?? true,
    successfulGraceHours: config?.successfulGraceHours ?? 24,
    staleAgeHours: config?.staleAgeHours ?? 168,
  };
}

export function resolveStorageKind(
  repo: RepoConfig,
  requested: WorktreeStorageKind | undefined,
  configuredDefault: WorktreeStorageKind | undefined,
): WorktreeStorageKind {
  return requested ?? repo.worktreeRoot ?? configuredDefault ?? 'home';
}

export async function ensureStorageRoot(
  repoRoot: string,
  storage: WorktreeStorageKind,
  paths: RuntimePaths,
) {
  const root =
    storage === 'repo-local'
      ? resolve(repoRoot, '.neondeck', 'worktrees')
      : paths.worktrees;
  await mkdir(root, { recursive: true });
  return realpath(root);
}

export async function resolveDeclaredWorktreePath(input: string, root: string) {
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  const parent = await nearestExistingAncestor(candidate);
  if (!isInside(root, parent) || !isInside(root, candidate)) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree path must stay inside declared root ${root}.`,
    );
  }
  const existing = await realpath(candidate).catch(() => undefined);
  if (existing && !isInside(root, existing)) {
    throw new WorktreeError(
      'PATH_OUTSIDE_WORKTREE_ROOT',
      `Worktree path resolves outside declared root ${root}.`,
    );
  }
  return candidate;
}

export async function defaultWorktreePath(
  root: string,
  repo: RepoConfig,
  prNumber: number | undefined,
  headRef: string,
) {
  const base = slug(
    [
      repo.github.owner,
      repo.github.name,
      prNumber ? `pr-${prNumber}` : 'worktree',
      headRef.split('/').at(-1) ?? headRef,
    ].join('-'),
  );
  let candidate = resolve(root, base);
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = resolve(root, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

export async function assertAdoptableWorktree(
  localPath: string,
  sourceRepoRoot: string,
) {
  const root = (await git(localPath, ['rev-parse', '--show-toplevel'])).trim();
  if (resolve(root) !== resolve(localPath)) {
    throw new WorktreeError(
      'INVALID_WORKTREE',
      `Adopted path must be the git worktree root: ${localPath}.`,
    );
  }
  const [sourceCommon, targetCommon] = await Promise.all([
    gitCommonDir(sourceRepoRoot),
    gitCommonDir(localPath),
  ]);
  if (sourceCommon !== targetCommon) {
    throw new WorktreeError(
      'REPO_MISMATCH',
      'Adopted worktree does not share git common dir with the configured repo.',
    );
  }
}

export function repoFullName(repo: RepoConfig) {
  return `${repo.github.owner}/${repo.github.name}`;
}

async function nearestExistingAncestor(path: string) {
  let current = path;
  while (true) {
    if (await exists(current)) return realpath(current);
    const parent = resolve(current, '..');
    if (parent === current) return current;
    current = parent;
  }
}

export async function exists(path: string) {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

export function isInside(root: string, candidate: string) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function slug(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}
