import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  getRuntimeStatus,
  getWorkflowObservability,
  type RuntimeStatus,
  type WorkflowEventRecord,
  type WorkflowObservability,
} from '../api';
import { Badge, EmptyState, MiniEmpty, ScrollArea } from '../components/ui';
import { useConfigEvents } from '../lib/config-events';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type SubagentSummaryConfig = {
  eventLimit: number;
};

const subagentSummaryDefaultConfig = {
  eventLimit: 5,
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
  defaultConfig: subagentSummaryDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(subagentSummaryDefaultConfig, config),
  Component({ config }) {
    const queryClient = useQueryClient();
    const [runtime, workflows] = useQueries({
      queries: [
        {
          queryKey: queryKeys.runtimeStatus,
          queryFn: getRuntimeStatus,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.workflowObservability,
          queryFn: getWorkflowObservability,
          refetchInterval: 30_000,
        },
      ],
    });

    useConfigEvents(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workflowObservability,
      });
    });

    if (runtime.isLoading || workflows.isLoading) {
      return (
        <EmptyState title="Subagents loading" detail="Reading role state." />
      );
    }

    if (runtime.error || workflows.error) {
      return (
        <EmptyState
          title="Subagents unavailable"
          detail={queryErrorMessage(runtime.error ?? workflows.error)}
          tone="alert"
        />
      );
    }

    if (!runtime.data || !workflows.data) {
      return (
        <EmptyState
          title="Subagents unavailable"
          detail="No data."
          tone="alert"
        />
      );
    }

    return (
      <SubagentView
        eventLimit={config.eventLimit}
        runtime={runtime.data}
        workflows={workflows.data}
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

export function subagentEvents(events: WorkflowEventRecord[]) {
  return events.filter((event) => {
    const structured = [event.operationKind, event.name]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const structuredMatch =
      structured.includes('subagent') ||
      structured.includes('repo_researcher') ||
      structured.includes('ci_investigator') ||
      structured.includes('release_reviewer');
    if (structuredMatch) return true;

    const haystack = [
      event.message,
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
