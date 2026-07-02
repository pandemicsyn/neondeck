import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { cp, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import * as v from 'valibot';

export type RuntimeHomeEnv = Partial<
  Pick<NodeJS.ProcessEnv, 'NEONDECK_HOME' | 'XDG_CONFIG_HOME' | 'HOME'>
>;

export type RuntimePaths = {
  home: string;
  env: string;
  config: string;
  repos: string;
  dashboard: string;
  dashboardSchema: string;
  schedules: string;
  soul: string;
  skills: string;
  worktrees: string;
  data: string;
  neondeckDatabase: string;
  flueDatabase: string;
};

const unknownRecordSchema = v.record(v.string(), v.unknown());
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const dashboardDensitySchema = v.picklist(['compact', 'comfortable', 'large']);
const dashboardTextScaleSchema = v.pipe(
  v.number(),
  v.minValue(0.9),
  v.maxValue(1.75),
);
const envVarNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z_][A-Z0-9_]*$/, 'Expected an environment variable name.'),
);
export const localApiTokenSchema = v.pipe(
  v.string(),
  v.minLength(32),
  v.regex(
    /^[A-Za-z0-9_-]+$/,
    'Expected a base64url-compatible local API token.',
  ),
);
export const thinkingLevelSchema = v.picklist([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]);

export const agentModelConfigSchema = v.looseObject({
  default: v.optional(nonEmptyStringSchema),
  defaultThinkingLevel: v.optional(thinkingLevelSchema),
  displayAssistant: v.optional(nonEmptyStringSchema),
  displayAssistantThinkingLevel: v.optional(thinkingLevelSchema),
  utility: v.optional(nonEmptyStringSchema),
  utilityThinkingLevel: v.optional(thinkingLevelSchema),
  selfImprovement: v.optional(nonEmptyStringSchema),
  selfImprovementThinkingLevel: v.optional(thinkingLevelSchema),
  subagents: v.optional(
    v.looseObject({
      default: v.optional(nonEmptyStringSchema),
      defaultThinkingLevel: v.optional(thinkingLevelSchema),
      repoResearcher: v.optional(nonEmptyStringSchema),
      repoResearcherThinkingLevel: v.optional(thinkingLevelSchema),
      ciInvestigator: v.optional(nonEmptyStringSchema),
      ciInvestigatorThinkingLevel: v.optional(thinkingLevelSchema),
      releaseReviewer: v.optional(nonEmptyStringSchema),
      releaseReviewerThinkingLevel: v.optional(thinkingLevelSchema),
    }),
  ),
});

const learningWriteModeSchema = v.picklist(['off', 'review', 'auto']);
const memoryCurationModeSchema = v.picklist(['off', 'review', 'auto']);
const learningNotificationsSchema = v.picklist(['off', 'on']);

export const learningConfigSchema = v.looseObject({
  enabled: v.optional(v.boolean()),
  memoryWriteMode: v.optional(learningWriteModeSchema),
  skillWriteMode: v.optional(learningWriteModeSchema),
  memoryCurationEnabled: v.optional(v.boolean()),
  memoryCurationMode: v.optional(memoryCurationModeSchema),
  conversationReviewTurnInterval: v.optional(positiveIntegerSchema),
  memoryCurationTurnInterval: v.optional(positiveIntegerSchema),
  prRetrospectiveThreshold: v.optional(positiveIntegerSchema),
  notifications: v.optional(learningNotificationsSchema),
  memoryMaxActiveItems: v.optional(positiveIntegerSchema),
  maxRecentTurns: v.optional(positiveIntegerSchema),
  maxPrBatchItems: v.optional(positiveIntegerSchema),
  memoryPromptBudgetChars: v.optional(positiveIntegerSchema),
  userMemoryBudgetChars: v.optional(positiveIntegerSchema),
  localMemoryBudgetChars: v.optional(positiveIntegerSchema),
  projectMemoryBudgetChars: v.optional(positiveIntegerSchema),
});

export const providerConfigSchema = v.strictObject({
  kilocode: v.optional(
    v.strictObject({
      enabled: v.optional(v.boolean()),
      apiKeyEnv: v.optional(envVarNameSchema),
      organizationIdEnv: v.optional(envVarNameSchema),
    }),
  ),
  openai: v.optional(
    v.strictObject({
      enabled: v.optional(v.boolean()),
      apiKeyEnv: v.optional(envVarNameSchema),
    }),
  ),
  anthropic: v.optional(
    v.strictObject({
      enabled: v.optional(v.boolean()),
      apiKeyEnv: v.optional(envVarNameSchema),
    }),
  ),
});

const executionBackendSchema = v.picklist(['local', 'exe.dev']);
const executionApprovalModeSchema = v.picklist(['manual', 'off']);
const executionUnattendedModeSchema = v.picklist(['deny', 'allow-preapproved']);
const executionCommandMatchSchema = v.picklist(['exact', 'prefix', 'glob']);
const executionSandboxLifecycleSchema = v.picklist([
  'existing-vm',
  'fresh-per-execution',
  'reuse-session',
  'reuse-repo',
  'user-selected',
]);
const exeDevEnvForwardingSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  files: v.optional(v.array(nonEmptyStringSchema)),
  vars: v.optional(v.record(envVarNameSchema, v.string())),
  hostEnv: v.optional(v.record(envVarNameSchema, envVarNameSchema)),
});
const exeDevCheckoutConfigSchema = v.strictObject({
  remotePath: v.optional(nonEmptyStringSchema),
  env: v.optional(exeDevEnvForwardingSchema),
});
const shellOperatorFreeCommandSchema = v.pipe(
  nonEmptyStringSchema,
  v.check(
    (value) => !hasShellOperator(value),
    'Preapproved commands must be a single command without shell operators.',
  ),
);

export const executionPreapprovedCommandSchema = v.looseObject({
  id: v.optional(nonEmptyStringSchema),
  command: shellOperatorFreeCommandSchema,
  match: v.optional(executionCommandMatchSchema),
  backends: v.optional(v.array(executionBackendSchema)),
  description: v.optional(nonEmptyStringSchema),
});

