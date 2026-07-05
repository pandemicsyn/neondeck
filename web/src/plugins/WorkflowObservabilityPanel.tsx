import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  getWorkflowObservability,
  type WorkflowEventRecord,
  type WorkflowObservability,
} from '../api';
import {
  Badge,
  EmptyState,
  Metric,
  MiniEmpty,
  ScrollArea,
} from '../components/ui';
import { relativeTime } from '../lib/format';
import { queryErrorMessage, queryKeys } from '../lib/query';
import type { DisplayPlugin } from '../types';
import { parsePositiveIntegerConfig } from './config';

type WorkflowObservabilityConfig = {
  eventLimit: number;
  refreshSeconds: number;
};

type WorkflowFilter = 'all' | 'active' | 'failed' | 'progress' | 'activity';

type WorkflowDrilldownItem = {
  id: string;
  kind: Exclude<WorkflowFilter, 'all'> | 'event';
  title: string;
  message: string;
  createdAt: string;
  metadata: string;
  runUrl: string | null;
  badge: string;
  isError: boolean;
};

const workflowObservabilityDefaultConfig = {
  eventLimit: 18,
  refreshSeconds: 20,
};

const filters: Array<{
  id: WorkflowFilter;
  label: string;
}> = [
  { id: 'all', label: 'all' },
  { id: 'active', label: 'active' },
  { id: 'failed', label: 'failed' },
  { id: 'progress', label: 'progress' },
  { id: 'activity', label: 'activity' },
];

export const WorkflowObservabilityPanelPlugin = {
  id: 'workflow-observability',
  title: 'Workflow observability',
  kind: 'data',
  defaultConfig: workflowObservabilityDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(workflowObservabilityDefaultConfig, config),
  Component({ config }) {
    const [filter, setFilter] = useState<WorkflowFilter>('all');
    const {
      data: workflows,
      error,
      isLoading,
    } = useQuery({
      queryKey: queryKeys.workflowObservability,
      queryFn: getWorkflowObservability,
      refetchInterval: Math.max(5, config.refreshSeconds) * 1000,
    });

    if (isLoading) {
      return (
        <EmptyState
          title="Workflows loading"
          detail="Reading recent Flue observations."
        />
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Workflows unavailable"
          detail={queryErrorMessage(error)}
        />
      );
    }

    if (!workflows) {
      return <EmptyState title="Workflows unavailable" detail="No data." />;
    }

    return (
      <WorkflowObservabilityView
        eventLimit={config.eventLimit}
        filter={filter}
        onFilterChange={setFilter}
        workflows={workflows}
      />
    );
  },
} satisfies DisplayPlugin<WorkflowObservabilityConfig>;

