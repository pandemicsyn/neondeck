import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
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
  type RuntimePaths,
} from '../../../runtime-home';
import {
  addRepoInputSchema,
  removeRepoInputSchema,
  updateRepoAutopilotPolicyInputSchema,
  updateRepoAutopilotWatchOverrideInputSchema,
  updateRepoInputSchema,
  type ConfigActionResult,
} from '../schemas';
import {
  repoGuardrails,
  repoAutopilotPolicy,
  type AutopilotMode,
  type RepoGuardrailsConfig,
  type RepoAutopilotConfig,
} from '../../autopilot-policy';
import {
  createLeaseOwnerRecord,
  leaseOwnerIsAlive,
} from '../../autopilot/lease-owner';

const execFileAsync = promisify(execFile);

export async function addRepo(
  rawInput: v.InferInput<typeof addRepoInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  return withRepoOverrideLock(paths.repos, () =>
    addRepoUnlocked(rawInput, paths),
  );
}

async function addRepoUnlocked(
  rawInput: v.InferInput<typeof addRepoInputSchema>,
  paths: RuntimePaths,
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
  if (hasWatchOverrides(input.metadata)) {
    return failResult('config_add_repo', paths, [paths.repos], {
      message:
        'Autopilot watch overrides are created only by the Autopilot watch setup action.',
      requires: ['autopilotWatchSetup'],
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
  return withRepoOverrideLock(paths.repos, () =>
    updateRepoUnlocked(rawInput, paths),
  );
}

async function updateRepoUnlocked(
  rawInput: v.InferInput<typeof updateRepoInputSchema>,
  paths: RuntimePaths,
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
            ...(current.metadata?.guardrails !== undefined
              ? { guardrails: current.metadata.guardrails }
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
  return withRepoOverrideLock(paths.repos, () =>
    updateRepoAutopilotPolicyUnlocked(rawInput, paths),
  );
}

async function updateRepoAutopilotPolicyUnlocked(
  rawInput: v.InferInput<typeof updateRepoAutopilotPolicyInputSchema>,
  paths: RuntimePaths,
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
        requires: ['mode', 'reason', 'guardrails', 'concurrency'],
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
  const currentGuardrails = repoGuardrails(current, appConfig);
  const currentOverride = readAutopilotMetadata(current);
  const currentGuardrailOverride = readGuardrailsMetadata(current);
  const nextOverride = mergeRepoAutopilotConfig(currentOverride, input);
  const nextGuardrailOverride = {
    ...currentGuardrailOverride,
    ...input.guardrails,
  };
  const nextRepo: RepoConfig = {
    ...current,
    metadata: {
      ...current.metadata,
      autopilot: nextOverride,
      guardrails: nextGuardrailOverride,
    },
  };
  const nextPolicy = repoAutopilotPolicy(nextRepo, appConfig);
  const nextGuardrails = repoGuardrails(nextRepo, appConfig);

  if (
    autopilotAuthorityIncreases(
      currentPolicy,
      nextPolicy,
      currentGuardrails,
      nextGuardrails,
    ) &&
    confirm !== true
  ) {
    return failResult(
      'config_update_repo_autopilot_policy',
      paths,
      [paths.repos, paths.config],
      {
        message:
          'Increasing autopilot authority or relaxing shared guardrails requires explicit confirmation.',
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

/**
 * Upsert one watch override by its stable watch id.  This deliberately avoids
 * exposing the repository's complete override array to callers: two setup
 * surfaces configuring different PRs must not erase one another.
 */
export async function updateRepoAutopilotWatchOverride(
  rawInput: v.InferInput<typeof updateRepoAutopilotWatchOverrideInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  return withRepoOverrideLock(paths.repos, () =>
    updateRepoAutopilotWatchOverrideUnlocked(rawInput, paths),
  );
}

async function updateRepoAutopilotWatchOverrideUnlocked(
  rawInput: v.InferInput<typeof updateRepoAutopilotWatchOverrideInputSchema>,
  paths: RuntimePaths,
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateRepoAutopilotWatchOverrideInputSchema,
    rawInput,
    'config_update_repo_autopilot_watch_override',
    paths,
    [paths.repos, paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const [registry, appConfig] = await Promise.all([
    readRuntimeJson(paths.repos, parseRepoRegistry),
    readRuntimeJson(paths.config, parseAppConfig),
  ]);
  const index = registry.repos.findIndex(
    (repo) => repo.id === parsed.input.repoId,
  );
  if (index === -1) {
    return failResult(
      'config_update_repo_autopilot_watch_override',
      paths,
      [paths.repos, paths.config],
      {
        message: `Repository "${parsed.input.repoId}" does not exist.`,
      },
    );
  }
  const current = registry.repos[index];
  const currentOverride = readAutopilotMetadata(current);
  const existingOverrides = currentOverride.watchOverrides ?? [];
  const existingIndex = existingOverrides.findIndex(
    (override) => override.watchId === parsed.input.watchId,
  );
  const nextWatchOverride = {
    watchId: parsed.input.watchId,
    prNumber: parsed.input.prNumber,
    mode: parsed.input.mode,
    ...(parsed.input.reason ? { reason: parsed.input.reason } : {}),
  };
  const nextOverrides =
    existingIndex === -1
      ? [...existingOverrides, nextWatchOverride]
      : existingOverrides.with(existingIndex, nextWatchOverride);
  const nextOverride = { ...currentOverride, watchOverrides: nextOverrides };
  const nextRepo: RepoConfig = {
    ...current,
    metadata: { ...current.metadata, autopilot: nextOverride },
  };
  const currentPolicy = repoAutopilotPolicy(current, appConfig);
  const nextPolicy = repoAutopilotPolicy(nextRepo, appConfig);
  const currentWatchMode =
    existingOverrides[existingIndex]?.mode ?? currentPolicy.mode;
  if (
    modeRank(parsed.input.mode) > modeRank(currentWatchMode) &&
    parsed.input.confirm !== true
  ) {
    return failResult(
      'config_update_repo_autopilot_watch_override',
      paths,
      [paths.repos, paths.config],
      {
        message:
          "Increasing this watch's autopilot authority requires explicit confirmation.",
        requires: ['confirm'],
      },
    );
  }
  const changed = JSON.stringify(current) !== JSON.stringify(nextRepo);
  if (changed) {
    const next = parseRepoRegistry(
      { ...registry, repos: registry.repos.with(index, nextRepo) },
      paths.repos,
    );
    await writeJson(paths.repos, next);
    recordConfigChange(paths, {
      action: 'config_update_repo_autopilot_watch_override',
      file: paths.repos,
      target: `${parsed.input.repoId}:${parsed.input.watchId}`,
      before: registry,
      after: next,
    });
  }
  return okResult(
    'config_update_repo_autopilot_watch_override',
    changed,
    paths,
    [paths.repos, paths.config],
    {
      message: changed
        ? `Updated Autopilot mode for watch "${parsed.input.watchId}".`
        : `Autopilot mode for watch "${parsed.input.watchId}" already matched the requested values.`,
      data: {
        repo: nextRepo,
        policy: nextPolicy,
        watchOverride: nextWatchOverride,
      },
    },
  );
}

async function withRepoOverrideLock<T>(
  path: string,
  operation: () => Promise<T>,
) {
  const lockPath = `${path}.autopilot-override.lock`;
  const ownerPath = join(lockPath, 'owner');
  // Repo mutations can be the first operation against a new runtime home.
  // Create the lock parent before attempting the atomic lock-directory mkdir;
  // the unlocked mutation will initialize the runtime files themselves.
  await mkdir(dirname(lockPath), { recursive: true });
  const ownerToken = randomUUID();
  const ownerRecord = await createLeaseOwnerRecord(ownerToken);
  await cleanupStaleLockGenerations(lockPath);
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await mkdir(lockPath);
      try {
        await writeFile(ownerPath, ownerRecord, 'utf8');
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      if (!isExistsError(error)) throw error;
      const age = await stat(ownerPath)
        .then((value) => Date.now() - value.mtimeMs)
        .catch(() =>
          stat(lockPath)
            .then((value) => Date.now() - value.mtimeMs)
            .catch(() => 0),
        );
      // The critical section only writes one local JSON file.  A long lease
      // makes recovery from a crashed process possible without stealing an
      // active lock during a slow filesystem operation.  Rename is atomic: a
      // competing process can never remove a freshly acquired replacement.
      const observedToken = await readFile(ownerPath, 'utf8').catch(() => null);
      if (
        age > 300_000 &&
        !(await leaseOwnerIsAlive(observedToken)) &&
        (await stealStaleRepoOverrideLock(lockPath, observedToken))
      ) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          'Timed out waiting for the Autopilot watch override lock.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await operation();
  } finally {
    const currentToken = await readFile(ownerPath, 'utf8').catch(() => null);
    const takeoverClaimed = await readFile(
      join(lockPath, 'takeover'),
      'utf8',
    ).catch(() => null);
    if (
      currentToken === ownerRecord &&
      !(await hasFreshTakeoverClaim(lockPath, takeoverClaimed))
    ) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

async function stealStaleRepoOverrideLock(
  lockPath: string,
  observedToken: string | null,
) {
  const takeoverPath = join(lockPath, 'takeover');
  const takeoverToken = randomUUID();
  try {
    await writeFile(takeoverPath, takeoverToken, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (isExistsError(error)) {
      if (!(await hasFreshTakeoverClaim(lockPath))) {
        await rm(takeoverPath, { force: true });
      }
      return false;
    }
    if (isNotFoundError(error)) return false;
    throw error;
  }
  const currentToken = await readFile(join(lockPath, 'owner'), 'utf8').catch(
    () => null,
  );
  if (currentToken !== observedToken) {
    if (
      (await readFile(takeoverPath, 'utf8').catch(() => null)) === takeoverToken
    ) {
      await rm(takeoverPath, { force: true });
    }
    return false;
  }
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isExistsError(error) || isNotFoundError(error)) return false;
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function hasFreshTakeoverClaim(lockPath: string, claim?: string | null) {
  if (!claim) return false;
  const age = await stat(join(lockPath, 'takeover'))
    .then((value) => Date.now() - value.mtimeMs)
    .catch(() => Infinity);
  return age <= 300_000;
}

/** Reap interrupted takeover directories after their recovery grace period. */
async function cleanupStaleLockGenerations(path: string) {
  const parent = dirname(path);
  const prefix = `${basename(path)}.stale-`;
  const entries = await readdir(parent).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const candidate = join(parent, entry);
        const age = await stat(candidate)
          .then((value) => Date.now() - value.mtimeMs)
          .catch(() => 0);
        if (age > 300_000)
          await rm(candidate, { recursive: true, force: true });
      }),
  );
}

function isExistsError(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST',
  );
}

function isNotFoundError(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT',
  );
}

function hasAutopilotMetadata(metadata: Record<string, unknown> | undefined) {
  return (
    metadata?.autopilot !== undefined || metadata?.guardrails !== undefined
  );
}

function hasWatchOverrides(metadata: Record<string, unknown> | undefined) {
  const autopilot = metadata?.autopilot;
  return Boolean(
    autopilot && typeof autopilot === 'object' && 'watchOverrides' in autopilot,
  );
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
    ...(input.concurrency !== undefined
      ? { concurrency: { ...current.concurrency, ...input.concurrency } }
      : {}),
  };
}

function readGuardrailsMetadata(repo: RepoConfig): RepoGuardrailsConfig {
  const guardrails = repo.metadata?.guardrails;
  return guardrails && typeof guardrails === 'object'
    ? (guardrails as RepoGuardrailsConfig)
    : {};
}

function autopilotAuthorityIncreases(
  current: ReturnType<typeof repoAutopilotPolicy>,
  next: ReturnType<typeof repoAutopilotPolicy>,
  currentGuardrails: ReturnType<typeof repoGuardrails>,
  nextGuardrails: ReturnType<typeof repoGuardrails>,
) {
  if (modeRank(next.mode) > modeRank(current.mode)) return true;
  if (nextGuardrails.maxFilesChanged > currentGuardrails.maxFilesChanged)
    return true;
  if (nextGuardrails.maxLinesChanged > currentGuardrails.maxLinesChanged)
    return true;
  if (
    nextGuardrails.generatedFileSizeThresholdBytes >
    currentGuardrails.generatedFileSizeThresholdBytes
  )
    return true;
  if (nextGuardrails.allowForcePush && !currentGuardrails.allowForcePush)
    return true;
  if (
    addsValues(
      currentGuardrails.allowedPushDestinations,
      nextGuardrails.allowedPushDestinations,
    )
  )
    return true;
  if (
    removesValues(
      currentGuardrails.deniedFileGlobs,
      nextGuardrails.deniedFileGlobs,
    )
  )
    return true;
  if (
    removesValues(
      currentGuardrails.approvalRequiredFileGlobs,
      nextGuardrails.approvalRequiredFileGlobs,
    )
  )
    return true;
  if (
    removesValues(
      currentGuardrails.highRiskClasses,
      nextGuardrails.highRiskClasses,
    )
  )
    return true;
  if (
    removesValues(
      currentGuardrails.requiredChecks,
      nextGuardrails.requiredChecks,
    )
  )
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
  return false;
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
  return withRepoOverrideLock(paths.repos, () =>
    removeRepoUnlocked(rawInput, paths),
  );
}

async function removeRepoUnlocked(
  rawInput: v.InferInput<typeof removeRepoInputSchema>,
  paths: RuntimePaths,
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
