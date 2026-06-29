import {
  useQueries,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  getRepoHealth,
  getRepoRegistry,
  getRuntimeStatus,
  getSafetyPolicy,
  getRuntimeSkills,
  getSchedulerJobs,
  getMemories,
  getNotifications,
  getExecutionApprovals,
  getRepoEditEvents,
  getWorkflowObservability,
  markNotificationRead,
  resolveNotification,
  resolveExecutionApproval,
  updateAgentModels,
  updateProvider,
  type ExecutionApproval,
  type ExecutionApprovalsResponse,
  type MemoryRecord,
  type NotificationRecord,
  type NotificationResponse,
  type RepoHealth,
  type RepoHealthResponse,
  type RepoEditEvent,
  type RepoEditEventsResponse,
  type RepoConfig,
  type RepoRegistryResponse,
  type RuntimeStatus,
  type RuntimeStatusCheck,
  type RuntimeSkill,
  type RuntimeSkillsResponse,
  type SafetyPolicy,
  type SafetyPolicyEntry,
  type SchedulerJob,
  type SchedulerJobsResponse,
  type MemoryResponse,
  type WorkflowEventRecord,
  type WorkflowObservability,
} from '../api';
import { EmptyState } from '../App';
import { Badge, ScrollArea } from '../components/ui';
import { useConfigEvents } from '../lib/config-events';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';

type RuntimeOverviewConfig = {
  repoLimit: number;
  jobLimit: number;
  skillLimit: number;
  memoryLimit: number;
  notificationLimit: number;
  workflowEventLimit: number;
  repoEditLimit: number;
};

type RuntimeSnapshot = {
  status: RuntimeStatus;
  repos: RepoConfig[];
  repoHealth: RepoHealthResponse;
  jobs: SchedulerJob[];
  skills: RuntimeSkillsResponse;
  memories: MemoryRecord[];
  notifications: NotificationResponse;
  executionApprovals: ExecutionApprovalsResponse;
  safety: SafetyPolicy;
  workflows: WorkflowObservability;
  repoEditEvents: RepoEditEventsResponse;
  secondaryErrors: string[];
  fetchedAt: string;
};

type SetupStep = {
  action: string;
  docsHref: string;
  docsLabel: string;
  surface: string;
  detail: string;
};

export const RuntimeOverviewPlugin = {
  id: 'runtime-overview',
  title: 'Runtime overview',
  kind: 'data',
  defaultConfig: {
    repoLimit: 5,
    jobLimit: 5,
    skillLimit: 5,
    memoryLimit: 5,
    notificationLimit: 5,
    workflowEventLimit: 6,
    repoEditLimit: 5,
  },
  Component({ config }) {
    const queryClient = useQueryClient();
    const [
      statusQuery,
      registryQuery,
      repoHealthQuery,
      jobsQuery,
      skillsQuery,
      memoriesQuery,
      notificationsQuery,
      executionApprovalsQuery,
      safetyQuery,
      workflowsQuery,
      repoEditEventsQuery,
    ] = useQueries({
      queries: [
        {
          queryKey: queryKeys.runtimeStatus,
          queryFn: getRuntimeStatus,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.repoRegistry,
          queryFn: getRepoRegistry,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.repoHealth,
          queryFn: getRepoHealth,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.schedulerJobs,
          queryFn: getSchedulerJobs,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.runtimeSkills,
          queryFn: getRuntimeSkills,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.memories,
          queryFn: () => getMemories(),
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.notifications,
          queryFn: getNotifications,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.executionApprovals,
          queryFn: () => getExecutionApprovals({ includeResolved: true }),
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.safetyPolicy,
          queryFn: getSafetyPolicy,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.workflowObservability,
          queryFn: getWorkflowObservability,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.repoEditEvents,
          queryFn: getRepoEditEvents,
          refetchInterval: 30_000,
        },
      ],
    });

    useConfigEvents(() => {
      void invalidateRuntimeQueries(queryClient);
    });

    if (statusQuery.isLoading) {
      return (
        <EmptyState title="Runtime loading" detail="Reading backend state." />
      );
    }

    if (statusQuery.error) {
      return (
        <EmptyState
          title="Runtime unavailable"
          detail={queryErrorMessage(statusQuery.error)}
        />
      );
    }

    const status = statusQuery.data;
    if (!status) {
      return <EmptyState title="Runtime unavailable" detail="No data." />;
    }

    const snapshot = runtimeSnapshotFromQueries(status, {
      registry: registryQuery,
      repoHealth: repoHealthQuery,
      jobs: jobsQuery,
      skills: skillsQuery,
      memories: memoriesQuery,
      notifications: notificationsQuery,
      executionApprovals: executionApprovalsQuery,
      safety: safetyQuery,
      workflows: workflowsQuery,
      repoEditEvents: repoEditEventsQuery,
    });

    if (!snapshot) {
      return <EmptyState title="Runtime unavailable" detail="No data." />;
    }

    return (
      <RuntimeView
        config={config}
        onRefresh={() => void invalidateRuntimeQueries(queryClient)}
        snapshot={snapshot}
      />
    );
  },
} satisfies DisplayPlugin<RuntimeOverviewConfig>;

type RuntimeSnapshotQueries = {
  registry: UseQueryResult<RepoRegistryResponse>;
  repoHealth: UseQueryResult<RepoHealthResponse>;
  jobs: UseQueryResult<SchedulerJobsResponse>;
  skills: UseQueryResult<RuntimeSkillsResponse>;
  memories: UseQueryResult<MemoryResponse>;
  notifications: UseQueryResult<NotificationResponse>;
  executionApprovals: UseQueryResult<ExecutionApprovalsResponse>;
  safety: UseQueryResult<SafetyPolicy>;
  workflows: UseQueryResult<WorkflowObservability>;
  repoEditEvents: UseQueryResult<RepoEditEventsResponse>;
};

