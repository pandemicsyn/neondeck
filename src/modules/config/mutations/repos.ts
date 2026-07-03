import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
  parseActionInput,
  failResult,
  okResult,
  errorMessage,
} from '../result';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import {
  type RepoConfig,
  ensureRuntimeHome,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import {
  addRepoInputSchema,
  removeRepoInputSchema,
  updateRepoInputSchema,
  type ConfigActionResult,
} from '../schemas';

const execFileAsync = promisify(execFile);

export async function addRepo(
  rawInput: v.InferInput<typeof addRepoInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    addRepoInputSchema,
    rawInput,
    'config_add_repo',
    paths,
    [paths.repos],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const repoPath = resolveUserPath(input.path);
  const discovery = await discoverGitRepo(repoPath).catch((error) =>
    repoDiscoveryFailure(error),
  );
  if (!discovery.ok) {
    return failResult('config_add_repo', paths, [paths.repos], {
      message: discovery.message,
      errors: discovery.errors,
    });
  }
  const github = {
    owner: input.githubOwner ?? discovery.repo.github?.owner,
    name: input.githubName ?? discovery.repo.github?.name,
  };
  const defaultBranch = input.defaultBranch ?? discovery.repo.defaultBranch;

  if (!github.owner || !github.name) {
    return failResult('config_add_repo', paths, [paths.repos], {
      message:
        'Repository path is valid, but GitHub owner/name could not be inferred.',
      requires: ['githubOwner', 'githubName'],
    });
  }

  if (!defaultBranch) {
    return failResult('config_add_repo', paths, [paths.repos], {
      message: 'Repository path is valid, but default branch is unknown.',
      requires: ['defaultBranch'],
    });
  }

  const id = input.id ?? github.name;
  if (registry.repos.some((repo) => repo.id === id)) {
    return failResult('config_add_repo', paths, [paths.repos], {
      message: `Repository "${id}" already exists.`,
    });
  }

  const repo: RepoConfig = {
    id,
    github: {
      owner: github.owner,
      name: github.name,
    },
    path: repoPath,
    defaultBranch,
    ...(input.worktreeRoot ? { worktreeRoot: input.worktreeRoot } : {}),
    ...(input.productionTarget
      ? { productionTarget: input.productionTarget }
      : {}),
    packageScripts:
      input.packageScripts ?? (await readPackageScripts(repoPath)),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.watchRules ? { watchRules: input.watchRules } : {}),
  };

  const next = parseRepoRegistry(
    {
      ...registry,
      repos: [...registry.repos, repo],
    },
    paths.repos,
  );

  await writeJson(paths.repos, next);
  recordConfigChange(paths, {
    action: 'config_add_repo',
    file: paths.repos,
    target: id,
    before: registry,
    after: next,
  });

  return okResult('config_add_repo', true, paths, [paths.repos], {
    message: `Added repository "${id}".`,
    data: { repo },
  });
}

export async function updateRepo(
  rawInput: v.InferInput<typeof updateRepoInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateRepoInputSchema,
    rawInput,
    'config_update_repo',
    paths,
    [paths.repos],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const index = registry.repos.findIndex((repo) => repo.id === input.id);

  if (index === -1) {
    return failResult('config_update_repo', paths, [paths.repos], {
      message: `Repository "${input.id}" does not exist.`,
    });
  }

  const current = registry.repos[index];
  const repoPath = input.path ? resolveUserPath(input.path) : current.path;
  if (input.path) {
    const discovery = await discoverGitRepo(repoPath).catch((error) =>
      repoDiscoveryFailure(error),
    );
    if (!discovery.ok) {
      return failResult('config_update_repo', paths, [paths.repos], {
        message: discovery.message,
        errors: discovery.errors,
      });
    }
  }

  const nextRepo: RepoConfig = {
    ...current,
    path: repoPath,
    github: {
      owner: input.githubOwner ?? current.github.owner,
      name: input.githubName ?? current.github.name,
    },
    defaultBranch: input.defaultBranch ?? current.defaultBranch,
    ...(input.worktreeRoot !== undefined
      ? { worktreeRoot: input.worktreeRoot }
      : {}),
    ...(input.productionTarget !== undefined
      ? { productionTarget: input.productionTarget }
      : {}),
    ...(input.packageScripts !== undefined
      ? { packageScripts: input.packageScripts }
      : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.watchRules !== undefined ? { watchRules: input.watchRules } : {}),
  };
  const nextRepos = registry.repos.with(index, nextRepo);
  const next = parseRepoRegistry(
    { ...registry, repos: nextRepos },
    paths.repos,
  );

  await writeJson(paths.repos, next);
  recordConfigChange(paths, {
    action: 'config_update_repo',
    file: paths.repos,
    target: input.id,
    before: registry,
    after: next,
  });

  return okResult('config_update_repo', true, paths, [paths.repos], {
    message: `Updated repository "${input.id}".`,
    data: { repo: nextRepo },
  });
}

export async function removeRepo(
  rawInput: v.InferInput<typeof removeRepoInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    removeRepoInputSchema,
    rawInput,
    'config_remove_repo',
    paths,
    [paths.repos],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (input.confirm !== true) {
    return failResult('config_remove_repo', paths, [paths.repos], {
      message: `Removing repository "${input.id}" requires confirmation.`,
      requires: ['confirm'],
    });
  }

  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const nextRepos = registry.repos.filter((repo) => repo.id !== input.id);

  if (nextRepos.length === registry.repos.length) {
    return failResult('config_remove_repo', paths, [paths.repos], {
      message: `Repository "${input.id}" does not exist.`,
    });
  }

  const next = parseRepoRegistry(
    { ...registry, repos: nextRepos },
    paths.repos,
  );
  await writeJson(paths.repos, next);
  recordConfigChange(paths, {
    action: 'config_remove_repo',
    file: paths.repos,
    target: input.id,
    before: registry,
    after: next,
  });

  return okResult('config_remove_repo', true, paths, [paths.repos], {
    message: `Removed repository "${input.id}".`,
  });
}

async function discoverGitRepo(path: string) {
  const info = await stat(path);
  if (!info.isDirectory()) {
    throw new Error(`${path} is not a directory`);
  }

  await git(path, ['rev-parse', '--is-inside-work-tree']);
  const remotes = await git(path, ['remote', '-v']).catch(() => '');
  const github = inferGitHubRepo(remotes);
  const defaultBranch = await inferDefaultBranch(path);

  return { ok: true as const, repo: { github, defaultBranch } };
}

function repoDiscoveryFailure(error: unknown) {
  return {
    ok: false as const,
    message: 'Repository path could not be added because it failed validation.',
    errors: [errorMessage(error)],
  };
}

async function inferDefaultBranch(path: string) {
  const originHead = await git(path, [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
    '--short',
  ]).catch(() => undefined);

  if (originHead) {
    return originHead.replace(/^origin\//, '').trim();
  }

  return git(path, ['branch', '--show-current'])
    .then((branch) => branch.trim() || undefined)
    .catch(() => undefined);
}

function inferGitHubRepo(remotes: string) {
  for (const line of remotes.split('\n')) {
    const match = line.match(
      /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\s|$)/,
    );

    if (match) {
      return {
        owner: match[1],
        name: match[2],
      };
    }
  }

  return undefined;
}

async function readPackageScripts(path: string) {
  const packageJsonPath = join(path, 'package.json');

  try {
    await access(packageJsonPath, constants.R_OK);
    const source = await readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(source) as { scripts?: unknown };

    if (!parsed.scripts || typeof parsed.scripts !== 'object') {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed.scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function resolveUserPath(path: string) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}
