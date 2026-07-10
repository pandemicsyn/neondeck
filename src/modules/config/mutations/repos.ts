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
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import {
  addRepoInputSchema,
  removeRepoInputSchema,
  updateRepoAutopilotPolicyInputSchema,
  updateRepoInputSchema,
  type ConfigActionResult,
} from '../schemas';
import {
  repoAutopilotPolicy,
  type AutopilotMode,
  type RepoAutopilotConfig,
} from '../../autopilot-policy';

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
  if (hasAutopilotMetadata(input.metadata)) {
    return failResult('config_add_repo', paths, [paths.repos], {
      message:
        'Autopilot policy must be configured with the dedicated autopilot policy action.',
      requires: ['autopilotPolicy'],
    });
  }
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
  if (hasAutopilotMetadata(input.metadata)) {
    return failResult('config_update_repo', paths, [paths.repos], {
      message:
        'Autopilot policy must be configured with the dedicated autopilot policy action.',
      requires: ['autopilotPolicy'],
    });
  }
  const registry = await readRuntimeJson(paths.repos, parseRepoRegistry);
  const index = registry.repos.findIndex((repo) => repo.id === input.id);

  if (index === -1) {
    return failResult('config_update_repo', paths, [paths.repos], {
      message: `Repository "${input.id}" does not exist.`,
    });
  }

  const current = registry.repos[index];
  if (input.path && input.path !== current.path && input.confirm !== true) {
    return failResult('config_update_repo', paths, [paths.repos], {
      message: 'Changing a repository path requires explicit confirmation.',
      requires: ['confirm'],
    });
  }
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
    ...(input.metadata !== undefined
      ? {
          metadata: {
            ...input.metadata,
            ...(current.metadata?.autopilot !== undefined
              ? { autopilot: current.metadata.autopilot }
              : {}),
          },
        }
      : {}),
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

export async function updateRepoAutopilotPolicy(
  rawInput: v.InferInput<typeof updateRepoAutopilotPolicyInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateRepoAutopilotPolicyInputSchema,
    rawInput,
    'config_update_repo_autopilot_policy',
    paths,
    [paths.repos, paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const { confirm, repoId, ...input } = parsed.input;
  if (!hasAutopilotPolicyUpdate(input)) {
    return failResult(
      'config_update_repo_autopilot_policy',
      paths,
      [paths.repos, paths.config],
      {
        message: 'At least one autopilot policy setting is required.',
        requires: ['mode', 'reason', 'limits', 'concurrency', 'watchOverrides'],
      },
    );
  }

  const [registry, appConfig] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const index = registry.repos.findIndex((repo) => repo.id === repoId);
  if (index === -1) {
    return failResult(
      'config_update_repo_autopilot_policy',
      paths,
      [paths.repos, paths.config],
      {
        message: `Repository "${repoId}" does not exist.`,
      },
    );
  }

  const current = registry.repos[index];
  const currentPolicy = repoAutopilotPolicy(current, appConfig);
  const currentOverride = readAutopilotMetadata(current);
  const nextOverride = mergeRepoAutopilotConfig(currentOverride, input);
  const nextRepo: RepoConfig = {
    ...current,
    metadata: {
      ...(current.metadata ?? {}),
      autopilot: nextOverride,
    },
  };
  const nextPolicy = repoAutopilotPolicy(nextRepo, appConfig);

  if (
    autopilotAuthorityIncreases(
      currentPolicy,
      nextPolicy,
      currentOverride,
      nextOverride,
    ) &&
    confirm !== true
  ) {
    return failResult(
      'config_update_repo_autopilot_policy',
      paths,
      [paths.repos, paths.config],
      {
        message:
          'Increasing autopilot authority or relaxing its limits requires explicit confirmation.',
        requires: ['confirm'],
      },
    );
  }

  const next = parseRepoRegistry(
    { ...registry, repos: registry.repos.with(index, nextRepo) },
    paths.repos,
  );
  const changed = JSON.stringify(current) !== JSON.stringify(nextRepo);
  if (changed) {
    await writeJson(paths.repos, next);
    recordConfigChange(paths, {
      action: 'config_update_repo_autopilot_policy',
      file: paths.repos,
      target: repoId,
      before: registry,
      after: next,
    });
  }

  return okResult(
    'config_update_repo_autopilot_policy',
    changed,
    paths,
    [paths.repos, paths.config],
    {
      message: changed
        ? `Updated autopilot policy for repository "${repoId}".`
        : `Autopilot policy for repository "${repoId}" already matched the requested values.`,
      data: { repo: nextRepo, policy: nextPolicy },
    },
  );
}

function hasAutopilotMetadata(metadata: Record<string, unknown> | undefined) {
  return metadata?.autopilot !== undefined;
}

function hasAutopilotPolicyUpdate(
  input: Omit<
    v.InferOutput<typeof updateRepoAutopilotPolicyInputSchema>,
    'repoId' | 'confirm'
  >,
) {
  return Object.values(input).some((value) => value !== undefined);
}

function readAutopilotMetadata(repo: RepoConfig): RepoAutopilotConfig {
  const metadata = repo.metadata;
  if (
    !metadata ||
    typeof metadata.autopilot !== 'object' ||
    !metadata.autopilot
  ) {
    return {};
  }
  return metadata.autopilot as RepoAutopilotConfig;
}

function mergeRepoAutopilotConfig(
  current: RepoAutopilotConfig,
  input: Omit<
    v.InferOutput<typeof updateRepoAutopilotPolicyInputSchema>,
    'repoId' | 'confirm'
  >,
): RepoAutopilotConfig {
  return {
    ...current,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.limits !== undefined
      ? { limits: { ...current.limits, ...input.limits } }
      : {}),
    ...(input.concurrency !== undefined
      ? { concurrency: { ...current.concurrency, ...input.concurrency } }
      : {}),
    ...(input.watchOverrides !== undefined
      ? { watchOverrides: input.watchOverrides }
      : {}),
  };
}

