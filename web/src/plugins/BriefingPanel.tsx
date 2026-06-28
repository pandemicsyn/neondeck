import { useEffect, useMemo, useState } from 'react';
import {
  getWorkflowSummaries,
  type WorkflowSummary,
  type WorkflowSummaryResponse,
} from '../api';
import { EmptyState } from '../App';
import { Badge, ScrollArea } from '../components/ui';
import type { DisplayPlugin } from '../types';

type BriefingPanelConfig = {
  actionLimit: number;
};

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; response: WorkflowSummaryResponse };

export const BriefingPanelPlugin = {
  id: 'briefing-panel',
  title: 'Briefing',
  kind: 'data',
  defaultConfig: {
    actionLimit: 5,
  },
  Component({ config }) {
    const [state, setState] = useState<State>({ status: 'loading' });

    useEffect(() => {
      let cancelled = false;

      async function load() {
        try {
          const response = await getWorkflowSummaries();
          if (!cancelled) setState({ status: 'ready', response });
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
        <EmptyState title="Briefing loading" detail="Reading summaries." />
      );
    }

    if (state.status === 'error') {
      return <EmptyState title="Briefing unavailable" detail={state.message} />;
    }

    const latest = state.response.items.find(
      (item) => item.workflow === 'command:briefing',
    );
    if (!latest) {
      return (
        <EmptyState
          title="No briefing yet"
          detail="Run /briefing to populate this panel."
        />
      );
    }

    return <BriefingView actionLimit={config.actionLimit} summary={latest} />;
  },
} satisfies DisplayPlugin<BriefingPanelConfig>;

function BriefingView({
  actionLimit,
  summary,
}: {
  actionLimit: number;
  summary: WorkflowSummary;
}) {
  const data = useMemo(() => readBriefing(summary.summary), [summary.summary]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="panel-header flex h-8 items-center justify-between border-b border-line px-3 font-mono text-[10.5px] tracking-[0.12em]">
        <span className="text-primary">BRIEFING</span>
        <Badge>{relativeTime(summary.createdAt)}</Badge>
      </header>
      <ScrollArea className="flex-1">
        <div className="space-y-2.5 p-3">
          <div className="grid grid-cols-3 gap-1.5 font-mono text-[10px] text-muted">
            <Metric label="repos" value={data.repos} />
            <Metric label="prs" value={data.reviewQueue} />
            <Metric label="alerts" value={data.notifications} />
          </div>
          <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px] text-muted">
            <Metric label="watches" value={data.watches} />
            <Metric label="jobs" value={data.jobs} />
          </div>
          <section>
            <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] tracking-[0.12em]">
              <span className="text-accent">TOP ACTIONS</span>
              <span className="text-muted">{data.topActions.length}</span>
            </div>
            <div className="space-y-1.5">
              {data.topActions.slice(0, actionLimit).map((action, index) => (
                <article
                  className="border border-line bg-soft px-2.5 py-2"
                  key={`${action.title}:${index}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[11px] text-ink">
                        {action.title}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[10.5px] leading-4 text-muted">
                        {action.reason ?? action.status ?? action.level ?? ''}
                      </p>
                    </div>
                    <Badge>{action.priority ?? action.status ?? 'item'}</Badge>
                  </div>
                </article>
              ))}
              {data.topActions.length === 0 ? (
                <MiniEmpty label="No top actions in the last briefing." />
              ) : null}
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

function readBriefing(summary: unknown) {
  const data = readRecord(readRecord(summary).data);
  return {
    repos: readNumber(readRecord(data.repos).count),
    reviewQueue: readNumber(readRecord(data.reviewQueue).count),
    watches: readNumber(readRecord(data.watches).active),
    jobs: readNumber(readRecord(data.jobs).active),
    notifications: readNumber(readRecord(data.notifications).unread),
    topActions: readArray(data.topActions).map(readAction),
  };
}

function readAction(value: unknown) {
  const record = readRecord(value);
  return {
    title: readString(record.title) ?? 'Untitled action',
    reason: readString(record.reason),
    priority: readString(record.priority),
    status: readString(record.status),
    level: readString(record.level),
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown) {
  return typeof value === 'number' ? value : 0;
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
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
