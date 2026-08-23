import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  getPrWatches,
  getActivityObservability,
  type PrWatch,
  type ActivityEventRecord,
  type ActivityObservability,
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

type ActivityPanelConfig = {
  eventLimit: number;
  refreshSeconds: number;
};

type ActivityFilter = 'all' | 'active' | 'failed' | 'settled' | 'activity';

type ActivityItem = {
  id: string;
  kind: Exclude<ActivityFilter, 'all'> | 'event';
  title: string;
  message: string;
  createdAt: string;
  metadata: string;
  detailUrl: string | null;
  badge: string;
  isError: boolean;
  contextLabel: string;
};

type WorkflowOwnerWatch = Pick<
  PrWatch,
  'ownerInstanceId' | 'repoFullName' | 'prNumber'
>;

const activityPanelDefaultConfig = {
  eventLimit: 18,
  refreshSeconds: 20,
};

const filters: Array<{
  id: ActivityFilter;
  label: string;
}> = [
  { id: 'all', label: 'all' },
  { id: 'active', label: 'active' },
  { id: 'failed', label: 'failed' },
  { id: 'settled', label: 'settled' },
  { id: 'activity', label: 'activity' },
];

export const ActivityPanelPlugin = {
  id: 'activity',
  title: 'Agent activity',
  kind: 'data',
  defaultConfig: activityPanelDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(activityPanelDefaultConfig, config),
  Component({ config }) {
    const [filter, setFilter] = useState<ActivityFilter>('all');
    const {
      data: workflows,
      error,
      isLoading,
    } = useQuery({
      queryKey: queryKeys.activityObservability,
      queryFn: getActivityObservability,
      refetchInterval: Math.max(5, config.refreshSeconds) * 1000,
    });
    const { data: watches } = useQuery({
      queryKey: queryKeys.prWatches,
      queryFn: getPrWatches,
      refetchInterval: Math.max(5, config.refreshSeconds) * 1000,
    });

    if (isLoading) {
      return (
        <EmptyState
          title="Activity loading"
          detail="Reading recent agent and submission activity."
        />
      );
    }

    if (error) {
      return (
        <EmptyState
          title="Activity unavailable"
          detail={queryErrorMessage(error)}
          tone="alert"
        />
      );
    }

    if (!workflows) {
      return (
        <EmptyState
          title="Activity unavailable"
          detail="No data."
          tone="alert"
        />
      );
    }

    return (
      <ActivityView
        eventLimit={config.eventLimit}
        filter={filter}
        onFilterChange={setFilter}
        watches={watches?.watches ?? []}
        workflows={workflows}
      />
    );
  },
} satisfies DisplayPlugin<ActivityPanelConfig>;