function autopilotAuthorityIncreases(
  current: ReturnType<typeof repoAutopilotPolicy>,
  next: ReturnType<typeof repoAutopilotPolicy>,
  currentOverride: RepoAutopilotConfig,
  nextOverride: RepoAutopilotConfig,
) {
  if (modeRank(next.mode) > modeRank(current.mode)) return true;
  if (next.limits.maxFilesChanged > current.limits.maxFilesChanged) return true;
  if (next.limits.maxLinesChanged > current.limits.maxLinesChanged) return true;
  if (
    next.limits.generatedFileSizeThresholdBytes >
    current.limits.generatedFileSizeThresholdBytes
  )
    return true;
  if (next.limits.allowForcePush && !current.limits.allowForcePush) return true;
  if (
    addsValues(
      current.limits.allowedPushDestinations,
      next.limits.allowedPushDestinations,
    )
  )
    return true;
  if (
    removesValues(current.limits.deniedFileGlobs, next.limits.deniedFileGlobs)
  )
    return true;
  if (
    removesValues(
      current.limits.approvalRequiredFileGlobs,
      next.limits.approvalRequiredFileGlobs,
    )
  )
    return true;
  if (
    removesValues(current.limits.highRiskClasses, next.limits.highRiskClasses)
  )
    return true;
  if (removesValues(current.limits.requiredChecks, next.limits.requiredChecks))
    return true;
  if (
    next.concurrency.maxAutonomousJobs > current.concurrency.maxAutonomousJobs
  )
    return true;
  if (
    next.concurrency.maxActiveWorkflowRuns >
    current.concurrency.maxActiveWorkflowRuns
  )
    return true;
  if (
    next.concurrency.maxPerRepoAutonomousJobs >
    current.concurrency.maxPerRepoAutonomousJobs
  )
    return true;
  if (
    !next.concurrency.singleMutationPerPr &&
    current.concurrency.singleMutationPerPr
  )
    return true;
  if (
    next.concurrency.localExecutionLimit >
    current.concurrency.localExecutionLimit
  )
    return true;
  return (
    JSON.stringify(currentOverride.watchOverrides ?? []) !==
    JSON.stringify(nextOverride.watchOverrides ?? [])
  );
}

function addsValues(current: string[], next: string[]) {
  return next.some((value) => !current.includes(value));
}

function removesValues(current: string[], next: string[]) {
  return current.some((value) => !next.includes(value));
}

function modeRank(mode: AutopilotMode) {
  return [
    'notify-only',
    'prepare-only',
    'autofix-with-approval',
    'autofix-push-when-safe',
  ].indexOf(mode);
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