export const executionConfigSchema = v.looseObject({
  defaultBackend: v.optional(executionBackendSchema),
  enabledBackends: v.optional(v.array(executionBackendSchema)),
  approvalMode: v.optional(executionApprovalModeSchema),
  unattended: v.optional(executionUnattendedModeSchema),
  preapprovedCommands: v.optional(v.array(executionPreapprovedCommandSchema)),
  exeDev: v.optional(
    v.strictObject({
      apiTokenEnv: v.optional(envVarNameSchema),
      lifecycle: v.optional(executionSandboxLifecycleSchema),
      sshKeyEnv: v.optional(envVarNameSchema),
      vmHostEnv: v.optional(envVarNameSchema),
      remoteRoot: v.optional(nonEmptyStringSchema),
      env: v.optional(exeDevEnvForwardingSchema),
      repos: v.optional(
        v.record(nonEmptyStringSchema, exeDevCheckoutConfigSchema),
      ),
      checkouts: v.optional(
        v.record(nonEmptyStringSchema, exeDevCheckoutConfigSchema),
      ),
    }),
  ),
});

export const worktreeCleanupConfigSchema = v.looseObject({
  retainFailed: v.optional(v.boolean()),
  retainPreparedDiff: v.optional(v.boolean()),
  successfulGraceHours: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  staleAgeHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const worktreeConfigSchema = v.looseObject({
  defaultStorage: v.optional(v.picklist(['home', 'repo-local'])),
  cleanup: v.optional(worktreeCleanupConfigSchema),
});

export const autopilotModeSchema = v.picklist([
  'notify-only',
  'prepare-only',
  'autofix-with-approval',
  'autofix-push-when-safe',
  'draft-fix',
  'auto-fix-no-push',
  'auto-fix-push-after-checks',
]);

export const autopilotPolicyLimitsSchema = v.looseObject({
  maxFilesChanged: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxLinesChanged: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  deniedFileGlobs: v.optional(v.array(nonEmptyStringSchema)),
  approvalRequiredFileGlobs: v.optional(v.array(nonEmptyStringSchema)),
  requiredChecks: v.optional(v.array(nonEmptyStringSchema)),
  allowedPushDestinations: v.optional(v.array(nonEmptyStringSchema)),
  allowForcePush: v.optional(v.boolean()),
  highRiskClasses: v.optional(v.array(nonEmptyStringSchema)),
  generatedFileSizeThresholdBytes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
});

export const autopilotConcurrencySchema = v.looseObject({
  maxAutonomousJobs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxActiveWorkflowRuns: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  maxPerRepoAutonomousJobs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  singleMutationPerPr: v.optional(v.boolean()),
  localExecutionLimit: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
});

export const autopilotConfigSchema = v.looseObject({
  defaultMode: v.optional(autopilotModeSchema),
  mode: v.optional(autopilotModeSchema),
  limits: v.optional(autopilotPolicyLimitsSchema),
  concurrency: v.optional(autopilotConcurrencySchema),
});

const kiloHandoffModeSchema = v.picklist([
  'draft-fix',
  'patch-proposal',
  'direct-edit',
]);
const kiloAutoPolicySchema = v.picklist([
  'never',
  'managed-worktree-draft-fix',
  'explicit-confirmation',
]);
const kiloRepoPolicySchema = v.picklist(['allow', 'deny']);

export const kiloConfigSchema = v.looseObject({
  enabled: v.optional(v.boolean()),
  cliPath: v.optional(nonEmptyStringSchema),
  defaultModel: v.optional(nonEmptyStringSchema),
  defaultAgent: v.optional(nonEmptyStringSchema),
  defaultMode: v.optional(kiloHandoffModeSchema),
  autoPolicy: v.optional(kiloAutoPolicySchema),
  explicitHandoffOnly: v.optional(v.boolean()),
  concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  rawLogRetentionDays: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  repos: v.optional(v.record(v.string(), kiloRepoPolicySchema)),
});

export const localApiConfigSchema = v.strictObject({
  token: localApiTokenSchema,
});

export const appConfigSchema = v.looseObject({
  version: positiveIntegerSchema,
  localApi: v.optional(localApiConfigSchema),
  skillRoots: v.optional(v.array(nonEmptyStringSchema)),
  models: v.optional(agentModelConfigSchema),
  providers: v.optional(providerConfigSchema),
  execution: v.optional(executionConfigSchema),
  worktrees: v.optional(worktreeConfigSchema),
  autopilot: v.optional(autopilotConfigSchema),
  kilo: v.optional(kiloConfigSchema),
  learning: v.optional(learningConfigSchema),
});

export const repoConfigSchema = v.looseObject({
  id: nonEmptyStringSchema,
  github: v.object({
    owner: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
  }),
  path: nonEmptyStringSchema,
  defaultBranch: nonEmptyStringSchema,
  worktreeRoot: v.optional(v.picklist(['home', 'repo-local'])),
  productionTarget: v.optional(nonEmptyStringSchema),
  packageScripts: v.optional(v.record(v.string(), v.string())),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

export const repoRegistrySchema = v.looseObject({
  repos: v.array(repoConfigSchema),
});

export const scheduleEntrySchema = v.looseObject({
  id: nonEmptyStringSchema,
  type: nonEmptyStringSchema,
  enabled: v.optional(v.boolean()),
  timezone: v.optional(nonEmptyStringSchema),
  cron: v.optional(nonEmptyStringSchema),
  preset: v.optional(nonEmptyStringSchema),
  config: v.optional(unknownRecordSchema),
});

export const scheduleConfigSchema = v.looseObject({
  schedules: v.array(scheduleEntrySchema),
});

export const dashboardTabSchema = v.looseObject({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  pluginId: nonEmptyStringSchema,
  config: v.optional(unknownRecordSchema),
});

export const dashboardRegionSchema = v.looseObject({
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  column: positiveIntegerSchema,
  row: positiveIntegerSchema,
  columnSpan: positiveIntegerSchema,
  rowSpan: positiveIntegerSchema,
  defaultTab: v.optional(nonEmptyStringSchema),
  tabs: v.pipe(v.array(dashboardTabSchema), v.minLength(1)),
});

export const dashboardConfigSchema = v.looseObject({
  $schema: v.optional(v.string()),
  display: v.object({
    preset: v.optional(nonEmptyStringSchema),
    width: positiveIntegerSchema,
    height: positiveIntegerSchema,
  }),
  theme: v.picklist(['light', 'dark', 'system']),
  appearance: v.optional(
    v.looseObject({
      density: v.optional(dashboardDensitySchema),
      textScale: v.optional(dashboardTextScaleSchema),
    }),
  ),
  statusline: v.optional(
    v.looseObject({
      position: v.picklist(['top', 'bottom']),
      pluginId: nonEmptyStringSchema,
      config: v.optional(unknownRecordSchema),
    }),
  ),
  layout: v.object({
    mode: v.optional(v.picklist(['auto', 'xeneon', 'stacked'])),
    columns: positiveIntegerSchema,
    rows: positiveIntegerSchema,
    regions: v.array(dashboardRegionSchema),
  }),
});

export type AppConfig = v.InferOutput<typeof appConfigSchema>;
export type AgentModelConfig = v.InferOutput<typeof agentModelConfigSchema>;
export type LearningConfig = v.InferOutput<typeof learningConfigSchema>;
export type ResolvedLearningConfig = Required<LearningConfig>;
export type ProviderConfig = v.InferOutput<typeof providerConfigSchema>;
export type ThinkingLevel = v.InferOutput<typeof thinkingLevelSchema>;
export type ExecutionConfig = v.InferOutput<typeof executionConfigSchema>;
export type ExecutionBackend = v.InferOutput<typeof executionBackendSchema>;
export type ExeDevEnvForwardingConfig = v.InferOutput<
  typeof exeDevEnvForwardingSchema
>;
export type ExeDevCheckoutConfig = v.InferOutput<
  typeof exeDevCheckoutConfigSchema
>;
export type ExecutionPreapprovedCommand = v.InferOutput<
  typeof executionPreapprovedCommandSchema
>;
export type WorktreeConfig = v.InferOutput<typeof worktreeConfigSchema>;
export type WorktreeCleanupConfig = v.InferOutput<
  typeof worktreeCleanupConfigSchema
>;
export type AutopilotConfig = v.InferOutput<typeof autopilotConfigSchema>;
export type KiloConfig = v.InferOutput<typeof kiloConfigSchema>;
export type LocalApiConfig = v.InferOutput<typeof localApiConfigSchema>;
export type RepoConfig = v.InferOutput<typeof repoConfigSchema>;
export type RepoRegistry = v.InferOutput<typeof repoRegistrySchema>;
export type ScheduleEntry = v.InferOutput<typeof scheduleEntrySchema>;
export type ScheduleConfig = v.InferOutput<typeof scheduleConfigSchema>;
export type DashboardConfig = v.InferOutput<typeof dashboardConfigSchema>;
export type DashboardRegion = v.InferOutput<typeof dashboardRegionSchema>;
export type DashboardTab = v.InferOutput<typeof dashboardTabSchema>;

export class ConfigValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.path = path;
    this.name = 'ConfigValidationError';
  }
}

const defaultDashboardPath = fileURLToPath(
  new URL('../config/dashboard.json', import.meta.url),
);
const defaultDashboardSchemaPath = fileURLToPath(
  new URL('../config/dashboard.schema.json', import.meta.url),
);
const defaultSoulPath = fileURLToPath(new URL('../SOUL.md', import.meta.url));

export function resolveRuntimeHome(env: RuntimeHomeEnv = process.env) {
  if (env.NEONDECK_HOME) {
    return expandHome(env.NEONDECK_HOME, env);
  }

  if (env.XDG_CONFIG_HOME) {
    return join(expandHome(env.XDG_CONFIG_HOME, env), 'neondeck');
  }

  return join(env.HOME ?? homedir(), '.config', 'neondeck');
}

export function runtimePaths(home = resolveRuntimeHome()): RuntimePaths {
  return {
    home,
    env: join(home, '.env'),
    config: join(home, 'config.json'),
    repos: join(home, 'repos.json'),
    dashboard: join(home, 'dashboard.json'),
    dashboardSchema: join(home, 'dashboard.schema.json'),
    schedules: join(home, 'schedules.json'),
    soul: join(home, 'SOUL.md'),
    skills: join(home, 'skills'),
    worktrees: join(home, 'worktrees'),
    data: join(home, 'data'),
    neondeckDatabase: join(home, 'data', 'neondeck.db'),
    flueDatabase: join(home, 'data', 'flue.db'),
  };
}

export async function ensureRuntimeHome(paths = runtimePaths()) {
  await mkdir(paths.home, { recursive: true });
  await mkdir(paths.data, { recursive: true });
  await mkdir(paths.skills, { recursive: true });
  await mkdir(paths.worktrees, { recursive: true });

  await writeFileIfMissing(paths.env, '');
  await writeJsonIfMissing(paths.config, defaultAppConfig());
  await ensureLocalApiConfig(paths.config);
  await writeJsonIfMissing(paths.repos, { repos: [] });
  await writeJsonIfMissing(paths.schedules, { schedules: [] });
  await copyIfMissing(defaultDashboardPath, paths.dashboard);
  await copyIfMissing(defaultDashboardSchemaPath, paths.dashboardSchema);
  await copyIfMissing(defaultSoulPath, paths.soul);
  initializeAppDatabase(paths.neondeckDatabase);
  initializeFlueDatabase(paths.flueDatabase);
}

export function ensureRuntimeHomeSync(paths = runtimePaths()) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(paths.skills, { recursive: true });
  mkdirSync(paths.worktrees, { recursive: true });

  writeFileIfMissingSync(paths.env, '');
  writeJsonIfMissingSync(paths.config, defaultAppConfig());
  ensureLocalApiConfigSync(paths.config);
  writeJsonIfMissingSync(paths.repos, { repos: [] });
  writeJsonIfMissingSync(paths.schedules, { schedules: [] });
  copyIfMissingSync(defaultDashboardPath, paths.dashboard);
  copyIfMissingSync(defaultDashboardSchemaPath, paths.dashboardSchema);
  copyIfMissingSync(defaultSoulPath, paths.soul);
  initializeAppDatabase(paths.neondeckDatabase);
  initializeFlueDatabase(paths.flueDatabase);
}

export async function readRuntimeJson<T>(
  path: string,
  parse: (value: unknown, path: string) => T,
): Promise<T> {
  const source = await readFile(path, 'utf8');
  return parseJson(source, path, parse);
}

export function readRuntimeJsonSync<T>(
  path: string,
  parse: (value: unknown, path: string) => T,
): T {
  const source = readFileSync(path, 'utf8');
  return parseJson(source, path, parse);
}

export async function validateRuntimeFiles(paths = runtimePaths()) {
  await readRuntimeJson(paths.config, parseAppConfig);
  await readRuntimeJson(paths.repos, parseRepoRegistry);
  await readRuntimeJson(paths.dashboard, parseDashboardConfig);
  await readRuntimeJson(paths.schedules, parseScheduleConfig);
}

export function validateRuntimeFilesSync(paths = runtimePaths()) {
  readRuntimeJsonSync(paths.config, parseAppConfig);
  readRuntimeJsonSync(paths.repos, parseRepoRegistry);
  readRuntimeJsonSync(paths.dashboard, parseDashboardConfig);
  readRuntimeJsonSync(paths.schedules, parseScheduleConfig);
}

function expandHome(path: string, env: RuntimeHomeEnv) {
  if (path === '~') {
    return env.HOME ?? homedir();
  }

  if (path.startsWith('~/')) {
    return join(env.HOME ?? homedir(), path.slice(2));
  }

  return resolve(path);
}

function hasShellOperator(value: string) {
  return /(?:\n|&&|\|\||[;&|<>`]|\$\()/.test(value);
}

function defaultAppConfig(): AppConfig {
  return {
    version: 1,
    localApi: { token: generateLocalApiToken() },
  };
}

export function generateLocalApiToken() {
  return randomBytes(32).toString('base64url');
}

export function resolveLearningConfig(
  config?: Pick<AppConfig, 'learning'>,
): ResolvedLearningConfig {
  const learning = config?.learning ?? {};
  return {
    enabled: learning.enabled ?? true,
    memoryWriteMode: learning.memoryWriteMode ?? 'auto',
    skillWriteMode: learning.skillWriteMode ?? 'auto',
    memoryCurationEnabled: learning.memoryCurationEnabled ?? true,
    memoryCurationMode: learning.memoryCurationMode ?? 'review',
    conversationReviewTurnInterval:
      learning.conversationReviewTurnInterval ?? 10,
    memoryCurationTurnInterval: learning.memoryCurationTurnInterval ?? 200,
    prRetrospectiveThreshold: learning.prRetrospectiveThreshold ?? 5,
    notifications: learning.notifications ?? 'on',
    memoryMaxActiveItems: learning.memoryMaxActiveItems ?? 200,
    maxRecentTurns: learning.maxRecentTurns ?? 30,
    maxPrBatchItems: learning.maxPrBatchItems ?? 8,
    memoryPromptBudgetChars: learning.memoryPromptBudgetChars ?? 3500,
    userMemoryBudgetChars: learning.userMemoryBudgetChars ?? 1000,
    localMemoryBudgetChars: learning.localMemoryBudgetChars ?? 1000,
    projectMemoryBudgetChars: learning.projectMemoryBudgetChars ?? 1500,
  };
}

async function ensureLocalApiConfig(path: string) {
  const value = await readJsonObjectLenient(path);
  if (!value) return;
  if (isValidLocalApiToken(readLocalApiTokenValue(value))) return;

  await writeJsonAtomic(path, {
    ...value,
    localApi: { token: generateLocalApiToken() },
  });
}

function ensureLocalApiConfigSync(path: string) {
  const value = readJsonObjectLenientSync(path);
  if (!value) return;
  if (isValidLocalApiToken(readLocalApiTokenValue(value))) return;

  writeJsonAtomicSync(path, {
    ...value,
    localApi: { token: generateLocalApiToken() },
  });
}

async function readJsonObjectLenient(path: string) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readJsonObjectLenientSync(path: string) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readLocalApiTokenValue(value: Record<string, unknown>) {
  const localApi = value.localApi;
  if (!isRecord(localApi)) return undefined;
  return localApi.token;
}

function isValidLocalApiToken(value: unknown) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function writeJsonAtomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = temporaryJsonPath(path);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

function writeJsonAtomicSync(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = temporaryJsonPath(path);
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);
}

function temporaryJsonPath(path: string) {
  return `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
}

async function writeJsonIfMissing(path: string, value: unknown) {
  await writeFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonIfMissingSync(path: string, value: unknown) {
  writeFileIfMissingSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileIfMissing(path: string, value: string) {
  if (existsSync(path)) {
    return;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, 'utf8');
}

function writeFileIfMissingSync(path: string, value: string) {
  if (existsSync(path)) {
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

async function copyIfMissing(source: string, target: string) {
  if (existsSync(target)) {
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}

function copyIfMissingSync(source: string, target: string) {
  if (existsSync(target)) {
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(source));
}

function initializeAppDatabase(path: string) {
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        file TEXT NOT NULL,
        target TEXT,
        before_json TEXT,
        after_json TEXT,
        changed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pr_watches (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        desired_terminal_state TEXT NOT NULL,
        status TEXT NOT NULL,
        pr_state TEXT,
        title TEXT,
        url TEXT,
        merge_commit_sha TEXT,
        last_snapshot_json TEXT,
        last_outcome TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_full_name, pr_number)
      );

      CREATE TABLE IF NOT EXISTS ref_watches (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT,
        url TEXT,
        last_snapshot_json TEXT,
        last_outcome TEXT,
        last_checked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_full_name, ref)
      );

      CREATE TABLE IF NOT EXISTS pr_watch_event_watermarks (
        watch_id TEXT NOT NULL,
        category TEXT NOT NULL,
        watermark_json TEXT NOT NULL,
        source_updated_at TEXT,
        checked_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(watch_id, category)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        blueprint TEXT,
        enabled INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL,
        config_json TEXT,
        next_run_at TEXT,
        last_run_at TEXT,
        last_outcome TEXT,
        last_message TEXT,
        last_result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        source TEXT,
        source_id TEXT,
        data_json TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        repo_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        use_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        before_json TEXT,
        after_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        repo_id TEXT,
        session_id TEXT,
        pr_key TEXT,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_reviews (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        thinking_level TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        input_summary_json TEXT,
        result_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS learning_candidates (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        action TEXT,
        scope TEXT,
        key TEXT,
        value_json TEXT,
        skill_id TEXT,
        patch_json TEXT,
        repo_id TEXT,
        reason TEXT,
        review_id TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS workflow_summaries (
        id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        run_id TEXT,
        status TEXT NOT NULL,
        summary_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT,
        workflow TEXT,
        event_type TEXT NOT NULL,
        event_index INTEGER,
        level TEXT,
        message TEXT NOT NULL,
        name TEXT,
        operation_kind TEXT,
        operation_id TEXT,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_events_run
        ON workflow_events(run_id, event_index);

      CREATE INDEX IF NOT EXISTS idx_workflow_events_created
        ON workflow_events(created_at DESC);

      CREATE TABLE IF NOT EXISTS workflow_run_observations (
        run_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        last_event_at TEXT NOT NULL,
        last_message TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        is_error INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS neon_sessions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        linked_repo_id TEXT,
        linked_watch_id TEXT,
        linked_task_id TEXT,
        stale_reasons_json TEXT,
        ui_metadata_json TEXT,
        summary TEXT,
        summary_generated_at TEXT,
        summary_source TEXT,
        summary_refresh_note TEXT,
        context_loaded_at TEXT,
        context_memory_ids_json TEXT,
        learning_turn_count INTEGER NOT NULL DEFAULT 0,
        last_learning_review_turn_count INTEGER NOT NULL DEFAULT 0,
        last_learning_review_at TEXT,
        last_learning_curation_turn_count INTEGER NOT NULL DEFAULT 0,
        last_learning_curation_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_surfaces (
        surface TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_session_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        session_id TEXT,
        surface TEXT,
        reason TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_approvals (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        backend TEXT NOT NULL,
        cwd TEXT,
        context TEXT NOT NULL,
        risk TEXT NOT NULL,
        policy_decision TEXT NOT NULL,
        status TEXT NOT NULL,
        approval_decision TEXT,
        approver_surface TEXT,
        session_id TEXT,
        request_context_json TEXT,
        result_json TEXT,
        exit_code INTEGER,
        stdout_preview TEXT,
        stderr_preview TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        executed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repo_edit_events (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        session_id TEXT,
        workflow_run_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        paths_json TEXT NOT NULL,
        input_hash TEXT,
        diff_summary_json TEXT,
        diff_patch TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS repo_file_reads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        repo_id TEXT NOT NULL,
        worktree_id TEXT,
        path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        partial INTEGER NOT NULL DEFAULT 0,
        read_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        github_owner TEXT NOT NULL,
        github_name TEXT NOT NULL,
        pr_number INTEGER,
        base_ref TEXT NOT NULL,
        head_owner TEXT,
        head_name TEXT,
        head_ref TEXT NOT NULL,
        head_sha TEXT,
        local_path TEXT NOT NULL UNIQUE,
        storage_kind TEXT NOT NULL,
        owning_workflow_run_id TEXT,
        lifecycle_status TEXT NOT NULL,
        last_synced_sha TEXT,
        last_pushed_sha TEXT,
        cleanup_policy_json TEXT,
        direct_push_allowed INTEGER NOT NULL DEFAULT 0,
        adopted INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktree_locks (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        worktree_id TEXT,
        repo_id TEXT NOT NULL,
        pr_number INTEGER,
        owner TEXT NOT NULL,
        workflow_run_id TEXT,
        expires_at TEXT NOT NULL,
        released_at TEXT,
        stale_recovered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktree_events (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS worktree_cleanup_attempts (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        error TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        attempted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS prepared_diffs (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL UNIQUE,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        pr_number INTEGER,
        title TEXT NOT NULL,
        source_worktree_path TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        head_sha TEXT,
        status TEXT NOT NULL,
        push_approval_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        summary_json TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        abandoned_at TEXT
      );

      CREATE TABLE IF NOT EXISTS prepared_diff_approvals (
        id TEXT PRIMARY KEY,
        prepared_diff_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        approval_type TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        approver_surface TEXT,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kilo_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        repo_full_name TEXT NOT NULL,
        worktree_id TEXT,
        lock_id TEXT,
        cwd TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        explicit_user_request INTEGER NOT NULL,
        auto_enabled INTEGER NOT NULL DEFAULT 0,
        cli_path TEXT NOT NULL,
        args_json TEXT NOT NULL,
        pid INTEGER,
        process_started_at TEXT,
        root_session_id TEXT,
        child_session_ids_json TEXT NOT NULL DEFAULT '[]',
        raw_log_path TEXT,
        summary TEXT,
        exit_code INTEGER,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS kilo_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_index INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        stream TEXT NOT NULL,
        session_id TEXT,
        child_session_id TEXT,
        summary TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kilo_session_audit (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        session_id TEXT,
        child_session_id TEXT,
        read_type TEXT NOT NULL,
        requester_surface TEXT NOT NULL,
        reason TEXT,
        limit_count INTEGER,
        offset_count INTEGER,
        include_full_transcript INTEGER NOT NULL DEFAULT 0,
        include_tool_output INTEGER NOT NULL DEFAULT 0,
        include_diff INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS kilo_result_state (
        task_id TEXT PRIMARY KEY,
        prepared_diff_id TEXT,
        classification TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        promotion_status TEXT NOT NULL,
        diff_fingerprint TEXT,
        verified_diff_fingerprint TEXT,
        review_summary_json TEXT,
        diff_summary_json TEXT,
        policy_json TEXT,
        verification_json TEXT,
        promotion_json TEXT,
        pending_approvals_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        reviewed_at TEXT,
        verified_at TEXT,
        promoted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS kilo_result_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );
    `);

    ensureColumn(database, 'repo_edit_events', 'worktree_id', 'TEXT');
    ensureColumn(database, 'repo_file_reads', 'worktree_id', 'TEXT');
    ensureColumn(database, 'kilo_tasks', 'lock_id', 'TEXT');
    ensureColumn(database, 'kilo_result_state', 'diff_fingerprint', 'TEXT');
    ensureColumn(
      database,
      'kilo_result_state',
      'verified_diff_fingerprint',
      'TEXT',
    );
    ensureColumn(database, 'notifications', 'resolved_at', 'TEXT');
    ensureColumn(database, 'notifications', 'updated_at', 'TEXT');
    ensureColumn(
      database,
      'notifications',
      'occurrence_count',
      'INTEGER NOT NULL DEFAULT 1',
    );
    ensureColumn(database, 'chat_sessions', 'context_loaded_at', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'summary_generated_at', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'summary_source', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'summary_refresh_note', 'TEXT');
    ensureColumn(database, 'chat_sessions', 'context_memory_ids_json', 'TEXT');
    ensureColumn(
      database,
      'chat_sessions',
      'learning_turn_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(
      database,
      'chat_sessions',
      'last_learning_review_turn_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(database, 'chat_sessions', 'last_learning_review_at', 'TEXT');
    ensureColumn(
      database,
      'chat_sessions',
      'last_learning_curation_turn_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(
      database,
      'chat_sessions',
      'last_learning_curation_at',
      'TEXT',
    );
    ensureColumn(database, 'memories', 'repo_id', 'TEXT');
    ensureColumn(
      database,
      'memories',
      'status',
      "TEXT NOT NULL DEFAULT 'active'",
    );
    ensureColumn(
      database,
      'memories',
      'use_count',
      'INTEGER NOT NULL DEFAULT 0',
    );
    ensureColumn(database, 'memories', 'last_used_at', 'TEXT');
    migrateMemoriesRepoIdentity(database);
    migrateMemoryEvents(database);
    ensureColumn(database, 'learning_candidates', 'action', 'TEXT');
    database
      .prepare(
        `
        UPDATE notifications
        SET updated_at = created_at
        WHERE updated_at IS NULL;
      `,
      )
      .run();
    reconcileActiveWorktreeLocks(database);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_notifications_source_unresolved
        ON notifications(source, source_id, resolved_at);

      CREATE INDEX IF NOT EXISTS idx_pr_watch_event_watermarks_watch
        ON pr_watch_event_watermarks(watch_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_notifications_attention
        ON notifications(resolved_at, read_at, level, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memory_events_changed
        ON memory_events(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_memories_active_scope
        ON memories(status, scope, updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_scope_key_repo
        ON memories(scope, key, COALESCE(repo_id, ''));

      CREATE INDEX IF NOT EXISTS idx_learning_events_type
        ON learning_events(type, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_learning_reviews_kind
        ON learning_reviews(kind, status, started_at DESC);

      CREATE INDEX IF NOT EXISTS idx_learning_candidates_status
        ON learning_candidates(target, status, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_execution_approvals_status
        ON execution_approvals(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_execution_approvals_updated
        ON execution_approvals(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_repo_edit_events_updated
        ON repo_edit_events(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_repo_edit_events_repo
        ON repo_edit_events(repo_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_repo_file_reads_lookup
        ON repo_file_reads(session_id, repo_id, worktree_id, path, read_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_recent
        ON chat_sessions(archived_at, pinned DESC, last_active_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_kind
        ON chat_sessions(kind, archived_at, last_active_at DESC);

      CREATE INDEX IF NOT EXISTS idx_chat_session_audit_session
        ON chat_session_audit(session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_worktrees_repo
        ON worktrees(repo_id, lifecycle_status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_worktrees_pr
        ON worktrees(repo_id, pr_number, head_ref, lifecycle_status);

      CREATE INDEX IF NOT EXISTS idx_worktree_locks_active
        ON worktree_locks(scope_key, released_at, expires_at);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_locks_one_active
        ON worktree_locks(scope_key)
        WHERE released_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_worktree_events_worktree
        ON worktree_events(worktree_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_worktree_cleanup_attempts_worktree
        ON worktree_cleanup_attempts(worktree_id, attempted_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diffs_status
        ON prepared_diffs(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diffs_repo
        ON prepared_diffs(repo_id, pr_number, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diff_approvals_pending
        ON prepared_diff_approvals(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_prepared_diff_approvals_diff
        ON prepared_diff_approvals(prepared_diff_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_tasks_status
        ON kilo_tasks(status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_tasks_repo
        ON kilo_tasks(repo_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_tasks_session
        ON kilo_tasks(root_session_id);

      CREATE INDEX IF NOT EXISTS idx_kilo_task_events_task
        ON kilo_task_events(task_id, event_index);

      CREATE INDEX IF NOT EXISTS idx_kilo_session_audit_session
        ON kilo_session_audit(session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_result_state_updated
        ON kilo_result_state(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_kilo_result_events_task
        ON kilo_result_events(task_id, created_at DESC);
    `);
    reconcileExistingNotificationDuplicates(database);
    reconcileActiveNeonSessions(database);

    database
      .prepare(
        `
        INSERT INTO neon_sessions (
          id,
          label,
          agent_name,
          status,
          reason,
          created_at,
          activated_at,
          updated_at
        )
        SELECT
          'neondeck-main',
          'Primary',
          'display-assistant',
          'active',
          'initial-session',
          datetime('now'),
          datetime('now'),
          datetime('now')
        WHERE NOT EXISTS (
          SELECT 1
          FROM neon_sessions
          WHERE agent_name = 'display-assistant'
            AND status = 'active'
        );
      `,
      )
      .run();

    migrateLegacyNeonSessions(database);
    reconcileActiveChatSession(database);

    database
      .prepare(
        `
        INSERT INTO app_metadata (key, value, updated_at)
        VALUES ('schema_version', '9', datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at;
      `,
      )
      .run();
  } finally {
    database.close();
  }
}

function migrateLegacyNeonSessions(database: DatabaseSync) {
  database
    .prepare(
      `
      INSERT INTO chat_sessions (
        id,
        title,
        agent_name,
        kind,
        pinned,
        archived_at,
        ui_metadata_json,
        created_at,
        updated_at,
        context_loaded_at,
        context_memory_ids_json,
        last_active_at
      )
      SELECT
        id,
        label,
        agent_name,
        CASE WHEN id = 'neondeck-main' THEN 'main' ELSE 'scratch' END,
        CASE WHEN id = 'neondeck-main' THEN 1 ELSE 0 END,
        ended_at,
        json_object('legacyReason', reason),
        created_at,
        updated_at,
        activated_at,
        '[]',
        activated_at
      FROM neon_sessions
      WHERE NOT EXISTS (
        SELECT 1 FROM chat_sessions WHERE chat_sessions.id = neon_sessions.id
      );
    `,
    )
    .run();

  database
    .prepare(
      `
      UPDATE chat_sessions
      SET
        context_loaded_at = COALESCE(
          context_loaded_at,
          (
            SELECT activated_at
            FROM neon_sessions
            WHERE neon_sessions.id = chat_sessions.id
          ),
          created_at
        ),
        archived_at = (
          SELECT ended_at
          FROM neon_sessions
          WHERE neon_sessions.id = chat_sessions.id
        ),
        updated_at = (
          SELECT updated_at
          FROM neon_sessions
          WHERE neon_sessions.id = chat_sessions.id
        )
      WHERE EXISTS (
        SELECT 1
        FROM neon_sessions
        WHERE neon_sessions.id = chat_sessions.id
      );
    `,
    )
    .run();

  database
    .prepare(
      `
      UPDATE chat_sessions
      SET context_loaded_at = COALESCE(context_loaded_at, created_at);
    `,
    )
    .run();

  database
    .prepare(
      `
      INSERT OR IGNORE INTO chat_session_surfaces (surface, session_id, updated_at)
      SELECT 'dashboard', id, datetime('now')
      FROM chat_sessions
      WHERE archived_at IS NULL
      ORDER BY last_active_at DESC, created_at DESC
      LIMIT 1;
    `,
    )
    .run();
}

function reconcileActiveChatSession(database: DatabaseSync) {
  const active = database
    .prepare(
      `
      SELECT session_id
      FROM chat_session_surfaces
      WHERE surface = 'dashboard'
      LIMIT 1;
    `,
    )
    .get() as { session_id?: unknown } | undefined;

  if (typeof active?.session_id === 'string') {
    const row = database
      .prepare(
        `
        SELECT id
        FROM chat_sessions
        WHERE id = ?
          AND archived_at IS NULL;
      `,
      )
      .get(active.session_id);
    if (row) return;
  }

  const fallback = database
    .prepare(
      `
      SELECT id
      FROM chat_sessions
      WHERE archived_at IS NULL
      ORDER BY pinned DESC, last_active_at DESC, created_at DESC
      LIMIT 1;
    `,
    )
    .get() as { id?: unknown } | undefined;

  if (typeof fallback?.id !== 'string') return;
  database
    .prepare(
      `
      INSERT INTO chat_session_surfaces (surface, session_id, updated_at)
      VALUES ('dashboard', ?, datetime('now'))
      ON CONFLICT(surface) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at;
    `,
    )
    .run(fallback.id);
}

function ensureColumn(
  database: DatabaseSync,
  table: string,
  column: string,
  definition: string,
) {
  const columns = database
    .prepare(`PRAGMA table_info(${table});`)
    .all() as Array<{ name?: unknown }>;
  if (columns.some((item) => item.name === column)) {
    return;
  }

  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function migrateMemoriesRepoIdentity(database: DatabaseSync) {
  const table = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'memories';
    `,
    )
    .get() as { sql?: unknown } | undefined;
  const sql = typeof table?.sql === 'string' ? table.sql : '';
  if (!/UNIQUE\s*\(\s*scope\s*,\s*key\s*\)/i.test(sql)) return;

  database.exec(`
    DROP TABLE IF EXISTS memories_repo_identity_migration;

    CREATE TABLE memories_repo_identity_migration (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      repo_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO memories_repo_identity_migration (
      id,
      scope,
      key,
      value_json,
      repo_id,
      status,
      use_count,
      last_used_at,
      created_at,
      updated_at
    )
    SELECT
      id,
      scope,
      key,
      value_json,
      repo_id,
      COALESCE(status, 'active'),
      COALESCE(use_count, 0),
      last_used_at,
      created_at,
      updated_at
    FROM memories;

    DROP TABLE memories;
    ALTER TABLE memories_repo_identity_migration RENAME TO memories;
  `);
}

function migrateMemoryEvents(database: DatabaseSync) {
  const columns = database
    .prepare('PRAGMA table_info(memory_events);')
    .all() as Array<{ name?: unknown; type?: unknown }>;
  const id = columns.find((item) => item.name === 'id');
  const hasCreatedAt = columns.some((item) => item.name === 'created_at');
  if (String(id?.type ?? '').toUpperCase() === 'TEXT' && hasCreatedAt) {
    return;
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS memory_events_v2 (
      id TEXT PRIMARY KEY,
      memory_id TEXT,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO memory_events_v2 (
      id,
      memory_id,
      action,
      actor,
      reason,
      before_json,
      after_json,
      created_at
    )
    SELECT
      lower(hex(randomblob(4))) || '-' ||
        lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(6))),
      NULL,
      CASE
        WHEN action = 'upsert' THEN 'updated'
        WHEN action = 'delete' THEN 'archived'
        ELSE action
      END,
      'neon',
      NULL,
      NULL,
      CASE
        WHEN scope IS NOT NULL AND key IS NOT NULL THEN
          json_object('scope', scope, 'key', key)
        ELSE NULL
      END,
      COALESCE(changed_at, datetime('now'))
    FROM memory_events
    WHERE NOT EXISTS (
      SELECT 1
      FROM memory_events_v2
      WHERE memory_events_v2.id = CAST(memory_events.id AS TEXT)
    );

    DROP TABLE memory_events;
    ALTER TABLE memory_events_v2 RENAME TO memory_events;
  `);
}

function reconcileExistingNotificationDuplicates(database: DatabaseSync) {
  const now = new Date().toISOString();
  const groups = database
    .prepare(
      `
      SELECT source, source_id, COUNT(*) AS count
      FROM notifications
      WHERE source IS NOT NULL
        AND source_id IS NOT NULL
        AND resolved_at IS NULL
      GROUP BY source, source_id
      HAVING COUNT(*) > 1;
    `,
    )
    .all() as Array<{
    source: string;
    source_id: string;
    count: number;
  }>;

  for (const group of groups) {
    const rows = database
      .prepare(
        `
        SELECT id
        FROM notifications
        WHERE source = ?
          AND source_id = ?
          AND resolved_at IS NULL
        ORDER BY updated_at DESC, created_at DESC;
      `,
      )
      .all(group.source, group.source_id) as Array<{ id: string }>;
    const [active, ...duplicates] = rows;
    if (!active || duplicates.length === 0) continue;

    database
      .prepare(
        `
        UPDATE notifications
        SET occurrence_count = MAX(occurrence_count, ?), updated_at = ?
        WHERE id = ?;
      `,
      )
      .run(Number(group.count), now, active.id);

    const placeholders = duplicates.map(() => '?').join(', ');
    database
      .prepare(
        `
        UPDATE notifications
        SET resolved_at = ?, read_at = COALESCE(read_at, ?), updated_at = ?
        WHERE id IN (${placeholders});
      `,
      )
      .run(now, now, now, ...duplicates.map((row) => row.id));
  }
}

function reconcileActiveWorktreeLocks(database: DatabaseSync) {
  const now = new Date().toISOString();
  const groups = database
    .prepare(
      `
      SELECT scope_key, COUNT(*) AS count
      FROM worktree_locks
      WHERE released_at IS NULL
      GROUP BY scope_key
      HAVING COUNT(*) > 1;
    `,
    )
    .all() as Array<{ scope_key: string; count: number }>;

  for (const group of groups) {
    const rows = database
      .prepare(
        `
        SELECT id
        FROM worktree_locks
        WHERE scope_key = ?
          AND released_at IS NULL
        ORDER BY expires_at DESC, created_at DESC;
      `,
      )
      .all(group.scope_key) as Array<{ id: string }>;
    for (const row of rows.slice(1)) {
      database
        .prepare(
          `
          UPDATE worktree_locks
          SET released_at = ?, stale_recovered_at = ?, updated_at = ?
          WHERE id = ?
            AND released_at IS NULL;
        `,
        )
        .run(now, now, now, row.id);
    }
  }
}

function reconcileActiveNeonSessions(database: DatabaseSync) {
  const now = new Date().toISOString();
  const active = database
    .prepare(
      `
      SELECT id
      FROM neon_sessions
      WHERE agent_name = 'display-assistant'
        AND status = 'active'
      ORDER BY activated_at DESC, created_at DESC;
    `,
    )
    .all() as Array<{ id: string }>;
  const [, ...duplicates] = active;
  if (duplicates.length === 0) return;

  const placeholders = duplicates.map(() => '?').join(', ');
  database
    .prepare(
      `
      UPDATE neon_sessions
      SET status = 'archived', ended_at = ?, updated_at = ?
      WHERE id IN (${placeholders});
    `,
    )
    .run(now, now, ...duplicates.map((session) => session.id));
}

function initializeFlueDatabase(path: string) {
  const database = new DatabaseSync(path);
  database.close();
}

function parseJson<T>(
  source: string,
  path: string,
  parse: (value: unknown, path: string) => T,
) {
  try {
    return parse(JSON.parse(source) as unknown, path);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigValidationError(path, message);
  }
}

export function parseAppConfig(value: unknown, path: string): AppConfig {
  return parseSchema(appConfigSchema, value, path);
}

export function parseRepoRegistry(value: unknown, path: string): RepoRegistry {
  return parseSchema(repoRegistrySchema, value, path);
}

export function parseScheduleConfig(
  value: unknown,
  path: string,
): ScheduleConfig {
  return parseSchema(scheduleConfigSchema, value, path);
}

export function parseDashboardConfig(
  value: unknown,
  path: string,
): DashboardConfig {
  const config = parseSchema(dashboardConfigSchema, value, path);
  validateDashboardConfig(config, path);
  return config;
}

function validateDashboardConfig(config: DashboardConfig, path: string) {
  const regionIds = new Set<string>();

  for (const region of config.layout.regions) {
    if (regionIds.has(region.id)) {
      throw new ConfigValidationError(
        path,
        `Duplicate dashboard region id "${region.id}".`,
      );
    }
    regionIds.add(region.id);

    const columnEnd = region.column + region.columnSpan - 1;
    if (columnEnd > config.layout.columns) {
      throw new ConfigValidationError(
        path,
        `Dashboard region "${region.id}" exceeds layout column count ${config.layout.columns}.`,
      );
    }

    const rowEnd = region.row + region.rowSpan - 1;
    if (rowEnd > config.layout.rows) {
      throw new ConfigValidationError(
        path,
        `Dashboard region "${region.id}" exceeds layout row count ${config.layout.rows}.`,
      );
    }

    const tabIds = new Set<string>();
    for (const tab of region.tabs) {
      if (tabIds.has(tab.id)) {
        throw new ConfigValidationError(
          path,
          `Duplicate dashboard tab id "${tab.id}" in region "${region.id}".`,
        );
      }
      tabIds.add(tab.id);
    }

    if (region.defaultTab && !tabIds.has(region.defaultTab)) {
      throw new ConfigValidationError(
        path,
        `Dashboard region "${region.id}" defaultTab "${region.defaultTab}" does not match a tab id.`,
      );
    }
  }
}

function parseSchema<T>(
  schema: v.GenericSchema<unknown, T>,
  value: unknown,
  path: string,
): T {
  const result = v.safeParse(schema, value);

  if (result.success) {
    return result.output;
  }

  throw new ConfigValidationError(path, v.summarize(result.issues));
}
