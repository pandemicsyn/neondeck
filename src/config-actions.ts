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
  type AgentModelConfig,
  type AppConfig,
  type DashboardConfig,
  type ProviderConfig,
  type RepoConfig,
  type RuntimePaths,
  type ScheduleEntry,
  ensureRuntimeHome,
  parseAppConfig,
  parseDashboardConfig,
  dashboardConfigSchema,
  parseRepoRegistry,
  parseScheduleConfig,
  readRuntimeJson,
  runtimePaths,
  thinkingLevelSchema,
  validateRuntimeFiles,
} from './runtime-home';
import {
  isRegisteredProvider,
  resolveAnthropicProviderStatus,
  resolveKilocodeProviderStatus,
  resolveOpenAiProviderStatus,
} from './providers';
import {
  asExecutionPolicyData,
  executionPolicyFromConfig,
  executionPolicyUpdateSchema,
  hasExecutionPolicyUpdate,
  mergeExecutionConfig,
} from './execution-policy';
import { configEventFromChange, publishConfigEvent } from './config-events';

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
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const providerQualifiedModelSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) return false;
    return isRegisteredProvider(value.slice(0, slash));
  }, 'Expected a provider-qualified model string using a registered provider.'),
);

const addRepoInputSchema = v.object({
  path: nonEmptyStringSchema,
  id: v.optional(nonEmptyStringSchema),
  githubOwner: v.optional(nonEmptyStringSchema),
  githubName: v.optional(nonEmptyStringSchema),
  defaultBranch: v.optional(nonEmptyStringSchema),
  productionTarget: v.optional(nonEmptyStringSchema),
  packageScripts: v.optional(stringRecordSchema),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

const updateRepoInputSchema = v.object({
  id: nonEmptyStringSchema,
  path: v.optional(nonEmptyStringSchema),
  githubOwner: v.optional(nonEmptyStringSchema),
  githubName: v.optional(nonEmptyStringSchema),
  defaultBranch: v.optional(nonEmptyStringSchema),
  productionTarget: v.optional(nonEmptyStringSchema),
  packageScripts: v.optional(stringRecordSchema),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

const removeRepoInputSchema = v.object({
  id: nonEmptyStringSchema,
  confirm: v.optional(v.boolean()),
});

const scheduleInputSchema = v.object({
  id: nonEmptyStringSchema,
  type: nonEmptyStringSchema,
  enabled: v.optional(v.boolean()),
  timezone: v.optional(nonEmptyStringSchema),
  cron: v.optional(nonEmptyStringSchema),
  preset: v.optional(nonEmptyStringSchema),
  config: v.optional(unknownRecordSchema),
});

const updateScheduleInputSchema = v.object({
  id: nonEmptyStringSchema,
  type: v.optional(nonEmptyStringSchema),
  enabled: v.optional(v.boolean()),
  timezone: v.optional(nonEmptyStringSchema),
  cron: v.optional(nonEmptyStringSchema),
  preset: v.optional(nonEmptyStringSchema),
  config: v.optional(unknownRecordSchema),
});
const subagentModelInputSchema = v.object({
  default: v.optional(providerQualifiedModelSchema),
  defaultThinkingLevel: v.optional(thinkingLevelSchema),
  repoResearcher: v.optional(providerQualifiedModelSchema),
  repoResearcherThinkingLevel: v.optional(thinkingLevelSchema),
  ciInvestigator: v.optional(providerQualifiedModelSchema),
  ciInvestigatorThinkingLevel: v.optional(thinkingLevelSchema),
  releaseReviewer: v.optional(providerQualifiedModelSchema),
  releaseReviewerThinkingLevel: v.optional(thinkingLevelSchema),
});
const updateAgentModelsInputSchema = v.object({
  default: v.optional(providerQualifiedModelSchema),
  defaultThinkingLevel: v.optional(thinkingLevelSchema),
  displayAssistant: v.optional(providerQualifiedModelSchema),
  displayAssistantThinkingLevel: v.optional(thinkingLevelSchema),
  subagents: v.optional(subagentModelInputSchema),
});
const updateSkillRootsInputSchema = v.object({
  skillRoots: v.array(nonEmptyStringSchema),
});
const envVarNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z_][A-Z0-9_]*$/, 'Expected an environment variable name.'),
);
const updateProviderInputSchema = v.object({
  provider: v.picklist(['kilocode', 'openai', 'anthropic']),
  enabled: v.optional(v.boolean()),
  apiKeyEnv: v.optional(v.nullable(envVarNameSchema)),
  organizationIdEnv: v.optional(v.nullable(envVarNameSchema)),
});
const dashboardPresetSchema = v.object({
  preset: v.picklist(['classic', 'cockpit']),
  statuslinePosition: v.optional(v.picklist(['top', 'bottom'])),
});
const configActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  home: v.string(),
  files: v.array(v.string()),
});