function ActivityView({
  eventLimit,
  filter,
  onFilterChange,
  watches,
  workflows,
}: {
  eventLimit: number;
  filter: ActivityFilter;
  onFilterChange: (filter: ActivityFilter) => void;
  watches: PrWatch[];
  workflows: ActivityObservability;
}) {
  const items = useMemo(
    () => activityItems(workflows, filter, watches).slice(0, eventLimit),
    [eventLimit, filter, watches, workflows],
  );
  const counts = activityCounts(workflows);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <h2 className="m-0 text-[inherit] font-[inherit] text-violet">
          ACTIVITY
        </h2>
        <Badge className={counts.failed > 0 ? 'border-accent text-accent' : ''}>
          {counts.active} active · {counts.failed} failed
        </Badge>
      </header>
      <div className="border-b border-line px-3 py-2">
        <div className="grid grid-cols-4 gap-1.5 font-mono text-[10px] text-muted">
          <Metric label="active" value={counts.active} />
          <Metric label="failed" value={counts.failed} />
          <Metric label="settled" value={counts.settled} />
          <Metric label="events" value={counts.events} />
        </div>
        <fieldset
          aria-label="Agent activity"
          className="m-0 mt-2 grid min-w-0 grid-cols-5 gap-1 border-0 p-0"
        >
          {filters.map((option) => (
            <button
              aria-pressed={option.id === filter}
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
        </fieldset>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1.5 p-3">
          {items.map((item) => (
            <ActivityRow item={item} key={item.id} />
          ))}
          {items.length === 0 ? (
            <MiniEmpty label="No agent activity in this filter." />
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
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
          <p
            className="mt-0.5 truncate font-mono text-[10px] text-primary"
            title={item.contextLabel}
          >
            <span className="text-muted">context</span> · {item.contextLabel}
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
        {item.detailUrl ? (
          <a
            className="shrink-0 border border-line px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary"
            href={item.detailUrl}
          >
            inspect
          </a>
        ) : null}
      </div>
    </article>
  );
}

export function activityItems(
  workflows: ActivityObservability,
  filter: ActivityFilter,
  watches: WorkflowOwnerWatch[] = [],
): ActivityItem[] {
  const items: ActivityItem[] = [];
  const seen = new Set<number>();
  const watchesByOwner = new Map(
    watches.flatMap((watch) =>
      watch.ownerInstanceId ? [[watch.ownerInstanceId, watch] as const] : [],
    ),
  );

  if (filter === 'all' || filter === 'active') {
    for (const submission of workflows.activeSubmissions) {
      items.push({
        id: `active:${submission.submissionId}`,
        kind: 'active',
        title: submission.agentName ?? 'agent submission',
        message: submission.lastMessage,
        createdAt: submission.lastEventAt,
        metadata: submission.submissionId,
        detailUrl: submission.detailUrl,
        badge: `${submission.eventCount} events`,
        isError: false,
        contextLabel: submission.instanceId
          ? `${agentLabel(submission.agentName ?? 'agent')} · ${submission.instanceId}`
          : agentLabel(submission.agentName ?? 'agent'),
      });
    }
  }

  if (filter === 'all' || filter === 'failed') {
    addEvents(items, seen, workflows.recentFailures, 'failed', watchesByOwner);
  }

  if (filter === 'all' || filter === 'settled') {
    addEvents(
      items,
      seen,
      workflows.recentSettlements,
      'settled',
      watchesByOwner,
    );
  }

  if (filter === 'activity') {
    addEvents(items, seen, workflows.recentEvents, 'activity', watchesByOwner);
  }

  return items.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

function addEvents(
  items: ActivityItem[],
  seen: Set<number>,
  events: ActivityEventRecord[],
  kind: ActivityItem['kind'],
  watchesByOwner: ReadonlyMap<string, WorkflowOwnerWatch>,
) {
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    items.push(eventItem(event, kind, watchesByOwner));
  }
}

function eventItem(
  event: ActivityEventRecord,
  kind: ActivityItem['kind'],
  watchesByOwner: ReadonlyMap<string, WorkflowOwnerWatch>,
): ActivityItem {
  return {
    id: `${kind}:${event.id}`,
    kind,
    title: event.name ?? event.agentName ?? event.eventType,
    message: event.message,
    createdAt: event.createdAt,
    metadata:
      event.submissionId ?? event.operationId ?? event.operationKind ?? 'local',
    detailUrl: event.detailUrl,
    badge:
      kind === 'failed'
        ? 'failed'
        : (event.level ?? event.operationKind ?? event.eventType),
    isError: event.isError || kind === 'failed',
    contextLabel: workflowEventContext(event, watchesByOwner),
  };
}

function workflowEventContext(
  event: ActivityEventRecord,
  watchesByOwner: ReadonlyMap<string, WorkflowOwnerWatch>,
) {
  const watch = event.instanceId
    ? watchesByOwner.get(event.instanceId)
    : undefined;
  if (watch) {
    return `${watch.repoFullName}#${watch.prNumber} · PR owner`;
  }
  if (event.agentName) {
    return event.instanceId
      ? `${agentLabel(event.agentName)} · ${event.instanceId}`
      : agentLabel(event.agentName);
  }
  return event.submissionId ? 'agent submission' : 'local runtime';
}

function agentLabel(agentName: string) {
  if (agentName === 'pr-autopilot-owner') return 'PR owner';
  if (agentName === 'display-assistant') return 'Neon chat';
  return agentName;
}

function activityCounts(workflows: ActivityObservability) {
  return {
    active: workflows.activeSubmissions.length,
    failed: workflows.recentFailures.length,
    settled: workflows.recentSettlements.length,
    events: workflows.recentEvents.length,
  };
}
