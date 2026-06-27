import { defineAction, type JsonValue } from '@flue/runtime';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import * as v from 'valibot';
import {
  type RepoConfig,
  type RuntimePaths,
  type ScheduleEntry,
  ensureRuntimeHome,
  parseAppConfig,
  parseDashboardConfig,
  parseRepoRegistry,
  parseScheduleConfig,
  readRuntimeJson,
  runtimePaths,
  validateRuntimeFiles,
} from './runtime-home';

const execFileAsync = promisify(execFile);

type ConfigTarget = 'all' | 'config' | 'repos' | 'dashboard' | 'schedules';

type ConfigActionResult = {
  ok: boolean;
  action: string;
  changed: boolean;
  message: string;
  home: string;
  files: string[];
  data?: JsonValue;
  errors?: string[];
  requires?: string[];
};

const configTargetSchema = v.optional(
  v.picklist(['all', 'config', 'repos', 'dashboard', 'schedules']),
  'all',
);

const stringRecordSchema = v.record(v.string(), v.string());
const unknownRecordSchema = v.record(v.string(), v.unknown());

const addRepoInputSchema = v.object({
  path: v.string(),
  id: v.optional(v.string()),
  githubOwner: v.optional(v.string()),
  githubName: v.optional(v.string()),
  defaultBranch: v.optional(v.string()),
  productionTarget: v.optional(v.string()),
  packageScripts: v.optional(stringRecordSchema),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

const updateRepoInputSchema = v.object({
  id: v.string(),
  path: v.optional(v.string()),
  githubOwner: v.optional(v.string()),
  githubName: v.optional(v.string()),
  defaultBranch: v.optional(v.string()),
  productionTarget: v.optional(v.string()),
  packageScripts: v.optional(stringRecordSchema),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

const removeRepoInputSchema = v.object({
  id: v.string(),
  confirm: v.optional(v.boolean()),
});

const scheduleInputSchema = v.object({
  id: v.string(),
  type: v.string(),
  enabled: v.optional(v.boolean()),
  timezone: v.optional(v.string()),
  cron: v.optional(v.string()),
  preset: v.optional(v.string()),
  config: v.optional(unknownRecordSchema),
});

const updateScheduleInputSchema = v.object({
  id: v.string(),
  type: v.optional(v.string()),
  enabled: v.optional(v.boolean()),
  timezone: v.optional(v.string()),
  cron: v.optional(v.string()),
  preset: v.optional(v.string()),
  config: v.optional(unknownRecordSchema),
});

export const configReadAction = defineAction({
  name: 'neondeck_config_read',
  description:
    'Read validated Neondeck runtime config files without mutating them.',
  input: v.object({
    target: configTargetSchema,
  }),
  async run({ input }) {
    return readConfig(input);
  },
});

export const configValidateAction = defineAction({
  name: 'neondeck_config_validate',
  description:
    'Validate Neondeck runtime config files and report schema errors.',
  input: v.object({
    target: configTargetSchema,
  }),
  async run({ input }) {
    return validateConfig(input);
  },
});

export const configReloadAction = defineAction({
  name: 'neondeck_config_reload',
  description:
    'Reload Neondeck runtime config by validating files and returning the active config snapshot.',
  input: v.object({}),
  async run() {
    return reloadConfig();
  },
});

export const addRepoAction = defineAction({
  name: 'neondeck_config_add_repo',
  description:
    'Add a local git repository to Neondeck repos.json after path, git, GitHub, and schema validation.',
  input: addRepoInputSchema,
  async run({ input }) {
    return addRepo(input);
  },
});

export const updateRepoAction = defineAction({
  name: 'neondeck_config_update_repo',
  description:
    'Update an existing Neondeck repository entry in repos.json with schema validation.',
  input: updateRepoInputSchema,
  async run({ input }) {
    return updateRepo(input);
  },
});

export const removeRepoAction = defineAction({
  name: 'neondeck_config_remove_repo',
  description: 'Remove an existing Neondeck repository entry from repos.json.',
  input: removeRepoInputSchema,
  async run({ input }) {
    return removeRepo(input);
  },
});

export const addScheduleAction = defineAction({
  name: 'neondeck_config_add_schedule',
  description:
    'Add a Neondeck schedule entry to schedules.json with schema validation.',
  input: scheduleInputSchema,
  async run({ input }) {
    return addSchedule(input);
  },
});

export const updateScheduleAction = defineAction({
  name: 'neondeck_config_update_schedule',
  description:
    'Update an existing Neondeck schedule entry in schedules.json with schema validation.',
  input: updateScheduleInputSchema,
  async run({ input }) {
    return updateSchedule(input);
  },
});

export const removeScheduleAction = defineAction({
  name: 'neondeck_config_remove_schedule',
  description:
    'Remove an existing Neondeck schedule entry from schedules.json.',
  input: v.object({
    id: v.string(),
    confirm: v.optional(v.boolean()),
  }),
  async run({ input }) {
    return removeSchedule(input);
  },
});

export const neondeckConfigActions = [
  configReadAction,
  configValidateAction,
  configReloadAction,
  addRepoAction,
  updateRepoAction,
  removeRepoAction,
  addScheduleAction,
  updateScheduleAction,
  removeScheduleAction,
];

export async function readConfig(
  input: { target?: ConfigTarget } = {},
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const target = input.target ?? 'all';
  const data = await readTarget(target, paths);

  return okResult('config_read', false, paths, targetFiles(target, paths), {
    message: `Read ${target} config.`,
    data,
  });
}

export async function validateConfig(
  input: { target?: ConfigTarget } = {},
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const target = input.target ?? 'all';

  try {
    await readTarget(target, paths);
    return okResult(
      'config_validate',
      false,
      paths,
      targetFiles(target, paths),
      {
        message: `Validated ${target} config.`,
      },
    );
  } catch (error) {
    return failResult('config_validate', paths, targetFiles(target, paths), {
      message: `Invalid ${target} config.`,
      errors: [errorMessage(error)],
    });
  }
}

export async function reloadConfig(
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  await validateRuntimeFiles(paths);

  return okResult('config_reload', false, paths, targetFiles('all', paths), {
    message:
      'Runtime config reloaded. Neondeck reads config from disk, so no process restart was required.',
    data: await readTarget('all', paths),
  });
}

export async function addRepo(
  input: v.InferOutput<typeof addRepoInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
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
  input: v.InferOutput<typeof updateRepoInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
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
  input: { id: string; confirm?: boolean },
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
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

export async function addSchedule(
  input: v.InferOutput<typeof scheduleInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.schedules, parseScheduleConfig);

  if (config.schedules.some((schedule) => schedule.id === input.id)) {
    return failResult('config_add_schedule', paths, [paths.schedules], {
      message: `Schedule "${input.id}" already exists.`,
    });
  }

  const schedule: ScheduleEntry = {
    id: input.id,
    type: input.type,
    enabled: input.enabled ?? true,
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.cron ? { cron: input.cron } : {}),
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.config ? { config: input.config } : {}),
  };
  const next = parseScheduleConfig(
    { ...config, schedules: [...config.schedules, schedule] },
    paths.schedules,
  );

  await writeJson(paths.schedules, next);
  recordConfigChange(paths, {
    action: 'config_add_schedule',
    file: paths.schedules,
    target: input.id,
    before: config,
    after: next,
  });

  return okResult('config_add_schedule', true, paths, [paths.schedules], {
    message: `Added schedule "${input.id}".`,
    data: { schedule },
  });
}

export async function updateSchedule(
  input: v.InferOutput<typeof updateScheduleInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.schedules, parseScheduleConfig);
  const index = config.schedules.findIndex(
    (schedule) => schedule.id === input.id,
  );

  if (index === -1) {
    return failResult('config_update_schedule', paths, [paths.schedules], {
      message: `Schedule "${input.id}" does not exist.`,
    });
  }

  const schedule: ScheduleEntry = {
    ...config.schedules[index],
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.cron !== undefined ? { cron: input.cron } : {}),
    ...(input.preset !== undefined ? { preset: input.preset } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
  };
  const schedules = config.schedules.with(index, schedule);
  const next = parseScheduleConfig({ ...config, schedules }, paths.schedules);

  await writeJson(paths.schedules, next);
  recordConfigChange(paths, {
    action: 'config_update_schedule',
    file: paths.schedules,
    target: input.id,
    before: config,
    after: next,
  });

  return okResult('config_update_schedule', true, paths, [paths.schedules], {
    message: `Updated schedule "${input.id}".`,
    data: { schedule },
  });
}

export async function removeSchedule(
  input: { id: string; confirm?: boolean },
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  if (input.confirm !== true) {
    return failResult('config_remove_schedule', paths, [paths.schedules], {
      message: `Removing schedule "${input.id}" requires confirmation.`,
      requires: ['confirm'],
    });
  }

  const config = await readRuntimeJson(paths.schedules, parseScheduleConfig);
  const schedules = config.schedules.filter(
    (schedule) => schedule.id !== input.id,
  );

  if (schedules.length === config.schedules.length) {
    return failResult('config_remove_schedule', paths, [paths.schedules], {
      message: `Schedule "${input.id}" does not exist.`,
    });
  }

  const next = parseScheduleConfig({ ...config, schedules }, paths.schedules);
  await writeJson(paths.schedules, next);
  recordConfigChange(paths, {
    action: 'config_remove_schedule',
    file: paths.schedules,
    target: input.id,
    before: config,
    after: next,
  });

  return okResult('config_remove_schedule', true, paths, [paths.schedules], {
    message: `Removed schedule "${input.id}".`,
  });
}

async function readTarget(target: ConfigTarget, paths: RuntimePaths) {
  if (target === 'config') {
    return { config: await readRuntimeJson(paths.config, parseAppConfig) };
  }

  if (target === 'repos') {
    return { repos: await readRuntimeJson(paths.repos, parseRepoRegistry) };
  }

  if (target === 'dashboard') {
    return {
      dashboard: await readRuntimeJson(paths.dashboard, parseDashboardConfig),
    };
  }

  if (target === 'schedules') {
    return {
      schedules: await readRuntimeJson(paths.schedules, parseScheduleConfig),
    };
  }

  return {
    config: await readRuntimeJson(paths.config, parseAppConfig),
    repos: await readRuntimeJson(paths.repos, parseRepoRegistry),
    dashboard: await readRuntimeJson(paths.dashboard, parseDashboardConfig),
    schedules: await readRuntimeJson(paths.schedules, parseScheduleConfig),
  };
}

function targetFiles(target: ConfigTarget, paths: RuntimePaths) {
  if (target === 'config') return [paths.config];
  if (target === 'repos') return [paths.repos];
  if (target === 'dashboard') return [paths.dashboard];
  if (target === 'schedules') return [paths.schedules];
  return [paths.config, paths.repos, paths.dashboard, paths.schedules];
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

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

function recordConfigChange(
  paths: RuntimePaths,
  change: {
    action: string;
    file: string;
    target?: string;
    before: unknown;
    after: unknown;
  },
) {
  const database = new DatabaseSync(paths.neondeckDatabase);

  try {
    database
      .prepare(
        `
        INSERT INTO config_history (
          action,
          file,
          target,
          before_json,
          after_json,
          changed_at
        )
        VALUES (?, ?, ?, ?, ?, datetime('now'));
      `,
      )
      .run(
        change.action,
        change.file,
        change.target ?? null,
        JSON.stringify(change.before),
        JSON.stringify(change.after),
      );
  } finally {
    database.close();
  }
}

function resolveUserPath(path: string) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(path);
}

function okResult(
  action: string,
  changed: boolean,
  paths: RuntimePaths,
  files: string[],
  details: { message: string; data?: unknown },
): ConfigActionResult {
  return {
    ok: true,
    action,
    changed,
    message: details.message,
    home: paths.home,
    files,
    ...(details.data === undefined ? {} : { data: asJsonValue(details.data) }),
  };
}

function failResult(
  action: string,
  paths: RuntimePaths,
  files: string[],
  details: Pick<ConfigActionResult, 'message' | 'errors' | 'requires'>,
): ConfigActionResult {
  return {
    ok: false,
    action,
    changed: false,
    message: details.message,
    home: paths.home,
    files,
    ...(details.errors ? { errors: details.errors } : {}),
    ...(details.requires ? { requires: details.requires } : {}),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