export const configReadAction = defineAction({
  name: 'neondeck_config_read',
  description:
    'Read validated Neondeck runtime config files without mutating them.',
  input: v.object({
    target: configTargetSchema,
  }),
  output: configActionOutputSchema,
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
  output: configActionOutputSchema,
  async run({ input }) {
    return validateConfig(input);
  },
});

export const configReloadAction = defineAction({
  name: 'neondeck_config_reload',
  description:
    'Reload Neondeck runtime config by validating files and returning the active config snapshot.',
  input: v.object({}),
  output: configActionOutputSchema,
  async run() {
    return reloadConfig();
  },
});

export const updateAgentModelsAction = defineAction({
  name: 'neondeck_config_update_agent_models',
  description:
    'Update display-assistant and subagent model names in runtime config.json. Provider registration is not changed by this action.',
  input: updateAgentModelsInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateAgentModels(input);
  },
});

export const updateSkillRootsAction = defineAction({
  name: 'neondeck_config_update_skill_roots',
  description:
    'Update external runtime skill roots in config.json with schema validation and config history.',
  input: updateSkillRootsInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateSkillRoots(input);
  },
});

export const readProvidersAction = defineAction({
  name: 'neondeck_config_read_providers',
  description:
    'Read validated allowlisted provider configuration without exposing secret values.',
  input: v.object({}),
  output: configActionOutputSchema,
  async run() {
    return readProviderConfig();
  },
});

export const updateProviderAction = defineAction({
  name: 'neondeck_config_update_provider',
  description:
    'Update allowlisted provider configuration in config.json using secret environment variable references only. Does not accept raw secrets or arbitrary base URLs.',
  input: updateProviderInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateProviderConfig(input);
  },
});

export const updateExecutionPolicyAction = defineAction({
  name: 'neondeck_config_update_execution_policy',
  description:
    'Update Neondeck host execution approval policy in config.json, including preapproved local or exe.dev commands. Does not execute commands.',
  input: executionPolicyUpdateSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateExecutionPolicy(input);
  },
});

export const updateDashboardLayoutAction = defineAction({
  name: 'neondeck_config_update_dashboard_layout',
  description:
    'Replace dashboard.json with a validated stacked-region dashboard layout.',
  input: dashboardConfigSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateDashboardLayout(input);
  },
});

export const applyDashboardPresetAction = defineAction({
  name: 'neondeck_config_apply_dashboard_preset',
  description:
    'Apply a known dashboard layout preset such as classic or cockpit.',
  input: dashboardPresetSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return applyDashboardPreset(input);
  },
});

export const addRepoAction = defineAction({
  name: 'neondeck_config_add_repo',
  description:
    'Add a local git repository to Neondeck repos.json after path, git, GitHub, and schema validation.',
  input: addRepoInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return addRepo(input);
  },
});

export const updateRepoAction = defineAction({
  name: 'neondeck_config_update_repo',
  description:
    'Update an existing Neondeck repository entry in repos.json with schema validation.',
  input: updateRepoInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateRepo(input);
  },
});

export const removeRepoAction = defineAction({
  name: 'neondeck_config_remove_repo',
  description:
    'Remove an existing Neondeck repository entry from repos.json after explicit confirmation.',
  input: removeRepoInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return removeRepo(input);
  },
});

export const addScheduleAction = defineAction({
  name: 'neondeck_config_add_schedule',
  description:
    'Add a Neondeck schedule entry to schedules.json with schema validation.',
  input: scheduleInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return addSchedule(input);
  },
});

export const updateScheduleAction = defineAction({
  name: 'neondeck_config_update_schedule',
  description:
    'Update an existing Neondeck schedule entry in schedules.json with schema validation.',
  input: updateScheduleInputSchema,
  output: configActionOutputSchema,
  async run({ input }) {
    return updateSchedule(input);
  },
});