function WorkflowObservabilityView({
  eventLimit,
  filter,
  onFilterChange,
  workflows,
}: {
  eventLimit: number;
  filter: WorkflowFilter;
  onFilterChange: (filter: WorkflowFilter) => void;
  workflows: WorkflowObservability;
}) {
  const items = useMemo(
    () => workflowDrilldownItems(workflows, filter).slice(0, eventLimit),
    [eventLimit, filter, workflows],
  );
  const counts = workflowCounts(workflows);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <span className="text-violet">WORKFLOWS</span>
        <Badge className={counts.failed > 0 ? 'border-accent text-accent' : ''}>
          {counts.active} active · {counts.failed} failed
        </Badge>
      </header>
      <div className="border-b border-line px-3 py-2">
        <div className="grid grid-cols-4 gap-1.5 font-mono text-[10px] text-muted">
          <Metric label="progress" value={counts.progress} />
          <Metric label="logs" value={counts.activity} />
          <Metric label="events" value={counts.events} />
          <Metric label="runs" value={counts.active} />
        </div>
        <div className="mt-2 grid grid-cols-5 gap-1">
          {filters.map((option) => (
            <button
              className={
                option.id === filter
                  ? 'border border-primary bg-soft px-1.5 py-1 font-mono text-[10px] text-primary'
                  : 'border border-line bg-soft px-1.5 py-1 font-mono text-[10px] text-muted hover:border-primary hover:text-primary'
              }
              key={option.id}
              onClick={() => onFilterChange(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1.5 p-3">
          {items.map((item) => (
            <WorkflowDrilldownRow item={item} key={item.id} />
          ))}
          {items.length === 0 ? (
            <MiniEmpty label="No workflow observations in this filter." />
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function WorkflowDrilldownRow({ item }: { item: WorkflowDrilldownItem }) {
  return (
    <article
      className={
        item.kind === 'active'
          ? 'border border-primary/60 bg-soft px-2.5 py-2'
          : 'border border-line bg-soft px-2.5 py-2'
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[11px] text-ink">
            {item.title}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
            {item.message}
          </p>
        </div>
        <Badge
          className={
            item.isError
              ? 'border-accent text-accent'
              : item.kind === 'active'
                ? 'border-primary text-primary'
                : ''
          }
        >
          {item.badge}
        </Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {item.metadata} · {relativeTime(item.createdAt)}
        </span>
        {item.runUrl ? (
          <a
            className="shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary"
            href={item.runUrl}
            rel="noreferrer"
            target="_blank"
          >
            inspect
          </a>
        ) : null}
      </div>
    </article>
  );
}

export function workflowDrilldownItems(
  workflows: WorkflowObservability,
  filter: WorkflowFilter,
): WorkflowDrilldownItem[] {
  const items: WorkflowDrilldownItem[] = [];
  const seen = new Set<number>();

  if (filter === 'all' || filter === 'active') {
    for (const run of workflows.activeRuns) {
      items.push({
        id: `active:${run.runId}`,
        kind: 'active',
        title: run.workflow,
        message: run.lastMessage,
        createdAt: run.lastEventAt,
        metadata: run.runId,
        runUrl: run.runUrl,
        badge: `${run.eventCount} events`,
        isError: false,
      });
    }
  }

  if (filter === 'all' || filter === 'failed') {
    addEvents(items, seen, workflows.recentFailures, 'failed');
  }

  if (filter === 'all' || filter === 'progress') {
    addEvents(items, seen, workflows.recentData, 'progress');
  }

  if (filter === 'all' || filter === 'activity') {
    addEvents(items, seen, workflows.recentLogs, 'activity');
    addEvents(items, seen, workflows.recentTools, 'activity');
    addEvents(items, seen, workflows.recentOperations, 'activity');
  }

  if (filter === 'all') {
    addEvents(items, seen, workflows.recentEvents, 'event');
  }

  return items.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

function addEvents(
  items: WorkflowDrilldownItem[],
  seen: Set<number>,
  events: WorkflowEventRecord[],
  kind: WorkflowDrilldownItem['kind'],
) {
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    items.push(eventItem(event, kind));
  }
}

function eventItem(
  event: WorkflowEventRecord,
  kind: WorkflowDrilldownItem['kind'],
): WorkflowDrilldownItem {
  return {
    id: `${kind}:${event.id}`,
    kind,
    title: event.name ?? event.workflow ?? event.eventType,
    message: event.message,
    createdAt: event.createdAt,
    metadata:
      event.runId ?? event.operationId ?? event.operationKind ?? 'local',
    runUrl: event.runUrl,
    badge:
      kind === 'failed'
        ? 'failed'
        : (event.level ?? event.operationKind ?? event.eventType),
    isError: event.isError || kind === 'failed',
  };
}

function workflowCounts(workflows: WorkflowObservability) {
  return {
    active: workflows.activeRuns.length,
    failed: workflows.recentFailures.length,
    progress: workflows.recentData.length,
    activity:
      workflows.recentLogs.length +
      workflows.recentTools.length +
      workflows.recentOperations.length,
    events: workflows.recentEvents.length,
  };
}
