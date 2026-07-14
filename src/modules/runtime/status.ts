import { resolveAgentModelSelection } from './agent-config';
import {
  isRegisteredProvider,
  registeredProviderIds,
  resolveAnthropicProviderStatus,
  resolveKilocodeProviderStatus,
  resolveOpenAiProviderStatus,
} from '../repos';
import {
  type RuntimePaths,
  parseAppConfig,
  parseRepoRegistry,
  readRuntimeJson,
  runtimePaths,
} from '../../runtime-home';
import { mcpSnapshotSync } from '../../domains/mcp';
import { mcpServerEnabled, parseMcpConfig } from '../../domains/mcp/schemas';
import { executionPolicyFromConfig } from '../execution-policy';
import { readNeonSessionState } from '../sessions';
import { listRuntimeSkills } from './skills';
import { inspectAppDatabase, inspectFlueDatabase } from './status-database';
import {
  type RuntimeStatus,
  type RuntimeStatusCheck,
  type RuntimeStatusLevel,
} from './status-schema';

type SafeResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function readRuntimeStatus(
  paths: RuntimePaths = runtimePaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeStatus> {
  const [config, mcpConfig, repos, skills, session] = await Promise.all([
    safeRead(() => readRuntimeJson(paths.config, parseAppConfig)),
    safeRead(() => readRuntimeJson(paths.mcp, parseMcpConfig)),
    safeRead(() => readRuntimeJson(paths.repos, parseRepoRegistry)),
    safeRead(() => listRuntimeSkills(paths)),
    safeRead(() => readNeonSessionState(paths)),
  ]);
  const mcpServers = mcpStatusFromConfig(paths, mcpConfig);
  const appDatabase = inspectAppDatabase(paths);
  const flueDatabase = inspectFlueDatabase(paths);
  const models = resolveAgentModelSelection(
    config.ok ? { models: config.value.models } : undefined,
    env,
  );
  const kilocodeProvider = resolveKilocodeProviderStatus(
    config.ok ? { providers: config.value.providers } : undefined,
    env,
  );
  const openaiProvider = resolveOpenAiProviderStatus(
    config.ok ? { providers: config.value.providers } : undefined,
    env,
  );
  const anthropicProvider = resolveAnthropicProviderStatus(
    config.ok ? { providers: config.value.providers } : undefined,
    env,
  );
  const executionPolicy = executionPolicyFromConfig({
    execution: config.ok ? config.value.execution : undefined,
  });
  const modelProviders = requiredModelProviders(models);
  const kiloKey = kilocodeProvider.enabled && kilocodeProvider.apiKeyPresent;
  const openaiKey = openaiProvider.enabled && openaiProvider.apiKeyPresent;
  const anthropicKey =
    anthropicProvider.enabled && anthropicProvider.apiKeyPresent;
  const githubToken = Boolean(env.GITHUB_TOKEN);
  const activeSkills = skills.ok
    ? skills.value.skills.filter((skill) => skill.status === 'active')
    : [];
  const providerIssues = modelProviders.filter(
    (provider) => !isRegisteredProvider(provider),
  );
  const disabledProviderIssues = modelProviders.filter(
    (provider) =>
      providerEnabled(provider, {
        kilocode: kilocodeProvider.enabled,
        openai: openaiProvider.enabled,
        anthropic: anthropicProvider.enabled,
      }) === false,
  );
  const checks = [
    configCheck('config', 'Runtime config', paths.config, config),
    configCheck('mcp-config', 'MCP config', paths.mcp, mcpConfig),
    configCheck('repos-config', 'Repo config', paths.repos, repos),
    configCheck('skills', 'Runtime skills', paths.skills, skills),
    check(
      'session-context',
      'Session context',
      session.ok && !session.value.stale,
      'needs-config',
      session.ok
        ? session.value.stale
          ? `${session.value.staleReasons.length} context change${session.value.staleReasons.length === 1 ? '' : 's'} require a new session.`
          : `Active session ${session.value.activeChatSession.id} is current.`
        : 'Session state could not be read.',
    ),
    check(
      'kilo-key',
      'Kilo key',
      !modelProviders.includes('kilocode') || kiloKey,
      'needs-config',
      kiloKey
        ? 'Kilo provider credentials are present.'
        : kilocodeProvider.enabled
          ? `${kilocodeProvider.apiKeyEnv} is not configured.`
          : 'Kilo provider is disabled in config.json.',
    ),
    check(
      'openai-key',
      'OpenAI key',
      !modelProviders.includes('openai') || openaiKey,
      'needs-config',
      openaiKey
        ? 'OpenAI provider credentials are present.'
        : openaiProvider.enabled
          ? `${openaiProvider.apiKeyEnv} is not configured.`
          : 'OpenAI provider is disabled in config.json.',
    ),
    check(
      'anthropic-key',
      'Anthropic key',
      !modelProviders.includes('anthropic') || anthropicKey,
      'needs-config',
      anthropicKey
        ? 'Anthropic provider credentials are present.'
        : anthropicProvider.enabled
          ? `${anthropicProvider.apiKeyEnv} is not configured.`
          : 'Anthropic provider is disabled in config.json.',
    ),
    check(
      'github-token',
      'GitHub token',
      githubToken,
      'needs-config',
      githubToken
        ? 'GitHub API credentials are present.'
        : 'GITHUB_TOKEN is not configured.',
    ),
    check(
      'model-providers',
      'Model providers',
      providerIssues.length === 0 && disabledProviderIssues.length === 0,
      'attention',
      providerIssues.length === 0 && disabledProviderIssues.length === 0
        ? `Configured models use registered providers: ${modelProviders.join(', ')}.`
        : [
            providerIssues.length > 0
              ? `Unregistered model provider${providerIssues.length === 1 ? '' : 's'}: ${providerIssues.join(', ')}.`
              : null,
            disabledProviderIssues.length > 0
              ? `Disabled model provider${disabledProviderIssues.length === 1 ? '' : 's'}: ${disabledProviderIssues.join(', ')}.`
              : null,
          ]
            .filter((item): item is string => !!item)
            .join(' '),
    ),
    check(
      'utility-model',
      'Utility model',
      true,
      'needs-config',
      models.utilityConfigured
        ? `Utility model is configured as ${models.utility}.`
        : `Utility model is not configured; falling back to ${models.displayAssistant}. Configure a low-cost model for short summaries, labels, and notifications.`,
    ),
    check(
      'execution-policy',
      'Execution policy',
      executionPolicy.enabledBackends.length > 0,
      'needs-config',
      executionPolicy.enabledBackends.length > 0
        ? `Host execution policy defaults to ${executionPolicy.defaultBackend}; ${executionPolicy.preapprovedCommands.length} commands are preapproved.`
        : 'No execution backends are enabled.',
    ),
    check(
      'repos',
      'Repositories',
      repos.ok && repos.value.repos.length > 0,
      repos.ok ? 'needs-config' : 'attention',
      repos.ok
        ? repos.value.repos.length > 0
          ? `${repos.value.repos.length} repositories are configured.`
          : 'No repositories are configured.'
        : 'Repository config could not be read.',
    ),
    check(
      'flue-errors',
      'Recent Flue failures',
      appDatabase.counts.recentFailedWorkflowSummaries === 0 &&
        appDatabase.counts.unreadFlueFailureNotifications === 0,
      'attention',
      appDatabase.counts.recentFailedWorkflowSummaries === 0 &&
        appDatabase.counts.unreadFlueFailureNotifications === 0
        ? 'No recent unresolved Flue failures are recorded.'
        : `${appDatabase.counts.recentFailedWorkflowSummaries + appDatabase.counts.unreadFlueFailureNotifications} recent unresolved Flue failure signals are recorded.`,
    ),
    check(
      'worktree-cleanup',
      'Worktree cleanup',
      appDatabase.counts.worktreeCleanupFailures === 0,
      'attention',
      appDatabase.counts.worktreeCleanupFailures === 0
        ? `${appDatabase.counts.activeWorktrees} active worktree${appDatabase.counts.activeWorktrees === 1 ? '' : 's'}; no cleanup failures.`
        : `${appDatabase.counts.worktreeCleanupFailures} worktree cleanup failure${appDatabase.counts.worktreeCleanupFailures === 1 ? '' : 's'} recorded.`,
    ),
    check(
      'worktree-locks',
      'Worktree locks',
      appDatabase.counts.staleWorktreeLocks === 0,
      'attention',
      appDatabase.counts.staleWorktreeLocks === 0
        ? 'No stale worktree locks are recorded.'
        : `${appDatabase.counts.staleWorktreeLocks} stale worktree lock${appDatabase.counts.staleWorktreeLocks === 1 ? '' : 's'} need recovery.`,
    ),
    check(
      'mcp-servers',
      'MCP servers',
      mcpConfig.ok &&
        mcpServers.every(
          (server) =>
            !server.enabled ||
            server.status === 'connected' ||
            server.status === 'disabled',
        ),
      'attention',
      mcpConfig.ok
        ? mcpServers.length === 0
          ? 'No MCP servers are configured.'
          : `${mcpServers.filter((server) => server.status === 'connected').length}/${mcpServers.length} MCP servers connected; ${mcpServers.filter((server) => server.status === 'needs-login').length} need login.`
        : 'MCP config could not be read.',
    ),
    check(
      'app-db-migrations',
      'App database migrations',
      appDatabase.migrations.ok,
      'attention',
      appDatabase.migrations.message,
    ),
    check(
      'app-db',
      'App database',
      appDatabase.ok,
      'attention',
      appDatabase.message,
    ),
    check(
      'flue-db',
      'Flue database',
      flueDatabase.ok,
      'attention',
      flueDatabase.message,
    ),
  ];
  const status = statusFromChecks(checks);

  return {
    ok: status === 'ready',
    status,
    service: 'neondeck',
    home: paths.home,
    paths: {
      env: paths.env,
      config: paths.config,
      mcp: paths.mcp,
      repos: paths.repos,
      dashboard: paths.dashboard,
      skills: paths.skills,
      worktrees: paths.worktrees,
      neondeckDatabase: paths.neondeckDatabase,
      flueDatabase: paths.flueDatabase,
    },
    uptimeSeconds: Math.round(process.uptime()),
    providers: {
      registered: [...registeredProviderIds],
      credentials: {
        kilo: kiloKey,
        openai: openaiKey,
        anthropic: anthropicKey,
        github: githubToken,
      },
      configs: {
        kilocode: {
          enabled: kilocodeProvider.enabled,
          apiKeyEnv: kilocodeProvider.apiKeyEnv,
          organizationIdEnv: kilocodeProvider.organizationIdEnv,
          apiKeyPresent: kilocodeProvider.apiKeyPresent,
          organizationIdPresent: kilocodeProvider.organizationIdPresent,
        },
        openai: {
          enabled: openaiProvider.enabled,
          apiKeyEnv: openaiProvider.apiKeyEnv,
          apiKeyPresent: openaiProvider.apiKeyPresent,
        },
        anthropic: {
          enabled: anthropicProvider.enabled,
          apiKeyEnv: anthropicProvider.apiKeyEnv,
          apiKeyPresent: anthropicProvider.apiKeyPresent,
        },
      },
    },
    models: {
      displayAssistant: models.displayAssistant,
      displayAssistantProvider: providerFromModel(models.displayAssistant),
      displayAssistantThinkingLevel: models.displayAssistantThinkingLevel,
      utility: models.utility,
      utilityProvider: providerFromModel(models.utility),
      utilityThinkingLevel: models.utilityThinkingLevel,
      utilityConfigured: models.utilityConfigured,
      utilityRecommendation: models.utilityConfigured
        ? null
        : 'Configure models.utility with a low-cost provider-qualified model for bounded utility tasks.',
      selfImprovement: models.selfImprovement,
      selfImprovementProvider: providerFromModel(models.selfImprovement),
      selfImprovementThinkingLevel: models.selfImprovementThinkingLevel,
      selfImprovementConfigured: models.selfImprovementConfigured,
      subagents: models.subagents,
      subagentThinkingLevels: models.subagentThinkingLevels,
    },
    execution: {
      defaultBackend: executionPolicy.defaultBackend,
      enabledBackends: executionPolicy.enabledBackends,
      supportedBackends: executionPolicy.supportedBackends,
      approvalMode: executionPolicy.approvalMode,
      unattended: executionPolicy.unattended,
      preapprovedCommandCount: executionPolicy.preapprovedCommands.length,
    },
    session: session.ok
      ? {
          id: session.value.activeChatSession.id,
          label: session.value.activeChatSession.title,
          stale: session.value.stale,
          staleReasons: session.value.staleReasons,
          activatedAt: session.value.activeChatSession.lastActiveAt,
        }
      : {
          id: 'unknown',
          label: 'Unknown',
          stale: true,
          staleReasons: [
            {
              type: 'config' as const,
              message: session.error,
              changedAt: new Date().toISOString(),
              target: null,
            },
          ],
          activatedAt: new Date().toISOString(),
        },
    counts: {
      repos: repos.ok ? repos.value.repos.length : 0,
      activeSchedules: 0,
      activeJobs: appDatabase.counts.activeScheduledTasks,
      activeWatches: appDatabase.counts.activeWatches,
      activeSkills: activeSkills.length,
      duplicateSkills: skills.ok ? skills.value.duplicates.length : 0,
      ignoredSkills: skills.ok ? skills.value.ignored.length : 0,
      failedWorkflowSummaries: appDatabase.counts.recentFailedWorkflowSummaries,
      flueFailureNotifications:
        appDatabase.counts.unreadFlueFailureNotifications,
      activeWorktrees: appDatabase.counts.activeWorktrees,
      staleWorktreeLocks: appDatabase.counts.staleWorktreeLocks,
      worktreeCleanupFailures: appDatabase.counts.worktreeCleanupFailures,
      mcpServers: mcpServers.length,
      mcpConnectedServers: mcpServers.filter(
        (server) => server.status === 'connected',
      ).length,
      mcpNeedsLoginServers: mcpServers.filter(
        (server) => server.status === 'needs-login',
      ).length,
    },
    checks,
    lastFlueErrors: appDatabase.errors,
    fetchedAt: new Date().toISOString(),
  };
}

async function safeRead<T>(read: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function configCheck<T>(
  id: string,
  label: string,
  path: string,
  result: SafeResult<T>,
): RuntimeStatusCheck {
  return check(
    id,
    label,
    result.ok,
    'attention',
    result.ok ? `${label} is valid.` : `${path}: ${result.error}`,
  );
}

function check(
  id: string,
  label: string,
  ok: boolean,
  level: Exclude<RuntimeStatusLevel, 'ready'>,
  message: string,
): RuntimeStatusCheck {
  return {
    id,
    label,
    ok,
    level: ok ? 'ready' : level,
    message,
  };
}

function mcpStatusFromConfig(
  paths: RuntimePaths,
  config: SafeResult<ReturnType<typeof parseMcpConfig>>,
) {
  if (!config.ok) return [];
  const snapshot = new Map(
    mcpSnapshotSync(paths).map((item) => [item.id, item]),
  );
  return Object.entries(config.value.servers).map(([id, server]) => {
    const cached = snapshot.get(id);
    const enabled = mcpServerEnabled(server);
    const fallbackStatus = !enabled
      ? 'disabled'
      : server.transport === 'http' && server.auth?.kind === 'oauth'
        ? 'needs-login'
        : 'disconnected';
    return {
      id,
      enabled,
      status: cached?.status ?? fallbackStatus,
    };
  });
}

function statusFromChecks(checks: RuntimeStatusCheck[]): RuntimeStatusLevel {
  if (checks.some((item) => !item.ok && item.level === 'attention')) {
    return 'attention';
  }

  if (checks.some((item) => !item.ok && item.level === 'needs-config')) {
    return 'needs-config';
  }

  return 'ready';
}

export function requiredModelProviders(models: {
  displayAssistant: string;
  utility: string;
  selfImprovement: string;
  subagents: Record<string, string>;
}) {
  return Array.from(
    new Set([
      providerFromModel(models.displayAssistant),
      providerFromModel(models.utility),
      providerFromModel(models.selfImprovement),
      ...Object.values(models.subagents).map(providerFromModel),
    ]),
  );
}

function providerFromModel(model: string) {
  return model.includes('/') ? model.split('/')[0] : 'default';
}

function providerEnabled(provider: string, statuses: Record<string, boolean>) {
  return statuses[provider];
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
