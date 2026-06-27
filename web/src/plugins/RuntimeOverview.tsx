import { useEffect, useState } from 'react';
import {
  getRepoHealth,
  getRepoRegistry,
  getRuntimeHealth,
  getRuntimeSkills,
  getSchedulerJobs,
  type RepoHealth,
  type RepoHealthResponse,
  type RepoConfig,
  type RuntimeHealth,
  type RuntimeSkill,
  type RuntimeSkillsResponse,
  type SchedulerJob,
} from '../api';
import { EmptyState } from '../App';
import { Badge, ScrollArea } from '../components/ui';
import type { DisplayPlugin } from '../types';

type RuntimeOverviewConfig = {
  repoLimit: number;
  jobLimit: number;
  skillLimit: number;
};

type RuntimeSnapshot = {
  health: RuntimeHealth;
  repos: RepoConfig[];
  repoHealth: RepoHealthResponse;
  jobs: SchedulerJob[];
  skills: RuntimeSkillsResponse;
  fetchedAt: string;
};

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: RuntimeSnapshot };

export const RuntimeOverviewPlugin = {
  id: 'runtime-overview',
  title: 'Runtime overview',
  kind: 'data',
  defaultConfig: {
    repoLimit: 5,
    jobLimit: 5,
    skillLimit: 5,
  },
  Component({ config }) {
    const [state, setState] = useState<State>({ status: 'loading' });

    useEffect(() => {
      let cancelled = false;

      async function load() {
        try {
          const [health, registry, repoHealth, jobs, skills] =
            await Promise.all([
              getRuntimeHealth(),
              getRepoRegistry(),
              getRepoHealth(),
              getSchedulerJobs(),
              getRuntimeSkills(),
            ]);

          if (!cancelled) {
            setState({
              status: 'ready',
              snapshot: {
                health,
                repos: registry.repos,
                repoHealth,
                jobs: jobs.jobs,
                skills,
                fetchedAt: new Date().toISOString(),
              },
            });
          }
        } catch (cause) {
          if (!cancelled) {
            setState({
              status: 'error',
              message: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      }

      void load();
      const timer = window.setInterval(load, 30_000);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }, []);

    if (state.status === 'loading') {
      return (
        <EmptyState title="Runtime loading" detail="Reading backend state." />
      );
    }

    if (state.status === 'error') {
      return <EmptyState title="Runtime unavailable" detail={state.message} />;
    }

    return <RuntimeView config={config} snapshot={state.snapshot} />;
  },
} satisfies DisplayPlugin<RuntimeOverviewConfig>;

function RuntimeView({
  config,
  snapshot,
}: {
  config: RuntimeOverviewConfig;
  snapshot: RuntimeSnapshot;
}) {
  const activeSkills = snapshot.skills.skills.filter(
    (skill) => skill.status === 'active',
  );
  const enabledJobs = snapshot.jobs.filter((job) => job.enabled);
  const healthByRepoId = new Map(
    snapshot.repoHealth.repos.map((repo) => [repo.id, repo]),
  );
  const runtimeStatus = snapshot.health.ok ? 'online' : 'degraded';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <span className="text-violet">RUNTIME</span>
        <Badge
          className={
            snapshot.health.ok
              ? 'border-primary text-primary'
              : 'border-accent text-accent'
          }
        >
          {snapshot.health.service}:{runtimeStatus}
        </Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-3 p-3">
          <RuntimeHome
            activeSkills={activeSkills.length}
            enabledJobs={enabledJobs.length}
            health={snapshot.health}
            repoCount={snapshot.repos.length}
          />
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
  enabledJobs,
  health,
  repoCount,
}: {
  activeSkills: number;
  enabledJobs: number;
  health: RuntimeHealth;
  repoCount: number;
}) {
  return (
    <section className="border border-line bg-soft p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.12em] text-muted">
            NEONDECK_HOME
          </p>
          <p className="mt-1 truncate font-mono text-[11px] text-ink">
            {shortPath(health.home)}
          </p>
        </div>
        <Badge>{formatUptime(health.uptimeSeconds)}</Badge>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 font-mono text-[10px] text-muted">
        <Metric label="repos" value={repoCount} />
        <Metric label="jobs" value={enabledJobs} />
        <Metric label="skills" value={activeSkills} />
      </div>
    </section>
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
