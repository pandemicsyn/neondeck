import * as v from 'valibot';

export type RuntimeStatusLevel = 'ready' | 'needs-config' | 'attention';

export type RuntimeStatusCheck = {
  id: string;
  label: string;
  ok: boolean;
  level: RuntimeStatusLevel;
  message: string;
};

const runtimeStatusLevelSchema = v.picklist([
  'ready',
  'needs-config',
  'attention',
]);

export const runtimeStatusSchema = v.looseObject({
  ok: v.boolean(),
  status: runtimeStatusLevelSchema,
  service: v.literal('neondeck'),
  home: v.string(),
  paths: v.object({
    env: v.string(),
    config: v.string(),
    mcp: v.string(),
    repos: v.string(),
    dashboard: v.string(),
    skills: v.string(),
    worktrees: v.string(),
    neondeckDatabase: v.string(),
    flueDatabase: v.string(),
  }),
  uptimeSeconds: v.number(),
  providers: v.object({
    registered: v.array(v.string()),
    credentials: v.object({
      kilo: v.boolean(),
      openai: v.boolean(),
      anthropic: v.boolean(),
      github: v.boolean(),
    }),
    configs: v.object({
      kilocode: v.object({
        enabled: v.boolean(),
        apiKeyEnv: v.string(),
        organizationIdEnv: v.nullable(v.string()),
        apiKeyPresent: v.boolean(),
        organizationIdPresent: v.boolean(),
      }),
      openai: v.object({
        enabled: v.boolean(),
        apiKeyEnv: v.string(),
        apiKeyPresent: v.boolean(),
      }),
      anthropic: v.object({
        enabled: v.boolean(),
        apiKeyEnv: v.string(),
        apiKeyPresent: v.boolean(),
      }),
    }),
  }),
  models: v.object({
    displayAssistant: v.string(),
    displayAssistantProvider: v.string(),
    displayAssistantThinkingLevel: v.string(),
    utility: v.string(),
    utilityProvider: v.string(),
    utilityThinkingLevel: v.string(),
    utilityConfigured: v.boolean(),
    utilityRecommendation: v.nullable(v.string()),
    selfImprovement: v.string(),
    selfImprovementProvider: v.string(),
    selfImprovementThinkingLevel: v.string(),
    selfImprovementConfigured: v.boolean(),
    subagents: v.record(v.string(), v.string()),
    subagentThinkingLevels: v.record(v.string(), v.string()),
  }),
  execution: v.object({
    defaultBackend: v.string(),
    enabledBackends: v.array(v.string()),
    supportedBackends: v.array(v.string()),
    approvalMode: v.string(),
    unattended: v.string(),
    preapprovedCommandCount: v.number(),
  }),
  session: v.object({
    id: v.string(),
    label: v.string(),
    stale: v.boolean(),
    staleReasons: v.array(
      v.object({
        type: v.picklist([
          'config',
          'memory',
          'model',
          'provider',
          'repo',
          'skill',
          'soul',
        ]),
        message: v.string(),
        changedAt: v.string(),
        target: v.nullable(v.string()),
      }),
    ),
    activatedAt: v.string(),
  }),
  counts: v.object({
    repos: v.number(),
    activeSchedules: v.number(),
    activeJobs: v.number(),
    activeWatches: v.number(),
    activeSkills: v.number(),
    duplicateSkills: v.number(),
    ignoredSkills: v.number(),
    failedWorkflowSummaries: v.number(),
    flueFailureNotifications: v.number(),
    activeWorktrees: v.number(),
    staleWorktreeLocks: v.number(),
    worktreeCleanupFailures: v.number(),
    mcpServers: v.number(),
    mcpConnectedServers: v.number(),
    mcpNeedsLoginServers: v.number(),
  }),
  checks: v.array(
    v.object({
      id: v.string(),
      label: v.string(),
      ok: v.boolean(),
      level: runtimeStatusLevelSchema,
      message: v.string(),
    }),
  ),
  lastFlueErrors: v.array(
    v.object({
      id: v.string(),
      source: v.picklist(['workflow-summary', 'notification']),
      title: v.string(),
      message: v.string(),
      runId: v.nullable(v.string()),
      createdAt: v.string(),
    }),
  ),
  fetchedAt: v.string(),
});

export type RuntimeStatus = v.InferOutput<typeof runtimeStatusSchema>;
