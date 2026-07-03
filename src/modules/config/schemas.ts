import { type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { thinkingLevelSchema } from '../../runtime-home';
import { isRegisteredProvider } from '../../providers';

export type ConfigTarget =
  'all' | 'config' | 'repos' | 'dashboard' | 'schedules';

export type ConfigActionResult = {
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

export const configTargetSchema = v.optional(
  v.picklist(['all', 'config', 'repos', 'dashboard', 'schedules']),
  'all',
);

export const stringRecordSchema = v.record(v.string(), v.string());
export const unknownRecordSchema = v.record(v.string(), v.unknown());
export const nonEmptyStringSchema = v.pipe(v.string(), v.minLength(1));
export const providerQualifiedModelSchema = v.pipe(
  nonEmptyStringSchema,
  v.check((value) => {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) return false;
    return isRegisteredProvider(value.slice(0, slash));
  }, 'Expected a provider-qualified model string using a registered provider.'),
);

export const addRepoInputSchema = v.object({
  path: nonEmptyStringSchema,
  id: v.optional(nonEmptyStringSchema),
  githubOwner: v.optional(nonEmptyStringSchema),
  githubName: v.optional(nonEmptyStringSchema),
  defaultBranch: v.optional(nonEmptyStringSchema),
  worktreeRoot: v.optional(v.picklist(['home', 'repo-local'])),
  productionTarget: v.optional(nonEmptyStringSchema),
  packageScripts: v.optional(stringRecordSchema),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

export const updateRepoInputSchema = v.object({
  id: nonEmptyStringSchema,
  path: v.optional(nonEmptyStringSchema),
  githubOwner: v.optional(nonEmptyStringSchema),
  githubName: v.optional(nonEmptyStringSchema),
  defaultBranch: v.optional(nonEmptyStringSchema),
  worktreeRoot: v.optional(v.picklist(['home', 'repo-local'])),
  productionTarget: v.optional(nonEmptyStringSchema),
  packageScripts: v.optional(stringRecordSchema),
  metadata: v.optional(unknownRecordSchema),
  watchRules: v.optional(v.array(v.unknown())),
});

export const removeRepoInputSchema = v.object({
  id: nonEmptyStringSchema,
  confirm: v.optional(v.boolean()),
});

export const scheduleInputSchema = v.object({
  id: nonEmptyStringSchema,
  type: nonEmptyStringSchema,
  enabled: v.optional(v.boolean()),
  timezone: v.optional(nonEmptyStringSchema),
  cron: v.optional(nonEmptyStringSchema),
  preset: v.optional(nonEmptyStringSchema),
  config: v.optional(unknownRecordSchema),
});

export const updateScheduleInputSchema = v.object({
  id: nonEmptyStringSchema,
  type: v.optional(nonEmptyStringSchema),
  enabled: v.optional(v.boolean()),
  timezone: v.optional(nonEmptyStringSchema),
  cron: v.optional(nonEmptyStringSchema),
  preset: v.optional(nonEmptyStringSchema),
  config: v.optional(unknownRecordSchema),
});
export const subagentModelInputSchema = v.object({
  default: v.optional(providerQualifiedModelSchema),
  defaultThinkingLevel: v.optional(thinkingLevelSchema),
  repoResearcher: v.optional(providerQualifiedModelSchema),
  repoResearcherThinkingLevel: v.optional(thinkingLevelSchema),
  ciInvestigator: v.optional(providerQualifiedModelSchema),
  ciInvestigatorThinkingLevel: v.optional(thinkingLevelSchema),
  releaseReviewer: v.optional(providerQualifiedModelSchema),
  releaseReviewerThinkingLevel: v.optional(thinkingLevelSchema),
});
export const updateAgentModelsInputSchema = v.object({
  default: v.optional(providerQualifiedModelSchema),
  defaultThinkingLevel: v.optional(thinkingLevelSchema),
  displayAssistant: v.optional(providerQualifiedModelSchema),
  displayAssistantThinkingLevel: v.optional(thinkingLevelSchema),
  utility: v.optional(v.nullable(providerQualifiedModelSchema)),
  utilityThinkingLevel: v.optional(thinkingLevelSchema),
  selfImprovement: v.optional(v.nullable(providerQualifiedModelSchema)),
  selfImprovementThinkingLevel: v.optional(thinkingLevelSchema),
  subagents: v.optional(subagentModelInputSchema),
});
export const updateLearningConfigInputSchema = v.strictObject({
  enabled: v.optional(v.boolean()),
  memoryWriteMode: v.optional(v.picklist(['off', 'review', 'auto'])),
  skillWriteMode: v.optional(v.picklist(['off', 'review', 'auto'])),
  memoryCurationEnabled: v.optional(v.boolean()),
  memoryCurationMode: v.optional(v.picklist(['off', 'review', 'auto'])),
  conversationReviewTurnInterval: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  memoryCurationTurnInterval: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  prRetrospectiveThreshold: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  notifications: v.optional(v.picklist(['off', 'on'])),
  memoryMaxActiveItems: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  maxRecentTurns: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  maxPrBatchItems: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  memoryPromptBudgetChars: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  userMemoryBudgetChars: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  localMemoryBudgetChars: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
  projectMemoryBudgetChars: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1)),
  ),
});
export const updateSkillRootsInputSchema = v.object({
  skillRoots: v.array(nonEmptyStringSchema),
});
export const worktreeCleanupPolicyInputSchema = v.strictObject({
  retainFailed: v.optional(v.boolean()),
  retainPreparedDiff: v.optional(v.boolean()),
  successfulGraceHours: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0)),
  ),
  staleAgeHours: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});
export const updateWorktreePolicyInputSchema = v.strictObject({
  defaultStorage: v.optional(v.picklist(['home', 'repo-local'])),
  cleanup: v.optional(worktreeCleanupPolicyInputSchema),
  confirm: v.optional(v.boolean()),
});
export const envVarNameSchema = v.pipe(
  v.string(),
  v.regex(/^[A-Z_][A-Z0-9_]*$/, 'Expected an environment variable name.'),
);
export const updateProviderInputSchema = v.object({
  provider: v.picklist(['kilocode', 'openai', 'anthropic']),
  enabled: v.optional(v.boolean()),
  apiKeyEnv: v.optional(v.nullable(envVarNameSchema)),
  organizationIdEnv: v.optional(v.nullable(envVarNameSchema)),
});
export const dashboardPresetSchema = v.object({
  preset: v.picklist(['classic', 'cockpit']),
  statuslinePosition: v.optional(v.picklist(['top', 'bottom'])),
});
export const configActionOutputSchema = v.looseObject({
  ok: v.boolean(),
  action: v.string(),
  changed: v.boolean(),
  message: v.string(),
  home: v.string(),
  files: v.array(v.string()),
});