export const removeScheduleAction = defineAction({
  name: 'neondeck_config_remove_schedule',
  description:
    'Remove an existing Neondeck schedule entry from schedules.json after explicit confirmation.',
  input: v.object({
    id: nonEmptyStringSchema,
    confirm: v.optional(v.boolean()),
  }),
  output: configActionOutputSchema,
  async run({ input }) {
    return removeSchedule(input);
  },
});

export const neondeckConfigActions = [
  configReadAction,
  configValidateAction,
  configReloadAction,
  updateAgentModelsAction,
  updateSkillRootsAction,
  readProvidersAction,
  updateProviderAction,
  updateExecutionPolicyAction,
  updateDashboardLayoutAction,
  applyDashboardPresetAction,
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
  const changedAt = new Date().toISOString();
  publishConfigEvent(
    configEventFromChange(paths, {
      action: 'config_reload',
      changed: false,
      files: targetFiles('all', paths),
      target: 'all',
      changedAt,
    }),
  );

  return okResult('config_reload', false, paths, targetFiles('all', paths), {
    message:
      'Runtime config reloaded. Neondeck reads config from disk, so no process restart was required.',
    data: await readTarget('all', paths),
  });
}

export async function updateAgentModels(
  rawInput: v.InferInput<typeof updateAgentModelsInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateAgentModelsInputSchema,
    rawInput,
    'config_update_agent_models',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (!hasAgentModelUpdate(input)) {
    return failResult('config_update_agent_models', paths, [paths.config], {
      message: 'At least one model value is required.',
      requires: ['model'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextModels = mergeAgentModelConfig(config.models, input);
  const next = parseAppConfig(
    {
      ...config,
      models: nextModels,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.models ?? {}) !== JSON.stringify(next.models ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_agent_models',
      file: paths.config,
      target: 'models',
      before: config,
      after: next,
    });
  }

  return okResult(
    'config_update_agent_models',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? 'Updated agent model configuration. Start a new session or restart the server for active agents to pick up the change.'
        : 'Agent model configuration already matched the requested values.',
      data: {
        models: next.models,
        appliesAfter: 'new-session-or-server-restart',
        providerRegistration:
          'Model strings must reference providers already registered by Neondeck or Flue runtime configuration.',
      },
    },
  );
}

export async function updateSkillRoots(
  rawInput: v.InferInput<typeof updateSkillRootsInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateSkillRootsInputSchema,
    rawInput,
    'config_update_skill_roots',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextSkillRoots = Array.from(new Set(parsed.input.skillRoots));
  const next = parseAppConfig(
    {
      ...config,
      skillRoots: nextSkillRoots,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.skillRoots ?? []) !==
    JSON.stringify(next.skillRoots ?? []);

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_skill_roots',
      file: paths.config,
      target: 'skillRoots',
      before: config,
      after: next,
    });
  }

  return okResult('config_update_skill_roots', changed, paths, [paths.config], {
    message: changed
      ? 'Updated runtime skill roots. Start a new session for active agents to load changed skills.'
      : 'Runtime skill roots already matched the requested values.',
    data: {
      skillRoots: next.skillRoots ?? [],
      appliesAfter: 'new-session',
    },
  });
}

export async function readProviderConfig(
  paths = runtimePaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const config = await readRuntimeJson(paths.config, parseAppConfig);

  return okResult('config_read_providers', false, paths, [paths.config], {
    message: 'Read allowlisted provider configuration.',
    data: {
      providers: effectiveProviderConfig(config.providers, env),
      policy:
        'Provider config is limited to allowlisted provider ids and environment variable secret references.',
    },
  });
}