function runtimeSnapshotFromQueries(
  status: RuntimeStatus,
  queries: RuntimeSnapshotQueries,
): RuntimeSnapshot {
  const errors = [
    queryResultError(queries.registry),
    queryResultError(queries.repoHealth),
    queryResultError(queries.jobs),
    queryResultError(queries.skills),
    queryResultError(queries.memories),
    queryResultError(queries.notifications),
    queryResultError(queries.executionApprovals),
    queryResultError(queries.safety),
    queryResultError(queries.workflows),
    queryResultError(queries.repoEditEvents),
  ].filter((error): error is string => !!error);

  return {
    status,
    repos: queries.registry.data?.repos ?? [],
    repoHealth: queries.repoHealth.data ?? {
      home: status.home,
      path: status.paths.repos,
      repos: [],
      attention: [],
      count: 0,
      fetchedAt: status.fetchedAt,
    },
    jobs: queries.jobs.data?.jobs ?? [],
    skills: queries.skills.data ?? {
      roots: [],
      skills: [],
      ignored: [],
      duplicates: [],
      loadedAt: status.fetchedAt,
    },
    memories: queries.memories.data?.memories ?? [],
    notifications: queries.notifications.data ?? {
      items: [],
      policy: {
        info: 'Passive updates.',
        ready: 'Completed work.',
        attention: 'Actionable failures.',
        urgent: 'Production-facing failures.',
        reconcile: 'Repeated source events are reconciled.',
      },
      fetchedAt: status.fetchedAt,
    },
    executionApprovals: queries.executionApprovals.data ?? {
      ok: false,
      action: 'execution_approvals_list',
      changed: false,
      approvals: [],
      fetchedAt: status.fetchedAt,
    },
    safety: queries.safety.data ?? emptySafetyPolicy(status.fetchedAt),
    workflows: queries.workflows.data ?? emptyWorkflows(),
    repoEditEvents: queries.repoEditEvents.data ?? {
      ok: false,
      action: 'repo_edit_events_list',
      changed: false,
      message: 'Repo edit events unavailable.',
      events: [],
      fetchedAt: status.fetchedAt,
    },
    secondaryErrors: errors,
    fetchedAt: new Date().toISOString(),
  };
}

function queryResultError(result: { error: unknown }) {
  return result.error ? queryErrorMessage(result.error) : undefined;
}

async function invalidateRuntimeQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus }),
    queryClient.invalidateQueries({ queryKey: queryKeys.repoRegistry }),
    queryClient.invalidateQueries({ queryKey: queryKeys.repoHealth }),
    queryClient.invalidateQueries({ queryKey: queryKeys.schedulerJobs }),
    queryClient.invalidateQueries({ queryKey: queryKeys.runtimeSkills }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.workflowObservability,
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.memories }),
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
    queryClient.invalidateQueries({ queryKey: queryKeys.executionApprovals }),
    queryClient.invalidateQueries({ queryKey: queryKeys.safetyPolicy }),
    queryClient.invalidateQueries({ queryKey: queryKeys.repoEditEvents }),
  ]);
}

