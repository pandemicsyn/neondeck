import { useEffect, useMemo, useState } from 'react';
import {
  getRuntimeStatus,
  getWorkflowObservability,
  type RuntimeStatus,
  type WorkflowEventRecord,
  type WorkflowObservability,
} from '../api';
import { EmptyState } from '../App';
import { Badge, ScrollArea } from '../components/ui';
import type { DisplayPlugin } from '../types';

type SubagentSummaryConfig = {
  eventLimit: number;
};

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      runtime: RuntimeStatus;
      workflows: WorkflowObservability;
    };

const subagentLabels: Record<string, string> = {
  repoResearcher: 'repo_researcher',
  ciInvestigator: 'ci_investigator',
  releaseReviewer: 'release_reviewer',
};

export const SubagentSummaryPlugin = {
  id: 'subagent-summary',
  title: 'Subagents',
  kind: 'data',
  defaultConfig: {
    eventLimit: 5,
  },
  Component({ config }) {
    const [state, setState] = useState<State>({ status: 'loading' });

    useEffect(() => {
      let cancelled = false;

      async function load() {
        try {
          const [runtime, workflows] = await Promise.all([
            getRuntimeStatus(),
            getWorkflowObservability(),
          ]);
          if (!cancelled) setState({ status: 'ready', runtime, workflows });
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
        <EmptyState title="Subagents loading" detail="Reading role state." />
      );
    }

    if (state.status === 'error') {
      return (
        <EmptyState title="Subagents unavailable" detail={state.message} />
      );
    }

    return (
      <SubagentView
        eventLimit={config.eventLimit}
        runtime={state.runtime}
        workflows={state.workflows}
      />
    );
  },
} satisfies DisplayPlugin<SubagentSummaryConfig>;

function SubagentView({
  eventLimit,
  runtime,
  workflows,
}: {
  eventLimit: number;
  runtime: RuntimeStatus;
  workflows: WorkflowObservability;
}) {
  const events = useMemo(
    () => subagentEvents(workflows.recentEvents),
    [workflows.recentEvents],
  );
  const roles = Object.entries(runtime.models.subagents);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <span className="text-accent">SUBAGENTS</span>
        <Badge>{roles.length} roles</Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-2.5 p-3">
          <section>
            <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] tracking-[0.12em]">
              <span className="text-violet">MODELS</span>
              <span className="text-muted">
                {runtime.session.stale ? 'stale' : 'current'}
              </span>
            </div>
            <div className="space-y-1.5">
              {roles.map(([key, model]) => (
                <article
                  className="border border-line bg-soft px-2.5 py-2"
                  key={key}
                >
                  <p className="truncate font-mono text-[11px] text-ink">
                    {subagentLabels[key] ?? key}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
                    {model}
                  </p>
                </article>
              ))}
            </div>
          </section>
          <section>
            <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] tracking-[0.12em]">
              <span className="text-primary">RECENT DELEGATION</span>
              <span className="text-muted">{events.length}</span>
            </div>
            <div className="space-y-1.5">
              {events.slice(0, eventLimit).map((event) => (
                <EventRow event={event} key={event.id} />
              ))}
              {events.length === 0 ? (
                <MiniEmpty label="No delegated subagent activity observed yet." />
              ) : null}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function EventRow({ event }: { event: WorkflowEventRecord }) {
  return (
    <article className="border border-line bg-soft px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {event.name ?? event.operationKind ?? event.eventType}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {event.message}
          </p>
        </div>
        <Badge className={event.isError ? 'border-accent text-accent' : ''}>
          {relativeTime(event.createdAt)}
        </Badge>
      </div>
    </article>
  );
}

function subagentEvents(events: WorkflowEventRecord[]) {
  return events.filter((event) => {
    const haystack = [
      event.name,
      event.message,
      event.operationKind,
      event.operationId,
      JSON.stringify(event.summary ?? {}),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return (
      haystack.includes('subagent') ||
      haystack.includes('repo_researcher') ||
      haystack.includes('ci_investigator') ||
      haystack.includes('release_reviewer') ||
      haystack.includes('delegat')
    );
  });
}

function MiniEmpty({ label }: { label: string }) {
  return (
    <div className="border border-line bg-soft px-2.5 py-2 font-mono text-[10px] text-muted">
      {label}
    </div>
  );
}

function relativeTime(value: string) {
  const delta = Date.now() - Date.parse(value);
  if (!Number.isFinite(delta) || delta < 0) return 'now';
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
