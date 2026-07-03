import { Badge, ScrollArea } from '../../../components/ui';
import type { RuntimeStatus } from '../../../api';
import { RuntimeConfigControls, activeModelProviderIds, providerCredentialConfigured, providerStatusSummary } from './config-controls';
import { Metric, MiniEmpty, StatusPill } from './atoms';
import {
  FirstRunSetup,
  FlueErrorRow,
  NotificationRow,
  ReadinessRow,
  RuntimeSection,
  SafetyPolicyRow,
  ExecutionApprovalRow,
} from './setup-rows';
import {
  ActiveRunRow,
  JobRow,
  KiloTaskRow,
  MemoryRow,
  RepoEditEventRow,
  RepoRow,
  SkillIssues,
  SkillRow,
  WorkflowEventRow,
  WorktreeCleanupRow,
  WorktreeLockRow,
  WorktreeRow,
} from './runtime-rows';
import { formatUptime, safetyRank, shortPath } from '../lib/format';
import type { RuntimeOverviewConfig, RuntimeSnapshot } from '../types';

export function RuntimeView({
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
  const activeKiloTasks = snapshot.kiloTasks.tasks.filter((task) =>
    [
      'running',
      'needs-reconcile',
      'needs-review',
      'ready-to-verify',
      'ready-to-push',
      'unknown',
    ].includes(task.status),
  );
  const recentKiloTasks = [
    ...activeKiloTasks,
    ...snapshot.kiloTasks.tasks.filter(
      (task) => !activeKiloTasks.some((active) => active.id === task.id),
    ),
  ].slice(0, 5);
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
              {[...snapshot.safety.entries]
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
            count={activeKiloTasks.length}
            title="KILO WORK"
            tone={activeKiloTasks.length > 0 ? 'accent' : 'violet'}
          >
            <div className="space-y-1.5">
              {recentKiloTasks.map((task) => (
                <KiloTaskRow key={task.id} task={task} />
              ))}
              {recentKiloTasks.length === 0 ? (
                <MiniEmpty label="No delegated Kilo work recorded." />
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
            count={snapshot.worktrees.worktrees.length}
            title="WORKTREES"
            tone={
              snapshot.worktrees.staleLocks.length > 0 ||
              snapshot.worktrees.cleanupFailures.length > 0
                ? 'accent'
                : 'primary'
            }
          >
            <div className="space-y-1.5">
              {snapshot.worktrees.worktrees.slice(0, 6).map((worktree) => (
                <WorktreeRow key={worktree.id} worktree={worktree} />
              ))}
              {snapshot.worktrees.worktrees.length === 0 ? (
                <MiniEmpty label="No managed worktrees recorded." />
              ) : null}
              {snapshot.worktrees.staleLocks.map((lock) => (
                <WorktreeLockRow key={lock.id} lock={lock} />
              ))}
              {snapshot.worktrees.cleanupFailures.map((failure) => (
                <WorktreeCleanupRow failure={failure} key={failure.id} />
              ))}
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
            title="RUN RESULTS"
            tone="violet"
          >
            <div className="space-y-1.5">
              {snapshot.workflows.recentData
                .slice(0, config.workflowEventLimit)
                .map((event) => (
                  <WorkflowEventRow event={event} key={`data:${event.id}`} />
                ))}
              {snapshot.workflows.recentData.length === 0 ? (
                <MiniEmpty label="No completed workflow results yet." />
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
  const utilityModel = status.models.utilityConfigured
    ? status.models.utility
    : `${status.models.utility} fallback`;
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
        <p className="mt-1 truncate font-mono text-[10px] text-muted">
          utility {utilityModel} · {status.models.utilityThinkingLevel}
        </p>
        {status.models.utilityRecommendation ? (
          <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted">
            {status.models.utilityRecommendation}
          </p>
        ) : null}
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
