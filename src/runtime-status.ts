import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as v from 'valibot';
import { resolveAgentModelSelection } from './agent-config';
import {
  isRegisteredProvider,
  registeredProviderIds,
  resolveKilocodeProviderStatus,
} from './providers';
import {
  type RuntimePaths,
  parseAppConfig,
  parseRepoRegistry,
  parseScheduleConfig,
  readRuntimeJson,
  runtimePaths,
} from './runtime-home';
import { executionPolicyFromConfig } from './execution-policy';
import { listRuntimeSkills } from './runtime-skills';
import { readNeonSessionState } from './session-actions';

export type RuntimeStatusLevel = 'ready' | 'needs-config' | 'attention';

export type RuntimeStatusCheck = {
  id: string;
  label: string;
  ok: boolean;
  level: RuntimeStatusLevel;
  message: string;
};

export type RuntimeStatus = v.InferOutput<typeof runtimeStatusSchema>;

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
    config: v.string(),
    repos: v.string(),
    schedules: v.string(),
    dashboard: v.string(),
    skills: v.string(),
    neondeckDatabase: v.string(),
    flueDatabase: v.string(),
  }),
  uptimeSeconds: v.number(),
  providers: v.object({
    registered: v.array(v.string()),
    credentials: v.object({
      kilo: v.boolean(),
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
    }),
  }),
  models: v.object({
    displayAssistant: v.string(),
    displayAssistantProvider: v.string(),
    subagents: v.record(v.string(), v.string()),
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
        type: v.picklist(['config', 'memory']),
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

type SafeResult<T> = { ok: true; value: T } | { ok: false; error: string };

type AppDatabaseSnapshot = {
  ok: boolean;
  message: string;
  counts: {
    activeJobs: number;
    activeWatches: number;
    recentFailedWorkflowSummaries: number;
    unreadFlueFailureNotifications: number;
  };
  errors: RuntimeStatus['lastFlueErrors'];
};

const flueFailureWindowMs = 24 * 60 * 60 * 1000;

export async function readRuntimeStatus(
  paths: RuntimePaths = runtimePaths(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeStatus> {
  const [config, repos, schedules, skills, session] = await Promise.all([
    safeRead(() => readRuntimeJson(paths.config, parseAppConfig)),
    safeRead(() => readRuntimeJson(paths.repos, parseRepoRegistry)),
    safeRead(() => readRuntimeJson(paths.schedules, parseScheduleConfig)),
    safeRead(() => listRuntimeSkills(paths)),
    safeRead(() => readNeonSessionState(paths)),
  ]);
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
  const executionPolicy = executionPolicyFromConfig({
    execution: config.ok ? config.value.execution : undefined,
  });
  const modelProviders = requiredModelProviders(models);
  const kiloKey = kilocodeProvider.enabled && kilocodeProvider.apiKeyPresent;
  const githubToken = Boolean(env.GITHUB_TOKEN);
  const activeSchedules = schedules.ok
    ? schedules.value.schedules.filter((schedule) => schedule.enabled ?? true)
    : [];
  const activeSkills = skills.ok
    ? skills.value.skills.filter((skill) => skill.status === 'active')
    : [];
  const providerIssues = modelProviders.filter(
    (provider) => !isRegisteredProvider(provider),
  );
  const disabledProviderIssues = modelProviders.filter(
    (provider) => provider === 'kilocode' && !kilocodeProvider.enabled,
  );
  const checks = [
    configCheck('config', 'Runtime config', paths.config, config),
    configCheck('repos-config', 'Repo config', paths.repos, repos),
    configCheck(
      'schedules-config',
      'Schedule config',
      paths.schedules,
      schedules,
    ),
    configCheck('skills', 'Runtime skills', paths.skills, skills),
    check(
      'session-context',
      'Session context',
      session.ok && !session.value.stale,
      'needs-config',
      session.ok
        ? session.value.stale
          ? `${session.value.staleReasons.length} context change${session.value.staleReasons.length === 1 ? '' : 's'} require a new session.`
          : `Active session ${session.value.activeSession.id} is current.`
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
      config: paths.config,
      repos: paths.repos,
      schedules: paths.schedules,
      dashboard: paths.dashboard,
      skills: paths.skills,
      neondeckDatabase: paths.neondeckDatabase,
      flueDatabase: paths.flueDatabase,
    },
    uptimeSeconds: Math.round(process.uptime()),
    providers: {
      registered: [...registeredProviderIds],
      credentials: {
        kilo: kiloKey,
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
      },
    },
    models: {
      displayAssistant: models.displayAssistant,
      displayAssistantProvider: providerFromModel(models.displayAssistant),
      subagents: models.subagents,
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
          id: session.value.activeSession.id,
          label: session.value.activeSession.label,
          stale: session.value.stale,
          staleReasons: session.value.staleReasons,
          activatedAt: session.value.activeSession.activatedAt,
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
      activeSchedules: activeSchedules.length,
      activeJobs: appDatabase.counts.activeJobs,
      activeWatches: appDatabase.counts.activeWatches,
      activeSkills: activeSkills.length,
      duplicateSkills: skills.ok ? skills.value.duplicates.length : 0,
      ignoredSkills: skills.ok ? skills.value.ignored.length : 0,
      failedWorkflowSummaries: appDatabase.counts.recentFailedWorkflowSummaries,
      flueFailureNotifications:
        appDatabase.counts.unreadFlueFailureNotifications,
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

function statusFromChecks(checks: RuntimeStatusCheck[]): RuntimeStatusLevel {
  if (checks.some((item) => !item.ok && item.level === 'attention')) {
    return 'attention';
  }

  if (checks.some((item) => !item.ok && item.level === 'needs-config')) {
    return 'needs-config';
  }

  return 'ready';
}

function inspectAppDatabase(paths: RuntimePaths): AppDatabaseSnapshot {
  if (!existsSync(paths.neondeckDatabase)) {
    return emptyDatabaseSnapshot('Neondeck app database is missing.');
  }

  const cutoff = new Date(Date.now() - flueFailureWindowMs).toISOString();
  const database = new DatabaseSync(paths.neondeckDatabase, { readOnly: true });

  try {
    const activeJobs = count(
      database,
      'SELECT COUNT(*) AS count FROM jobs WHERE enabled = 1;',
    );
    const activeWatches = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM pr_watches
        WHERE status IN ('watching', 'merged', 'attention-needed');
      `,
    );
    const recentFailedWorkflowSummaries = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM workflow_summaries
        WHERE status = 'failed'
          AND created_at >= ?;
      `,
      cutoff,
    );
    const unreadFlueFailureNotifications = count(
      database,
      `
        SELECT COUNT(*) AS count
        FROM notifications
        WHERE source = 'flue'
          AND resolved_at IS NULL;
      `,
    );
    const errors = [
      ...database
        .prepare(
          `
          SELECT id, workflow, run_id, summary_json, created_at
          FROM workflow_summaries
          WHERE status = 'failed'
            AND created_at >= ?
          ORDER BY created_at DESC
          LIMIT 5;
        `,
        )
        .all(cutoff)
        .map(readWorkflowErrorRow),
      ...database
        .prepare(
          `
          SELECT id, title, message, source_id, created_at
          FROM notifications
          WHERE source = 'flue'
            AND resolved_at IS NULL
          ORDER BY created_at DESC
          LIMIT 5;
        `,
        )
        .all()
        .map(readNotificationErrorRow),
    ]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 5);

    return {
      ok: true,
      message: 'Neondeck app database is readable.',
      counts: {
        activeJobs,
        activeWatches,
        recentFailedWorkflowSummaries,
        unreadFlueFailureNotifications,
      },
      errors,
    };
  } catch (error) {
    return emptyDatabaseSnapshot(
      `Neondeck app database could not be inspected: ${errorMessage(error)}.`,
    );
  } finally {
    database.close();
  }
}

function inspectFlueDatabase(paths: RuntimePaths) {
  if (!existsSync(paths.flueDatabase)) {
    return { ok: false, message: 'Flue runtime database is missing.' };
  }

  const database = new DatabaseSync(paths.flueDatabase, { readOnly: true });

  try {
    database.prepare('SELECT name FROM sqlite_master LIMIT 1;').get();
    return { ok: true, message: 'Flue runtime database is readable.' };
  } catch (error) {
    return {
      ok: false,
      message: `Flue runtime database could not be inspected: ${errorMessage(error)}.`,
    };
  } finally {
    database.close();
  }
}

function emptyDatabaseSnapshot(message: string): AppDatabaseSnapshot {
  return {
    ok: false,
    message,
    counts: {
      activeJobs: 0,
      activeWatches: 0,
      recentFailedWorkflowSummaries: 0,
      unreadFlueFailureNotifications: 0,
    },
    errors: [],
  };
}

function count(database: DatabaseSync, sql: string, ...values: string[]) {
  const row = database.prepare(sql).get(...values) as
    { count?: unknown } | undefined;
  return Number(row?.count ?? 0);
}

function readWorkflowErrorRow(row: unknown) {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    source: 'workflow-summary' as const,
    title: String(record.workflow),
    message: workflowSummaryMessage(record.summary_json, record.workflow),
    runId: typeof record.run_id === 'string' ? record.run_id : null,
    createdAt: String(record.created_at),
  };
}

function readNotificationErrorRow(row: unknown) {
  const record = row as Record<string, unknown>;
  return {
    id: String(record.id),
    source: 'notification' as const,
    title: String(record.title),
    message: String(record.message),
    runId: typeof record.source_id === 'string' ? record.source_id : null,
    createdAt: String(record.created_at),
  };
}

function workflowSummaryMessage(summaryJson: unknown, workflow: unknown) {
  if (typeof summaryJson === 'string') {
    try {
      const summary = JSON.parse(summaryJson) as unknown;
      if (
        summary &&
        typeof summary === 'object' &&
        !Array.isArray(summary) &&
        typeof (summary as { message?: unknown }).message === 'string'
      ) {
        return (summary as { message: string }).message;
      }
    } catch {
      return `${String(workflow)} failed.`;
    }
  }

  return `${String(workflow)} failed.`;
}

function requiredModelProviders(models: {
  displayAssistant: string;
  subagents: Record<string, string>;
}) {
  return Array.from(
    new Set([
      providerFromModel(models.displayAssistant),
      ...Object.values(models.subagents).map(providerFromModel),
    ]),
  );
}

function providerFromModel(model: string) {
  return model.includes('/') ? model.split('/')[0] : 'default';
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}