export async function updateProviderConfig(
  rawInput: v.InferInput<typeof updateProviderInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateProviderInputSchema,
    rawInput,
    'config_update_provider',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (input.provider !== 'kilocode' && input.organizationIdEnv !== undefined) {
    return failResult('config_update_provider', paths, [paths.config], {
      message: `${input.provider} provider does not support organizationIdEnv.`,
      requires: ['enabled', 'apiKeyEnv'],
    });
  }

  if (
    input.enabled === undefined &&
    input.apiKeyEnv === undefined &&
    input.organizationIdEnv === undefined
  ) {
    return failResult('config_update_provider', paths, [paths.config], {
      message: 'At least one provider setting is required.',
      requires: ['enabled', 'apiKeyEnv', 'organizationIdEnv'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextProviders = mergeProviderConfig(config.providers, input);
  const next = parseAppConfig(
    {
      ...config,
      providers: nextProviders,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.providers ?? {}) !==
    JSON.stringify(next.providers ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_provider',
      file: paths.config,
      target: `providers.${input.provider}`,
      before: config,
      after: next,
    });
  }

  return okResult('config_update_provider', changed, paths, [paths.config], {
    message: changed
      ? 'Updated provider configuration. Restart the server for provider registration changes to take effect.'
      : 'Provider configuration already matched the requested values.',
    data: {
      providers: effectiveProviderConfig(next.providers),
      appliesAfter: 'server-restart',
      policy:
        'Only allowlisted provider ids and environment variable secret references are configurable.',
    },
  });
}

export async function updateExecutionPolicy(
  rawInput: v.InferInput<typeof executionPolicyUpdateSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    executionPolicyUpdateSchema,
    rawInput,
    'config_update_execution_policy',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (!hasExecutionPolicyUpdate(input)) {
    return failResult('config_update_execution_policy', paths, [paths.config], {
      message: 'At least one execution policy setting is required.',
      requires: [
        'defaultBackend',
        'enabledBackends',
        'approvalMode',
        'unattended',
        'preapprovedCommands',
        'exeDev',
      ],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextExecution = mergeExecutionConfig(config.execution, input);
  const next = parseAppConfig(
    {
      ...config,
      execution: nextExecution,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.execution ?? {}) !==
    JSON.stringify(next.execution ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_execution_policy',
      file: paths.config,
      target: 'execution',
      before: config,
      after: next,
    });
  }

  const policy = executionPolicyFromConfig({ execution: next.execution });
  return okResult(
    'config_update_execution_policy',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? 'Updated execution approval policy. Approved execution actions will use the new policy immediately when they read config.'
        : 'Execution approval policy already matched the requested values.',
      data: {
        execution: next.execution,
        policy: asExecutionPolicyData(policy),
      },
    },
  );
}

export async function updateDashboardLayout(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    dashboardConfigSchema,
    rawInput,
    'config_update_dashboard_layout',
    paths,
    [paths.dashboard],
  );
  if (!parsed.ok) return parsed.result;

  const current = await readDashboardForHistory(paths);
  const next = parsed.input;
  const changed = JSON.stringify(current) !== JSON.stringify(next);

  if (changed) {
    await writeJson(paths.dashboard, next);
    recordConfigChange(paths, {
      action: 'config_update_dashboard_layout',
      file: paths.dashboard,
      target: 'layout',
      before: current,
      after: next,
    });
  }

  return okResult(
    'config_update_dashboard_layout',
    changed,
    paths,
    [paths.dashboard],
    {
      message: changed
        ? 'Updated dashboard layout.'
        : 'Dashboard layout already matched the requested value.',
      data: { dashboard: next },
    },
  );
}

export async function applyDashboardPreset(
  rawInput: unknown,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    dashboardPresetSchema,
    rawInput,
    'config_apply_dashboard_preset',
    paths,
    [paths.dashboard],
  );
  if (!parsed.ok) return parsed.result;

  const current = await readDashboardForHistory(paths);
  const next = dashboardPresetConfig(
    parsed.input.preset,
    parsed.input.statuslinePosition ?? 'top',
  );
  const changed = JSON.stringify(current) !== JSON.stringify(next);

  if (changed) {
    await writeJson(paths.dashboard, next);
    recordConfigChange(paths, {
      action: 'config_apply_dashboard_preset',
      file: paths.dashboard,
      target: parsed.input.preset,
      before: current,
      after: next,
    });
  }

  return okResult(
    'config_apply_dashboard_preset',
    changed,
    paths,
    [paths.dashboard],
    {
      message: changed
        ? `Applied dashboard preset "${parsed.input.preset}".`
        : `Dashboard preset "${parsed.input.preset}" was already active.`,
      data: {
        preset: parsed.input.preset,
        dashboard: next,
      },
    },
  );
}

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

export async function addSchedule(
  rawInput: v.InferInput<typeof scheduleInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    scheduleInputSchema,
    rawInput,
    'config_add_schedule',
    paths,
    [paths.schedules],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
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
  rawInput: v.InferInput<typeof updateScheduleInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateScheduleInputSchema,
    rawInput,
    'config_update_schedule',
    paths,
    [paths.schedules],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
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
  rawInput: { id: string; confirm?: boolean },
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    v.object({
      id: nonEmptyStringSchema,
      confirm: v.optional(v.boolean()),
    }),
    rawInput,
    'config_remove_schedule',
    paths,
    [paths.schedules],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
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

function hasAgentModelUpdate(
  input: v.InferOutput<typeof updateAgentModelsInputSchema>,
) {
  return Boolean(
    input.default ||
    input.defaultThinkingLevel ||
    input.displayAssistant ||
    input.displayAssistantThinkingLevel ||
    input.subagents?.default ||
    input.subagents?.defaultThinkingLevel ||
    input.subagents?.repoResearcher ||
    input.subagents?.repoResearcherThinkingLevel ||
    input.subagents?.ciInvestigator ||
    input.subagents?.ciInvestigatorThinkingLevel ||
    input.subagents?.releaseReviewer ||
    input.subagents?.releaseReviewerThinkingLevel,
  );
}

function mergeAgentModelConfig(
  current: AppConfig['models'] | undefined,
  input: v.InferOutput<typeof updateAgentModelsInputSchema>,
): AgentModelConfig {
  const subagents = {
    ...current?.subagents,
    ...input.subagents,
  };

  return {
    ...current,
    ...(input.default !== undefined ? { default: input.default } : {}),
    ...(input.defaultThinkingLevel !== undefined
      ? { defaultThinkingLevel: input.defaultThinkingLevel }
      : {}),
    ...(input.displayAssistant !== undefined
      ? { displayAssistant: input.displayAssistant }
      : {}),
    ...(input.displayAssistantThinkingLevel !== undefined
      ? { displayAssistantThinkingLevel: input.displayAssistantThinkingLevel }
      : {}),
    ...(Object.keys(subagents).length > 0 ? { subagents } : {}),
  };
}

function mergeProviderConfig(
  current: AppConfig['providers'] | undefined,
  input: v.InferOutput<typeof updateProviderInputSchema>,
): ProviderConfig {
  const existing = current?.[input.provider] ?? {};
  const provider = {
    ...existing,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.apiKeyEnv !== undefined
      ? input.apiKeyEnv === null
        ? {}
        : { apiKeyEnv: input.apiKeyEnv }
      : {}),
    ...(input.provider === 'kilocode' && input.organizationIdEnv !== undefined
      ? input.organizationIdEnv === null
        ? {}
        : { organizationIdEnv: input.organizationIdEnv }
      : {}),
  };

  if (input.apiKeyEnv === null) {
    delete provider.apiKeyEnv;
  }
  if (input.provider === 'kilocode' && input.organizationIdEnv === null) {
    delete provider.organizationIdEnv;
  }

  return {
    ...current,
    [input.provider]: provider,
  };
}

function effectiveProviderConfig(
  current: AppConfig['providers'] | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const kilocode = resolveKilocodeProviderStatus({ providers: current }, env);
  const openai = resolveOpenAiProviderStatus({ providers: current }, env);
  const anthropic = resolveAnthropicProviderStatus({ providers: current }, env);

  return {
    kilocode: {
      enabled: kilocode.enabled,
      apiKeyEnv: kilocode.apiKeyEnv,
      organizationIdEnv: kilocode.organizationIdEnv,
    },
    openai: {
      enabled: openai.enabled,
      apiKeyEnv: openai.apiKeyEnv,
    },
    anthropic: {
      enabled: anthropic.enabled,
      apiKeyEnv: anthropic.apiKeyEnv,
    },
  };
}

async function readDashboardForHistory(paths: RuntimePaths): Promise<unknown> {
  const source = await readFile(paths.dashboard, 'utf8').catch(() => undefined);
  if (!source) return null;

  try {
    return parseDashboardConfig(JSON.parse(source), paths.dashboard);
  } catch (error) {
    return {
      invalidDashboard: paths.dashboard,
      error: errorMessage(error),
    };
  }
}

function dashboardPresetConfig(
  preset: 'classic' | 'cockpit',
  statuslinePosition: 'top' | 'bottom',
): DashboardConfig {
  if (preset === 'classic') {
    return parseDashboardConfig(
      {
        $schema: './dashboard.schema.json',
        display: { preset: 'xeneon-edge', width: 2560, height: 720 },
        appearance: { density: 'comfortable' },
        theme: 'dark',
        statusline: {
          position: statuslinePosition,
          pluginId: 'host-metrics',
          config: {},
        },
        layout: {
          mode: 'auto',
          columns: 12,
          rows: 5,
          regions: [
            {
              id: 'work',
              title: 'WORK',
              column: 1,
              row: 1,
              columnSpan: 4,
              rowSpan: 5,
              defaultTab: 'github',
              tabs: [
                {
                  id: 'github',
                  title: 'GITHUB',
                  pluginId: 'github-pr-list',
                  config: { limit: 12 },
                },
              ],
            },
            {
              id: 'neon',
              title: 'NEON',
              column: 5,
              row: 1,
              columnSpan: 8,
              rowSpan: 5,
              defaultTab: 'chat',
              tabs: [chatTab()],
            },
          ],
        },
      },
      'dashboard:preset:classic',
    );
  }

  return parseDashboardConfig(
    {
      $schema: './dashboard.schema.json',
      display: { preset: 'xeneon-edge', width: 2560, height: 720 },
      appearance: { density: 'comfortable' },
      theme: 'dark',
      statusline: {
        position: statuslinePosition,
        pluginId: 'host-metrics',
        config: {},
      },
      layout: {
        mode: 'auto',
        columns: 12,
        rows: 5,
        regions: [
          {
            id: 'work',
            title: 'WORK',
            column: 1,
            row: 1,
            columnSpan: 4,
            rowSpan: 5,
            defaultTab: 'github',
            tabs: [
              {
                id: 'github',
                title: 'GITHUB',
                pluginId: 'github-pr-list',
                config: { limit: 12 },
              },
              {
                id: 'watches',
                title: 'WATCHES',
                pluginId: 'active-watches',
                config: { limit: 8 },
              },
            ],
          },
          {
            id: 'neon',
            title: 'NEON',
            column: 5,
            row: 1,
            columnSpan: 8,
            rowSpan: 5,
            defaultTab: 'chat',
            tabs: [
              chatTab(),
              {
                id: 'briefing',
                title: 'BRIEFING',
                pluginId: 'briefing-panel',
                config: { actionLimit: 4 },
              },
              {
                id: 'memory',
                title: 'MEMORY',
                pluginId: 'memory-panel',
                config: { limit: 5 },
              },
              {
                id: 'runtime',
                title: 'RUNTIME',
                pluginId: 'runtime-overview',
                config: {
                  repoLimit: 5,
                  jobLimit: 5,
                  skillLimit: 5,
                  memoryLimit: 5,
                  workflowEventLimit: 6,
                },
              },
              {
                id: 'workflows',
                title: 'WORKFLOWS',
                pluginId: 'workflow-observability',
                config: {
                  eventLimit: 16,
                  refreshSeconds: 20,
                },
              },
              {
                id: 'subagents',
                title: 'SUBAGENTS',
                pluginId: 'subagent-summary',
                config: { eventLimit: 4 },
              },
            ],
          },
        ],
      },
    },
    'dashboard:preset:cockpit',
  );
}

function chatTab() {
  return {
    id: 'chat',
    title: 'CHAT',
    pluginId: 'flue-chat',
    config: {
      agentName: 'display-assistant',
      sessions: [
        {
          id: 'neondeck-main',
          label: 'Primary',
          placeholder: 'Ask about your active work...',
        },
      ],
      quickCommands: [
        { label: 'Repo', command: '/repo-status' },
        { label: 'Queue', command: '/review-queue' },
        { label: 'CI', command: '/explain-ci' },
        { label: 'PR', command: '/summarize-pr' },
        { label: 'Draft', command: '/draft-pr-description' },
        { label: 'Prep', command: '/prepare-pr' },
        { label: 'Review', command: '/review-local' },
        { label: 'Memory', command: '/memory' },
        { label: 'Doctor', command: '/dev-doctor' },
      ],
    },
  };
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
  const now = new Date().toISOString();

  try {
    const result = database
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
        VALUES (?, ?, ?, ?, ?, ?);
      `,
      )
      .run(
        change.action,
        change.file,
        change.target ?? null,
        JSON.stringify(change.before),
        JSON.stringify(change.after),
        now,
      );
    publishConfigEvent(
      configEventFromChange(paths, {
        id: result.lastInsertRowid,
        action: change.action,
        changed: true,
        files: [change.file],
        target: change.target,
        changedAt: now,
      }),
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

function parseActionInput<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  action: string,
  paths: RuntimePaths,
  files: string[],
) {
  const result = v.safeParse(schema, input);

  if (result.success) {
    return { ok: true as const, input: result.output };
  }

  return {
    ok: false as const,
    result: failResult(action, paths, files, {
      message: 'Invalid action input.',
      errors: [v.summarize(result.issues)],
    }),
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