function RuntimeView({
  config,
  onRefresh,
  snapshot,
}: {
  config: RuntimeOverviewConfig;
  onRefresh: () => void;
  snapshot: RuntimeSnapshot;
}) {
  const activeSkills = snapshot.skills.skills.filter(
    (skill) => skill.status === 'active',
  );
  const enabledJobs = snapshot.jobs.filter((job) => job.enabled);
  const pendingExecutionApprovals =
    snapshot.executionApprovals.approvals.filter(
      (approval) => approval.status === 'pending',
    );
  const recentExecutionApprovals = snapshot.executionApprovals.approvals.slice(
    0,
    5,
  );
  const healthByRepoId = new Map(
    snapshot.repoHealth.repos.map((repo) => [repo.id, repo]),
  );
  const readiness = snapshot.status.status;
  const failedSetupChecks = snapshot.status.checks.filter((check) => !check.ok);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <span className="text-violet">RUNTIME</span>
        <Badge
          className={
            snapshot.status.ok
              ? 'border-primary text-primary'
              : 'border-accent text-accent'
          }
        >
          {snapshot.status.service}:{readiness}
        </Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3">
          <RuntimeHome
            activeSkills={activeSkills.length}
            status={snapshot.status}
            repoCount={snapshot.repos.length}
          />
          <RuntimeSection count={2} title="CONFIG" tone="violet">
            <RuntimeConfigControls
              onRefresh={onRefresh}
              status={snapshot.status}
            />
          </RuntimeSection>
          <RuntimeSection
            count={failedSetupChecks.length}
            title="FIRST RUN"
            tone={failedSetupChecks.length > 0 ? 'accent' : 'primary'}
          >
            <FirstRunSetup checks={failedSetupChecks} />
          </RuntimeSection>
          {snapshot.secondaryErrors.length > 0 ? (
            <RuntimeSection
              count={snapshot.secondaryErrors.length}
              title="PARTIAL DATA"
              tone="accent"
            >
              <div className="space-y-1.5">
                {snapshot.secondaryErrors.map((error) => (
                  <MiniEmpty key={error} label={error} />
                ))}
              </div>
            </RuntimeSection>
          ) : null}
          <RuntimeSection
            count={snapshot.status.checks.filter((check) => !check.ok).length}
            title="READINESS"
            tone="accent"
          >
            <div className="space-y-1.5">
              {snapshot.status.checks.map((check) => (
                <ReadinessRow check={check} key={check.id} />
              ))}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.repos.length}
            title="REPOS"
            tone="primary"
          >
            <div className="space-y-1.5">
              {snapshot.repos.slice(0, config.repoLimit).map((repo) => {
                const health = healthByRepoId.get(repo.id);
                return <RepoRow health={health} key={repo.id} repo={repo} />;
              })}
              {snapshot.repos.length === 0 ? (
                <MiniEmpty label="No repositories configured." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.status.lastFlueErrors.length}
            title="FLUE ERRORS"
            tone="accent"
          >
            <div className="space-y-1.5">
              {snapshot.status.lastFlueErrors.map((error) => (
                <FlueErrorRow
                  error={error}
                  key={`${error.source}:${error.id}`}
                />
              ))}
              {snapshot.status.lastFlueErrors.length === 0 ? (
                <MiniEmpty label="No recent Flue failures." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.notifications.items.length}
            title="NOTIFICATIONS"
            tone="accent"
          >
            <div className="space-y-1.5">
              {snapshot.notifications.items
                .slice(0, config.notificationLimit)
                .map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onRefresh={onRefresh}
                  />
                ))}
              {snapshot.notifications.items.length === 0 ? (
                <MiniEmpty label="No active notifications." />
              ) : null}
              <MiniEmpty label={snapshot.notifications.policy.reconcile} />
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.safety.summary.requiresConfirmation}
            title="SAFETY"
            tone="violet"
          >
            <div className="space-y-1.5">
              <MiniEmpty label={snapshot.safety.confirmationPolicy} />
              <MiniEmpty label={snapshot.safety.hostExecutionPolicy} />
              <MiniEmpty
                label={`Execution defaults to ${snapshot.safety.executionPolicy.defaultBackend}; ${snapshot.safety.executionPolicy.enabledBackends.join(', ')} enabled; ${snapshot.safety.executionPolicy.preapprovedCommandCount} preapproved commands.`}
              />
              {snapshot.safety.entries
                .sort((a, b) => safetyRank(a) - safetyRank(b))
                .slice(0, 8)
                .map((entry) => (
                  <SafetyPolicyRow entry={entry} key={entry.id} />
                ))}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={pendingExecutionApprovals.length}
            title="EXECUTION APPROVALS"
            tone="accent"
          >
            <div className="space-y-1.5">
              {recentExecutionApprovals.map((approval) => (
                <ExecutionApprovalRow
                  approval={approval}
                  key={approval.id}
                  onRefresh={onRefresh}
                />
              ))}
              {recentExecutionApprovals.length === 0 ? (
                <MiniEmpty label="No execution approvals recorded." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.repoEditEvents.events.length}
            title="REPO EDITS"
            tone="violet"
          >
            <div className="space-y-1.5">
              {snapshot.repoEditEvents.events
                .slice(0, config.repoEditLimit)
                .map((event) => (
                  <RepoEditEventRow event={event} key={event.id} />
                ))}
              {snapshot.repoEditEvents.events.length === 0 ? (
                <MiniEmpty label="No repo edits recorded." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.workflows.activeRuns.length}
            title="ACTIVE RUNS"
            tone="primary"
          >
            <div className="space-y-1.5">
              {snapshot.workflows.activeRuns.map((run) => (
                <ActiveRunRow key={run.runId} run={run} />
              ))}
              {snapshot.workflows.activeRuns.length === 0 ? (
                <MiniEmpty label="No active workflow runs observed." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.workflows.recentFailures.length}
            title="FAILED RUNS"
            tone="accent"
          >
            <div className="space-y-1.5">
              {snapshot.workflows.recentFailures
                .slice(0, config.workflowEventLimit)
                .map((event) => (
                  <WorkflowEventRow
                    event={event}
                    key={`failure:${event.id}`}
                    rawLabel
                  />
                ))}
              {snapshot.workflows.recentFailures.length === 0 ? (
                <MiniEmpty label="No recent failed workflow runs." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.workflows.recentData.length}
            title="PROGRESS DATA"
            tone="violet"
          >
            <div className="space-y-1.5">
              {snapshot.workflows.recentData
                .slice(0, config.workflowEventLimit)
                .map((event) => (
                  <WorkflowEventRow event={event} key={`data:${event.id}`} />
                ))}
              {snapshot.workflows.recentData.length === 0 ? (
                <MiniEmpty label="No emitted workflow data yet." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={
              snapshot.workflows.recentLogs.length +
              snapshot.workflows.recentTools.length +
              snapshot.workflows.recentOperations.length
            }
            title="ACTION LOGS"
            tone="primary"
          >
            <div className="space-y-1.5">
              {[
                ...snapshot.workflows.recentLogs,
                ...snapshot.workflows.recentTools,
                ...snapshot.workflows.recentOperations,
              ]
                .sort(
                  (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
                )
                .slice(0, config.workflowEventLimit)
                .map((event) => (
                  <WorkflowEventRow
                    event={event}
                    key={`activity:${event.id}`}
                  />
                ))}
              {snapshot.workflows.recentLogs.length +
                snapshot.workflows.recentTools.length +
                snapshot.workflows.recentOperations.length ===
              0 ? (
                <MiniEmpty label="No action, tool, or operation logs yet." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection count={enabledJobs.length} title="JOBS" tone="accent">
            <div className="space-y-1.5">
              {snapshot.jobs.slice(0, config.jobLimit).map((job) => (
                <JobRow job={job} key={job.id} />
              ))}
              {snapshot.jobs.length === 0 ? (
                <MiniEmpty label="No scheduler jobs recorded." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={snapshot.memories.length}
            title="MEMORY"
            tone="primary"
          >
            <div className="space-y-1.5">
              {snapshot.memories.slice(0, config.memoryLimit).map((memory) => (
                <MemoryRow key={memory.id} memory={memory} />
              ))}
              {snapshot.memories.length === 0 ? (
                <MiniEmpty label="No durable memory recorded." />
              ) : null}
            </div>
          </RuntimeSection>
          <RuntimeSection
            count={activeSkills.length}
            title="SKILLS"
            tone="violet"
          >
            <div className="space-y-1.5">
              {snapshot.skills.skills
                .slice(0, config.skillLimit)
                .map((skill) => (
                  <SkillRow
                    key={`${skill.source}:${skill.path}`}
                    skill={skill}
                  />
                ))}
              {snapshot.skills.skills.length === 0 ? (
                <MiniEmpty label="No runtime skills loaded." />
              ) : null}
              <SkillIssues skills={snapshot.skills} />
            </div>
          </RuntimeSection>
        </div>
      </ScrollArea>
    </div>
  );
}

function RuntimeHome({
  activeSkills,
  status,
  repoCount,
}: {
  activeSkills: number;
  status: RuntimeStatus;
  repoCount: number;
}) {
  const model = status.models.displayAssistant;
  const provider = providerStatusSummary(
    status,
    status.models.displayAssistantProvider,
  );
  const modelProviders = activeModelProviderIds(status);
  return (
    <section className="border border-line bg-soft p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.12em] text-muted">
            NEONDECK_HOME
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-ink">
            {shortPath(status.home)}
          </p>
        </div>
        <Badge>{formatUptime(status.uptimeSeconds)}</Badge>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5 font-mono text-[10px] text-muted">
        <Metric label="repos" value={repoCount} />
        <Metric label="sched" value={status.counts.activeSchedules} />
        <Metric label="watches" value={status.counts.activeWatches} />
        <Metric label="skills" value={activeSkills} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5 font-mono text-[10px] text-muted">
        {modelProviders.map((providerId) => (
          <StatusPill
            key={providerId}
            ok={providerCredentialConfigured(status, providerId)}
            label={providerId}
            value={
              providerCredentialConfigured(status, providerId)
                ? 'key'
                : 'missing'
            }
          />
        ))}
        <StatusPill
          ok={status.providers.credentials.github}
          label="github"
          value={status.providers.credentials.github ? 'token' : 'missing'}
        />
      </div>
      <div className="mt-2 min-w-0 border border-line bg-field px-2 py-1.5">
        <p className="font-mono text-[10px] tracking-[0.12em] text-muted">
          MODEL · {status.models.displayAssistantProvider}
        </p>
        <p className="mt-1 truncate font-mono text-[10.5px] text-ink">
          {model} · {status.models.displayAssistantThinkingLevel}
        </p>
      </div>
      <div className="mt-2 min-w-0 border border-line bg-field px-2 py-1.5">
        <p className="font-mono text-[10px] tracking-[0.12em] text-muted">
          PROVIDER · {provider.label}
        </p>
        <p className="mt-1 truncate font-mono text-[10.5px] text-ink">
          {provider.enabled ? 'enabled' : 'disabled'} · {provider.apiKeyEnv}
        </p>
      </div>
      <div className="mt-2 min-w-0 border border-line bg-field px-2 py-1.5">
        <p className="font-mono text-[10px] tracking-[0.12em] text-muted">
          SESSION · {status.session.stale ? 'STALE' : 'CURRENT'}
        </p>
        <p className="mt-1 truncate font-mono text-[10.5px] text-ink">
          {status.session.id}
        </p>
      </div>
      <div className="mt-2 min-w-0 border border-line bg-field px-2 py-1.5">
        <p className="font-mono text-[10px] tracking-[0.12em] text-muted">
          EXEC · {status.execution.defaultBackend}
        </p>
        <p className="mt-1 truncate font-mono text-[10.5px] text-ink">
          {status.execution.enabledBackends.join(', ')} ·{' '}
          {status.execution.preapprovedCommandCount} preapproved
        </p>
      </div>
    </section>
  );
}

function RuntimeConfigControls({
  onRefresh,
  status,
}: {
  onRefresh: () => void;
  status: RuntimeStatus;
}) {
  const [displayAssistant, setDisplayAssistant] = useState(
    status.models.displayAssistant,
  );
  const [displayThinking, setDisplayThinking] = useState(
    status.models.displayAssistantThinkingLevel,
  );
  const [repoResearcher, setRepoResearcher] = useState(
    status.models.subagents.repoResearcher ?? '',
  );
  const [repoThinking, setRepoThinking] = useState(
    status.models.subagentThinkingLevels.repoResearcher ?? 'medium',
  );
  const [ciInvestigator, setCiInvestigator] = useState(
    status.models.subagents.ciInvestigator ?? '',
  );
  const [ciThinking, setCiThinking] = useState(
    status.models.subagentThinkingLevels.ciInvestigator ?? 'medium',
  );
  const [releaseReviewer, setReleaseReviewer] = useState(
    status.models.subagents.releaseReviewer ?? '',
  );
  const [releaseThinking, setReleaseThinking] = useState(
    status.models.subagentThinkingLevels.releaseReviewer ?? 'medium',
  );
  const [providerId, setProviderId] = useState<ModelProviderId>(
    modelProviderId(status.models.displayAssistantProvider),
  );
  const previousDisplayProvider = useRef<ModelProviderId>(
    modelProviderId(status.models.displayAssistantProvider),
  );
  const selectedProvider = providerStatusSummary(status, providerId);
  const [providerEnabled, setProviderEnabled] = useState(
    selectedProvider.enabled,
  );
  const [apiKeyEnv, setApiKeyEnv] = useState(selectedProvider.apiKeyEnv);
  const [organizationIdEnv, setOrganizationIdEnv] = useState(
    selectedProvider.organizationIdEnv ?? '',
  );
  const [modelMessage, setModelMessage] = useState<string | null>(null);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);

  useEffect(() => {
    setDisplayAssistant(status.models.displayAssistant);
    setDisplayThinking(status.models.displayAssistantThinkingLevel);
    setRepoResearcher(status.models.subagents.repoResearcher ?? '');
    setRepoThinking(
      status.models.subagentThinkingLevels.repoResearcher ?? 'medium',
    );
    setCiInvestigator(status.models.subagents.ciInvestigator ?? '');
    setCiThinking(
      status.models.subagentThinkingLevels.ciInvestigator ?? 'medium',
    );
    setReleaseReviewer(status.models.subagents.releaseReviewer ?? '');
    setReleaseThinking(
      status.models.subagentThinkingLevels.releaseReviewer ?? 'medium',
    );
    const nextDisplayProvider = modelProviderId(
      status.models.displayAssistantProvider,
    );
    if (previousDisplayProvider.current !== nextDisplayProvider) {
      previousDisplayProvider.current = nextDisplayProvider;
      setProviderId(nextDisplayProvider);
    }
  }, [status]);

  useEffect(() => {
    const provider = providerStatusSummary(status, providerId);
    setProviderEnabled(provider.enabled);
    setApiKeyEnv(provider.apiKeyEnv);
    setOrganizationIdEnv(provider.organizationIdEnv ?? '');
  }, [providerId, status]);

  async function saveModels(event: FormEvent) {
    event.preventDefault();
    setSavingModels(true);
    setModelMessage(null);

    try {
      const input = modelUpdateInput(status, {
        displayAssistant,
        displayThinking,
        repoResearcher,
        repoThinking,
        ciInvestigator,
        ciThinking,
        releaseReviewer,
        releaseThinking,
      });

      if (Object.keys(input).length === 0) {
        setModelMessage('No model changes to save.');
        return;
      }

      const result = await updateAgentModels(input);
      setModelMessage(result.message);
      onRefresh();
    } catch (cause) {
      setModelMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingModels(false);
    }
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    setSavingProvider(true);
    setProviderMessage(null);

    try {
      const result = await updateProvider(providerId, {
        enabled: providerEnabled,
        apiKeyEnv: apiKeyEnv.trim() || null,
        ...(providerId === 'kilocode'
          ? { organizationIdEnv: organizationIdEnv.trim() || null }
          : {}),
      });
      setProviderMessage(result.message);
      onRefresh();
    } catch (cause) {
      setProviderMessage(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setSavingProvider(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <form
        className="space-y-2 border border-line bg-soft px-2.5 py-2"
        onSubmit={saveModels}
      >
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[10px] tracking-[0.12em] text-violet">
            MODELS
          </p>
          <button
            className="border border-violet px-2 py-1 font-mono text-[10px] text-violet disabled:opacity-50"
            disabled={savingModels}
            type="submit"
          >
            {savingModels ? 'saving' : 'save'}
          </button>
        </div>
        <ConfigInput
          label="display"
          onChange={setDisplayAssistant}
          value={displayAssistant}
        />
        <ConfigSelect
          label="display think"
          onChange={setDisplayThinking}
          options={thinkingLevelOptions}
          value={displayThinking}
        />
        <ConfigInput
          label="repo"
          onChange={setRepoResearcher}
          value={repoResearcher}
        />
        <ConfigSelect
          label="repo think"
          onChange={setRepoThinking}
          options={thinkingLevelOptions}
          value={repoThinking}
        />
        <ConfigInput
          label="ci"
          onChange={setCiInvestigator}
          value={ciInvestigator}
        />
        <ConfigSelect
          label="ci think"
          onChange={setCiThinking}
          options={thinkingLevelOptions}
          value={ciThinking}
        />
        <ConfigInput
          label="release"
          onChange={setReleaseReviewer}
          value={releaseReviewer}
        />
        <ConfigSelect
          label="release think"
          onChange={setReleaseThinking}
          options={thinkingLevelOptions}
          value={releaseThinking}
        />
        {modelMessage ? <ConfigMessage message={modelMessage} /> : null}
      </form>
      <form
        className="space-y-2 border border-line bg-soft px-2.5 py-2"
        onSubmit={saveProvider}
      >
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 font-mono text-[10px] tracking-[0.12em] text-violet">
            <input
              checked={providerEnabled}
              className="size-3 accent-current"
              onChange={(event) => setProviderEnabled(event.target.checked)}
              type="checkbox"
            />
            PROVIDER TARGET
          </label>
          <select
            aria-label="Provider to configure"
            className="border border-line bg-field px-2 py-1 font-mono text-[10px] text-ink outline-none focus:border-violet"
            onChange={(event) =>
              setProviderId(modelProviderId(event.target.value))
            }
            value={providerId}
          >
            <option value="kilocode">KiloCode</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <button
            className="border border-violet px-2 py-1 font-mono text-[10px] text-violet disabled:opacity-50"
            disabled={savingProvider}
            type="submit"
          >
            {savingProvider ? 'saving' : 'save'}
          </button>
        </div>
        <ConfigInput
          label="key env"
          onChange={setApiKeyEnv}
          value={apiKeyEnv}
        />
        {providerId === 'kilocode' ? (
          <ConfigInput
            label="org env"
            onChange={setOrganizationIdEnv}
            placeholder="optional"
            value={organizationIdEnv}
          />
        ) : null}
        <p className="line-clamp-2 text-[10.5px] leading-4 text-muted">
          Environment variable references only. Provider registration changes
          apply after server restart.
        </p>
        {providerMessage ? <ConfigMessage message={providerMessage} /> : null}
      </form>
    </div>
  );
}

function modelUpdateInput(
  status: RuntimeStatus,
  values: {
    displayAssistant: string;
    displayThinking: string;
    repoResearcher: string;
    repoThinking: string;
    ciInvestigator: string;
    ciThinking: string;
    releaseReviewer: string;
    releaseThinking: string;
  },
) {
  const displayAssistant = values.displayAssistant.trim();
  const displayThinking = values.displayThinking.trim();
  const repoResearcher = values.repoResearcher.trim();
  const repoThinking = values.repoThinking.trim();
  const ciInvestigator = values.ciInvestigator.trim();
  const ciThinking = values.ciThinking.trim();
  const releaseReviewer = values.releaseReviewer.trim();
  const releaseThinking = values.releaseThinking.trim();
  const subagents: Record<string, string> = {};
  const input: {
    displayAssistant?: string;
    displayAssistantThinkingLevel?: string;
    subagents?: Record<string, string>;
  } = {};

  if (displayAssistant !== status.models.displayAssistant) {
    input.displayAssistant = displayAssistant;
  }
  if (displayThinking !== status.models.displayAssistantThinkingLevel) {
    input.displayAssistantThinkingLevel = displayThinking;
  }

  if (repoResearcher !== status.models.subagents.repoResearcher) {
    subagents.repoResearcher = repoResearcher;
  }
  if (repoThinking !== status.models.subagentThinkingLevels.repoResearcher) {
    subagents.repoResearcherThinkingLevel = repoThinking;
  }
  if (ciInvestigator !== status.models.subagents.ciInvestigator) {
    subagents.ciInvestigator = ciInvestigator;
  }
  if (ciThinking !== status.models.subagentThinkingLevels.ciInvestigator) {
    subagents.ciInvestigatorThinkingLevel = ciThinking;
  }
  if (releaseReviewer !== status.models.subagents.releaseReviewer) {
    subagents.releaseReviewer = releaseReviewer;
  }
  if (
    releaseThinking !== status.models.subagentThinkingLevels.releaseReviewer
  ) {
    subagents.releaseReviewerThinkingLevel = releaseThinking;
  }
  if (Object.keys(subagents).length > 0) {
    input.subagents = subagents;
  }

  return input;
}

function ConfigInput({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-mono text-[10px] text-muted">
      <span className="truncate">{label}</span>
      <input
        className="min-w-0 border border-line bg-field px-2 py-1 text-[10.5px] text-ink outline-none focus:border-violet"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

function ConfigSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 font-mono text-[10px] text-muted">
      <span className="truncate">{label}</span>
      <select
        className="min-w-0 border border-line bg-field px-2 py-1 text-[10.5px] text-ink outline-none focus:border-violet"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

type ModelProviderId = 'kilocode' | 'openai' | 'anthropic';

const thinkingLevelOptions = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

function modelProviderId(value: string): ModelProviderId {
  if (value === 'openai' || value === 'anthropic') return value;
  return 'kilocode';
}

function activeModelProviderIds(status: RuntimeStatus): ModelProviderId[] {
  return Array.from(
    new Set(
      [
        status.models.displayAssistant,
        ...Object.values(status.models.subagents),
      ]
        .map((model) => model.split('/')[0] ?? 'kilocode')
        .map(modelProviderId),
    ),
  );
}

function providerCredentialConfigured(
  status: RuntimeStatus,
  provider: ModelProviderId,
) {
  if (provider === 'kilocode') return status.providers.credentials.kilo;
  return status.providers.credentials[provider];
}

function providerStatusSummary(status: RuntimeStatus, provider: string) {
  const id = modelProviderId(provider);
  if (id === 'openai') {
    return {
      label: 'OPENAI',
      enabled: status.providers.configs.openai.enabled,
      apiKeyEnv: status.providers.configs.openai.apiKeyEnv,
      organizationIdEnv: null,
    };
  }

  if (id === 'anthropic') {
    return {
      label: 'ANTHROPIC',
      enabled: status.providers.configs.anthropic.enabled,
      apiKeyEnv: status.providers.configs.anthropic.apiKeyEnv,
      organizationIdEnv: null,
    };
  }

  return {
    label: 'KILOCODE',
    enabled: status.providers.configs.kilocode.enabled,
    apiKeyEnv: status.providers.configs.kilocode.apiKeyEnv,
    organizationIdEnv: status.providers.configs.kilocode.organizationIdEnv,
  };
}

function ConfigMessage({ message }: { message: string }) {
  return (
    <p className="line-clamp-2 border border-line bg-field px-2 py-1 text-[10.5px] leading-4 text-muted">
      {message}
    </p>
  );
}

function RuntimeSection({
  children,
  count,
  title,
  tone,
}: {
  children: React.ReactNode;
  count: number;
  title: string;
  tone: 'primary' | 'accent' | 'violet';
}) {
  const toneClass =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'accent'
        ? 'text-accent'
        : 'text-violet';

  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] tracking-[0.12em]">
        <span className={toneClass}>{title}</span>
        <span className="text-muted">{count}</span>
      </div>
      {children}
    </section>
  );
}

function FirstRunSetup({ checks }: { checks: RuntimeStatusCheck[] }) {
  if (checks.length === 0) {
    return <MiniEmpty label="Setup checks are green." />;
  }

  return (
    <div className="space-y-1.5">
      {checks.map((check) => (
        <SetupStepRow check={check} key={check.id} step={setupStep(check)} />
      ))}
    </div>
  );
}

function SetupStepRow({
  check,
  step,
}: {
  check: RuntimeStatusCheck;
  step: SetupStep;
}) {
  return (
    <article className="border border-accent/60 bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {check.label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {step.detail}
          </p>
        </div>
        <Badge className={checkClass(check)}>{check.level}</Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">{step.action}</span>
        <span className="shrink-0 text-violet">{step.surface}</span>
        <a
          className="shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary"
          href={step.docsHref}
          rel="noreferrer"
          target="_blank"
        >
          {step.docsLabel}
        </a>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
        {check.message}
      </p>
    </article>
  );
}

function ReadinessRow({ check }: { check: RuntimeStatusCheck }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {check.label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {check.message}
          </p>
        </div>
        <Badge className={checkClass(check)}>
          {check.ok ? 'ok' : check.level}
        </Badge>
      </div>
    </article>
  );
}

function FlueErrorRow({
  error,
}: {
  error: RuntimeStatus['lastFlueErrors'][number];
}) {
  return (
    <article className="border border-accent/60 bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {error.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {error.message}
          </p>
        </div>
        <Badge className="border-accent text-accent">
          {relativeTime(error.createdAt)}
        </Badge>
      </div>
    </article>
  );
}

function NotificationRow({
  notification,
  onRefresh,
}: {
  notification: NotificationRecord;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'read' | 'resolve') {
    setBusy(true);
    setError(null);
    try {
      if (action === 'read') {
        await markNotificationRead(notification.id);
      } else {
        await resolveNotification(notification.id);
      }
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {notification.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {notification.message}
          </p>
        </div>
        <Badge className={notificationClass(notification)}>
          {notification.level}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {notification.source ?? 'local'} ·{' '}
          {relativeTime(notification.updatedAt)}
          {notification.occurrenceCount > 1
            ? ` · x${notification.occurrenceCount}`
            : ''}
        </span>
        {!notification.readAt ? (
          <button
            className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
            disabled={busy}
            onClick={() => void run('read')}
            type="button"
          >
            read
          </button>
        ) : null}
        <button
          className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
          disabled={busy}
          onClick={() => void run('resolve')}
          type="button"
        >
          resolve
        </button>
      </div>
      {error ? (
        <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-accent">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function SafetyPolicyRow({ entry }: { entry: SafetyPolicyEntry }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {entry.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {entry.primitive} · {entry.notes}
          </p>
        </div>
        <Badge
          className={
            entry.class === 'host-execution' ||
            entry.class === 'destructive-mutation'
              ? 'border-accent text-accent'
              : ''
          }
        >
          {entry.requiresConfirmation ? 'confirm' : entry.class}
        </Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{entry.id}</span>
        <span className="shrink-0">{entry.auditTarget}</span>
      </div>
    </article>
  );
}

function ExecutionApprovalRow({
  approval,
  onRefresh,
}: {
  approval: ExecutionApproval;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(
    decision: 'allow-once' | 'allow-session' | 'allow-always' | 'deny',
  ) {
    setBusy(decision);
    setError(null);
    try {
      await resolveExecutionApproval(approval.id, decision);
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {approval.command}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {approval.backend} · {approval.risk}
            {approval.cwd ? ` · ${shortPath(approval.cwd)}` : ''}
            {approval.error ? ` · ${approval.error}` : ''}
          </p>
        </div>
        <Badge className={executionApprovalClass(approval)}>
          {approval.status}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {relativeTime(approval.updatedAt)}
          {approval.exitCode !== null ? ` · exit ${approval.exitCode}` : ''}
        </span>
        {approval.status === 'pending' ? (
          <>
            <button
              className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('allow-once')}
              type="button"
            >
              once
            </button>
            <button
              className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('allow-session')}
              type="button"
            >
              session
            </button>
            <button
              className="shrink-0 border border-line px-1.5 py-0.5 text-muted disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('allow-always')}
              type="button"
            >
              preapprove
            </button>
            <button
              className="shrink-0 border border-accent px-1.5 py-0.5 text-accent disabled:opacity-50"
              disabled={!!busy}
              onClick={() => void resolve('deny')}
              type="button"
            >
              deny
            </button>
          </>
        ) : null}
      </div>
      {error ? (
        <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-accent">
          {error}
        </p>
      ) : null}
    </article>
  );
}

function RepoEditEventRow({ event }: { event: RepoEditEvent }) {
  const paths = event.paths.length > 0 ? event.paths.join(', ') : 'no paths';
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {event.repoId} · {event.action}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {paths}
            {event.reason ? ` · ${event.reason}` : ''}
          </p>
        </div>
        <Badge className={repoEditEventClass(event)}>{event.status}</Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">
          {event.sessionId ? `session ${event.sessionId}` : event.actorType}
        </span>
        <span className="shrink-0">{relativeTime(event.updatedAt)}</span>
      </div>
    </article>
  );
}

function ActiveRunRow({
  run,
}: {
  run: WorkflowObservability['activeRuns'][number];
}) {
  return (
    <article className="border border-primary/60 bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <a
            className="truncate font-mono text-[11px] text-ink hover:text-primary"
            href={run.runUrl}
            rel="noreferrer"
            target="_blank"
          >
            {run.workflow}
          </a>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {run.lastMessage}
          </p>
        </div>
        <Badge className="border-primary text-primary">
          {run.eventCount} events
        </Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{run.runId}</span>
        <span className="shrink-0">{relativeTime(run.lastEventAt)}</span>
      </div>
    </article>
  );
}

function WorkflowEventRow({
  event,
  rawLabel = false,
}: {
  event: WorkflowEventRecord;
  rawLabel?: boolean;
}) {
  const content = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {event.name ?? event.workflow ?? event.eventType}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {event.message}
          </p>
        </div>
        <Badge className={event.isError ? 'border-accent text-accent' : ''}>
          {event.level ?? event.eventType}
        </Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">
          {rawLabel && event.runUrl
            ? 'raw run inspection'
            : (event.runId ?? event.operationId ?? 'local')}
        </span>
        <span className="shrink-0">{relativeTime(event.createdAt)}</span>
      </div>
    </>
  );

  if (event.runUrl) {
    return (
      <a
        className="block border border-line bg-soft px-2.5 py-2 hover:border-primary/70"
        href={event.runUrl}
        rel="noreferrer"
        target="_blank"
      >
        {content}
      </a>
    );
  }

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      {content}
    </article>
  );
}

function RepoRow({
  health,
  repo,
}: {
  health: RepoHealth | undefined;
  repo: RepoConfig;
}) {
  const scripts = Object.keys(repo.packageScripts ?? {}).length;
  const healthStatus = repoHealthStatus(health);

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">{repo.id}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
            {repo.github.owner}/{repo.github.name}
          </p>
        </div>
        <Badge className={healthStatus.className}>{healthStatus.label}</Badge>
      </div>
      <div className="mt-1.5 flex min-w-0 items-center gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">
          {health?.branch ?? 'branch:n/a'}→{repo.defaultBranch}
        </span>
        {repo.productionTarget ? (
          <span className="truncate text-primary">
            prod:{repo.productionTarget}
          </span>
        ) : null}
        <span className="ml-auto shrink-0">
          {health?.changeCount ?? 0} changes · {scripts} scripts
        </span>
      </div>
    </article>
  );
}

function JobRow({ job }: { job: SchedulerJob }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">{job.id}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
            {job.type} · every {formatInterval(job.intervalSeconds)}
          </p>
        </div>
        <Badge className={job.enabled ? 'border-primary text-primary' : ''}>
          {job.enabled ? 'enabled' : 'paused'}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{job.lastOutcome ?? 'not-run'}</span>
        <span className="shrink-0">
          {job.lastRunAt ? relativeTime(job.lastRunAt) : 'due'}
        </span>
      </div>
    </article>
  );
}

function SkillRow({ skill }: { skill: RuntimeSkill }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">{skill.id}</p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {skill.description}
          </p>
        </div>
        <Badge
          className={
            skill.status === 'active'
              ? 'border-violet text-violet'
              : 'border-accent text-accent'
          }
        >
          {skill.source}
        </Badge>
      </div>
    </article>
  );
}

function MemoryRow({ memory }: { memory: MemoryRecord }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {memory.scope}:{memory.key}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {memoryPreview(memory.value)}
          </p>
        </div>
        <Badge>{relativeTime(memory.updatedAt)}</Badge>
      </div>
    </article>
  );
}

function memoryPreview(value: unknown) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) return 'empty';
  return JSON.stringify(value);
}

function SkillIssues({ skills }: { skills: RuntimeSkillsResponse }) {
  const issueCount = skills.duplicates.length + skills.ignored.length;
  if (issueCount === 0) return null;

  return (
    <div className="border border-accent/50 bg-soft px-2.5 py-2 font-mono text-[10px] text-accent">
      {skills.duplicates.length} duplicate · {skills.ignored.length} ignored
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-line bg-field px-2 py-1">
      <span className="text-primary">{value}</span>
      <span className="ml-1">{label}</span>
    </div>
  );
}

function StatusPill({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean;
  value: string;
}) {
  return (
    <div className="border border-line bg-field px-2 py-1">
      <span className={ok ? 'text-primary' : 'text-accent'}>{value}</span>
      <span className="ml-1">{label}</span>
    </div>
  );
}

function MiniEmpty({ label }: { label: string }) {
  return (
    <div className="border border-line bg-soft px-2.5 py-2 font-mono text-[10px] text-muted">
      {label}
    </div>
  );
}

function repoHealthStatus(health: RepoHealth | undefined) {
  if (!health) return { label: 'unknown', className: '' };
  if (health.error) {
    return { label: 'error', className: 'border-accent text-accent' };
  }
  if (health.dirty) {
    return {
      label: `${health.changeCount} dirty`,
      className: 'border-accent text-accent',
    };
  }
  if (health.behind && health.behind > 0) {
    return {
      label: `${health.behind} behind`,
      className: 'border-accent text-accent',
    };
  }
  if (health.ahead && health.ahead > 0) {
    return {
      label: `${health.ahead} ahead`,
      className: 'border-violet text-violet',
    };
  }
  return { label: 'clean', className: 'border-primary text-primary' };
}

function checkClass(check: RuntimeStatusCheck) {
  if (check.ok) return 'border-primary text-primary';
  if (check.level === 'attention') return 'border-accent text-accent';
  return 'border-violet text-violet';
}

function notificationClass(notification: NotificationRecord) {
  if (notification.level === 'urgent') return 'border-accent text-accent';
  if (notification.level === 'attention') return 'border-accent text-accent';
  if (notification.level === 'ready') return 'border-primary text-primary';
  return '';
}

function executionApprovalClass(approval: ExecutionApproval) {
  if (approval.status === 'pending') return 'border-accent text-accent';
  if (approval.status === 'executed') return 'border-primary text-primary';
  if (approval.status === 'failed' || approval.status === 'blocked') {
    return 'border-accent text-accent';
  }
  return '';
}

function repoEditEventClass(event: RepoEditEvent) {
  if (event.status === 'applied') return 'border-primary text-primary';
  if (event.status === 'failed' || event.status === 'blocked') {
    return 'border-accent text-accent';
  }
  if (event.status === 'preview') return 'border-violet text-violet';
  return '';
}

function setupStep(check: RuntimeStatusCheck): SetupStep {
  const docsBase = 'https://neondeck.dev/docs/getting-started/';
  const steps: Record<string, SetupStep> = {
    config: {
      action: 'neondeck_config_validate',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'runtime',
      surface: 'action',
      detail: 'Validate config.json or rerun setup for the runtime home.',
    },
    'repos-config': {
      action: 'neondeck_config_validate',
      docsHref: `${docsBase}#repositories`,
      docsLabel: 'repos',
      surface: 'action',
      detail: 'Repair repos.json before repo status, queues, or watches run.',
    },
    'schedules-config': {
      action: 'neondeck_config_validate',
      docsHref: `${docsBase}#commands`,
      docsLabel: 'commands',
      surface: 'action',
      detail: 'Repair schedules.json before scheduler jobs can load.',
    },
    skills: {
      action: 'neondeck_skills_reload',
      docsHref: `${docsBase}#runtime-skills`,
      docsLabel: 'skills',
      surface: 'action',
      detail: 'Fix ignored or invalid runtime skills, then reload skills.',
    },
    'session-context': {
      action: 'neondeck_session_start',
      docsHref: `${docsBase}#agent-models`,
      docsLabel: 'models',
      surface: 'action',
      detail:
        'Start a new session so changed config, models, skills, or memory apply.',
    },
    'kilo-key': {
      action: 'neondeck_config_update_provider',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'config',
      detail: 'Set the Kilo API key environment reference or disable Kilo.',
    },
    'openai-key': {
      action: 'neondeck_config_update_provider',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'config',
      detail: 'Set the OpenAI API key environment reference or disable OpenAI.',
    },
    'anthropic-key': {
      action: 'neondeck_config_update_provider',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'config',
      detail:
        'Set the Anthropic API key environment reference or disable Anthropic.',
    },
    'github-token': {
      action: 'GITHUB_TOKEN',
      docsHref: `${docsBase}#secrets`,
      docsLabel: 'secrets',
      surface: 'env',
      detail: 'Set GitHub credentials before queues, checks, and watches run.',
    },
    'model-providers': {
      action: 'neondeck_config_update_agent_models',
      docsHref: `${docsBase}#agent-models`,
      docsLabel: 'models',
      surface: 'action',
      detail: 'Point model strings at registered, enabled providers.',
    },
    'execution-policy': {
      action: 'neondeck_config_update_execution_policy',
      docsHref: `${docsBase}#execution-approvals`,
      docsLabel: 'execution',
      surface: 'action',
      detail:
        'Enable at least one execution backend and keep approval policy explicit.',
    },
    repos: {
      action: 'neondeck_config_add_repo',
      docsHref: `${docsBase}#repositories`,
      docsLabel: 'repos',
      surface: 'action',
      detail:
        'Add a local checkout so queues, watches, and repo status have context.',
    },
    'flue-errors': {
      action: 'neondeck_workflow_summaries_lookup',
      docsHref: `${docsBase}#commands`,
      docsLabel: 'commands',
      surface: 'tool',
      detail:
        'Inspect recent workflow failures before trusting automation output.',
    },
    'app-db': {
      action: 'npm run setup',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'runtime',
      surface: 'shell',
      detail: 'Initialize or repair the Neondeck app database.',
    },
    'flue-db': {
      action: 'npm run setup',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'runtime',
      surface: 'shell',
      detail: 'Initialize or repair the Flue runtime database.',
    },
  };

  return (
    steps[check.id] ?? {
      action: 'neondeck_runtime_status_lookup',
      docsHref: `${docsBase}#runtime-home`,
      docsLabel: 'docs',
      surface: 'tool',
      detail:
        'Inspect the readiness message and update the related runtime config.',
    }
  );
}

function safetyRank(entry: SafetyPolicyEntry) {
  if (entry.class === 'host-execution') return 0;
  if (entry.requiresConfirmation) return 1;
  if (entry.class === 'safe-mutation') return 2;
  return 3;
}

function shortPath(path: string) {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join('/')}`;
}

function formatUptime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatInterval(seconds: number) {
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function relativeTime(value: string) {
  const delta = Date.now() - Date.parse(value);
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function emptySafetyPolicy(fetchedAt: string): SafetyPolicy {
  return {
    ok: false,
    action: 'safety_policy_read',
    version: 0,
    summary: {
      readOnly: 0,
      safeMutation: 0,
      destructiveMutation: 0,
      hostExecution: 0,
      requiresConfirmation: 0,
      unattendedAllowed: 0,
      audited: 0,
    },
    confirmationPolicy: 'Safety policy could not be loaded.',
    hostExecutionPolicy: 'Host execution is unavailable.',
    executionPolicy: {
      defaultBackend: 'local',
      enabledBackends: [],
      supportedBackends: ['local', 'exe.dev'],
      approvalMode: 'manual',
      unattended: 'deny',
      preapprovedCommandCount: 0,
      defaultLocalAccess: false,
      exeDevPlanned: true,
    },
    entries: [],
    fetchedAt,
  };
}

function emptyWorkflows(): WorkflowObservability {
  return {
    ok: true,
    action: 'workflow_observability_read',
    activeRuns: [],
    recentFailures: [],
    recentData: [],
    recentLogs: [],
    recentTools: [],
    recentOperations: [],
    recentEvents: [],
    fetchedAt: new Date().toISOString(),
  };
}
