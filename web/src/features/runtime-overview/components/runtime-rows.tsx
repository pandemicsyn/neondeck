import { SessionReferenceButton } from '../../../components/SessionReferenceButton';
import { Badge } from '../../../components/ui';
import type { KiloTaskRecord, MemoryRecord, RepoConfig, RepoEditEvent, RepoHealth, RuntimeSkill, RuntimeSkillsResponse, SchedulerJob, WorkflowEventRecord, WorkflowObservability, WorktreeCleanupFailure, WorktreeLockRecord, WorktreeRecord } from '../../../api';
import { formatInterval, kiloTaskStatusClass, relativeTime, repoEditEventClass, repoHealthStatus, shortPath, worktreeStatusClass } from '../lib/format';

export function RepoEditEventRow({ event }: { event: RepoEditEvent }) {
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

export function KiloTaskRow({ task }: { task: KiloTaskRecord }) {
  const changed =
    task.diff && task.diff.ok
      ? `${task.diff.fileCount} files +${task.diff.additions} -${task.diff.deletions}`
      : task.diff?.error
        ? task.diff.error
        : 'diff not read';
  const childLabel =
    task.childSessionIds.length > 0
      ? `${task.childSessionIds.length} child session${task.childSessionIds.length === 1 ? '' : 's'}`
      : 'no child sessions';
  const sessionLabel = task.rootSessionId ?? 'session pending';
  const notificationFacts = task.notificationFacts ?? [];
  const latestNotification = notificationFacts[0];
  const placeholders = task.resultPlaceholders ?? [];

  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {task.repoId} · {task.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {sessionLabel} · {childLabel} · {changed}
          </p>
        </div>
        <Badge className={kiloTaskStatusClass(task.status)}>
          {task.status}
        </Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">
          {task.worktreeId
            ? `worktree ${task.worktreeId}`
            : shortPath(task.cwd)}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <SessionReferenceButton
            kind="task"
            label="session"
            linkedRepoId={task.repoId}
            linkedTaskId={task.id}
            summary={`${task.title}: Kilo task ${task.status}. ${task.summary ?? changed}.`}
            title={`Kilo ${task.title}`}
            uiMetadata={{
              source: 'kilo-task',
              taskId: task.id,
              repoFullName: task.repoFullName,
              worktreeId: task.worktreeId,
              rootSessionId: task.rootSessionId,
              childSessionIds: task.childSessionIds,
              status: task.status,
            }}
          />
          {relativeTime(task.updatedAt)}
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5 font-mono text-[10px] text-muted">
        <div className="border border-line bg-field px-2 py-1">
          verify {task.verificationState ?? 'not-run'}
        </div>
        <div className="border border-line bg-field px-2 py-1">
          approvals {task.pendingApprovals?.length ?? 0}
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5 font-mono text-[10px] text-muted">
        <div className="border border-line bg-field px-2 py-1">
          review {task.reviewClassification ?? 'pending'}
        </div>
        <div className="border border-line bg-field px-2 py-1">
          promote {task.promotionState ?? 'not-requested'}
        </div>
      </div>
      {latestNotification || placeholders.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {latestNotification ? (
            <p className="line-clamp-2 border border-line bg-field px-2 py-1 text-[10px] leading-4 text-muted">
              notify {latestNotification.state}: {latestNotification.message}
            </p>
          ) : null}
          {placeholders.slice(0, 2).map((placeholder) => (
            <p
              className="line-clamp-2 border border-line bg-field px-2 py-1 text-[10px] leading-4 text-muted"
              key={`${placeholder.type}:${placeholder.workflow}`}
            >
              {placeholder.type} {placeholder.status}: {placeholder.reason}
            </p>
          ))}
        </div>
      ) : null}
      {task.childSessionIds.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.childSessionIds.slice(0, 3).map((id) => (
            <Badge key={id}>child {id}</Badge>
          ))}
          {task.childSessionIds.length > 3 ? (
            <Badge>+{task.childSessionIds.length - 3}</Badge>
          ) : null}
        </div>
      ) : null}
      {task.error ? (
        <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-4 text-accent">
          {task.error}
        </p>
      ) : null}
    </article>
  );
}

export function WorktreeRow({ worktree }: { worktree: WorktreeRecord }) {
  const pr = worktree.prNumber ? `PR #${worktree.prNumber}` : 'repo work';
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {worktree.repoId} · {pr}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {worktree.headRef}
            {worktree.headSha ? ` · ${worktree.headSha.slice(0, 12)}` : ''}
          </p>
        </div>
        <Badge className={worktreeStatusClass(worktree.lifecycleStatus)}>
          {worktree.lifecycleStatus}
        </Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{shortPath(worktree.localPath)}</span>
        <span className="shrink-0">
          {worktree.adopted ? 'adopted' : worktree.storageKind}
        </span>
      </div>
    </article>
  );
}

export function WorktreeLockRow({ lock }: { lock: WorktreeLockRecord }) {
  return (
    <article className="border border-accent/70 bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            stale {lock.scope} lock
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {lock.owner} · {lock.scopeKey}
          </p>
        </div>
        <Badge className="border-accent text-accent">stale</Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{lock.worktreeId ?? lock.repoId}</span>
        <span className="shrink-0">{relativeTime(lock.expiresAt)}</span>
      </div>
    </article>
  );
}

export function WorktreeCleanupRow({ failure }: { failure: WorktreeCleanupFailure }) {
  return (
    <article className="border border-accent/70 bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            cleanup failed
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {failure.error ?? failure.reason}
          </p>
        </div>
        <Badge className="border-accent text-accent">failed</Badge>
      </div>
      <div className="mt-1.5 flex justify-between gap-2 font-mono text-[10px] text-muted">
        <span className="truncate">{failure.worktreeId}</span>
        <span className="shrink-0">{relativeTime(failure.attemptedAt)}</span>
      </div>
    </article>
  );
}

export function ActiveRunRow({
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

export function WorkflowEventRow({
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

export function RepoRow({
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
      <div className="mt-1.5 flex justify-end font-mono text-[10px]">
        <SessionReferenceButton
          kind="repo"
          label="session"
          linkedRepoId={repo.id}
          summary={`${repo.id}: ${repo.github.owner}/${repo.github.name} on ${health?.branch ?? 'unknown branch'} with ${health?.changeCount ?? 0} local changes and ${scripts} package scripts. Default branch ${repo.defaultBranch}.`}
          title={`Repo ${repo.id}`}
          uiMetadata={{
            source: 'repo-row',
            repoId: repo.id,
            repoFullName: `${repo.github.owner}/${repo.github.name}`,
            path: repo.path,
            branch: health?.branch ?? null,
            dirty: health?.dirty ?? null,
            productionTarget: repo.productionTarget ?? null,
          }}
        />
      </div>
    </article>
  );
}

export function JobRow({ job }: { job: SchedulerJob }) {
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

export function SkillRow({ skill }: { skill: RuntimeSkill }) {
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

export function MemoryRow({ memory }: { memory: MemoryRecord }) {
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

export function SkillIssues({ skills }: { skills: RuntimeSkillsResponse }) {
  const issueCount = skills.duplicates.length + skills.ignored.length;
  if (issueCount === 0) return null;

  return (
    <div className="border border-accent/50 bg-soft px-2.5 py-2 font-mono text-[10px] text-accent">
      {skills.duplicates.length} duplicate · {skills.ignored.length} ignored
    </div>
  );
}
