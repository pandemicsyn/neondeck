import * as v from 'valibot';
import { mcpConfigSchema, type McpConfig } from '../domains/mcp/schemas';

function hasShellOperator(value: string) {
  return /(?:\n|&&|\|\||[;&|<>`]|\$\()/.test(value);
}

const unknownRecordSchema = v.record(v.string(), v.unknown());
const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
const positiveIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const dashboardDensitySchema = v.picklist(['compact', 'comfortable', 'large']);
const dashboardTextScaleSchema = v.pipe(
  v.number(),
  v.minValue(0.9),
  v.maxValue(1.75),
);
const dashboardWindowProfileSchema = v.pipe(
  v.strictObject({
    width: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    height: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    x: v.optional(v.pipe(v.number(), v.integer())),
    y: v.optional(v.pipe(v.number(), v.integer())),
    kiosk: v.optional(v.boolean()),
  }),
  v.check(
    (value) => (value.width === undefined) === (value.height === undefined),
    'Window profiles must set width and height together.',
  ),
  v.check(
    (value) => (value.x === undefined) === (value.y === undefined),
    'Window profiles must set x and y together.',
  ),
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
  pushOnApproval: v.optional(v.picklist(['push', 'verify-then-push', 'off'])),
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
  windows: v.optional(
    v.record(nonEmptyStringSchema, dashboardWindowProfileSchema),
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
export type { McpConfig };
export type RepoConfig = v.InferOutput<typeof repoConfigSchema>;
export type RepoRegistry = v.InferOutput<typeof repoRegistrySchema>;
export type ScheduleEntry = v.InferOutput<typeof scheduleEntrySchema>;
export type ScheduleConfig = v.InferOutput<typeof scheduleConfigSchema>;
export type DashboardConfig = v.InferOutput<typeof dashboardConfigSchema>;
export type DashboardWindowProfile = v.InferOutput<
  typeof dashboardWindowProfileSchema
>;
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

export function parseAppConfig(value: unknown, path: string): AppConfig {
  return parseSchema(appConfigSchema, value, path);
}

export function parseMcpConfig(value: unknown, path: string): McpConfig {
  return parseSchema(mcpConfigSchema, value, path);
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
