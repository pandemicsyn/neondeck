import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  getWorkflowRun,
  type WorkflowEventRecord,
  type WorkflowRunInspectionResponse,
  type WorkflowRunRecord,
} from '../../api';
import { Badge, EmptyState, MiniEmpty, ScrollArea } from '../../components/ui';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import {
  formatWorkflowPayload,
  orderWorkflowRunEvents,
  terminalWorkflowRunSettleGraceMs,
  type WorkflowRunPayload,
  workflowRunRefreshDecision,
  workflowRunPayloads,
} from './workflow-run-inspector';

export function WorkflowRunInspectorPage({ runId }: { runId: string }) {
  const terminalPendingSince = useRef<number | null>(null);
  const [terminalSettlementExpired, setTerminalSettlementExpired] =
    useState(false);
  const { data, error, isLoading, isRefetchError } = useQuery({
    queryKey: queryKeys.workflowRun(runId),
    queryFn: ({ signal }) => getWorkflowRun(runId, { signal }),
    refetchInterval: (query) => {
      const decision = workflowRunRefreshDecision(
        query.state.data,
        terminalPendingSince.current,
        Date.now(),
      );
      terminalPendingSince.current = decision.terminalPendingSince;
      return decision.interval;
    },
  });
  const hasTerminalEvent =
    data?.events.some((event) => event.eventType === 'run_end') ?? false;
  const needsTerminalSettlement =
    data?.run.status !== undefined &&
    data.run.status !== 'active' &&
    !hasTerminalEvent &&
    !data.eventHistory.isTruncated;

  useEffect(() => {
    if (!needsTerminalSettlement) {
      setTerminalSettlementExpired(false);
      return;
    }
    const pendingSince = terminalPendingSince.current ?? Date.now();
    const remaining =
      pendingSince + terminalWorkflowRunSettleGraceMs - Date.now();
    if (remaining <= 0) {
      setTerminalSettlementExpired(true);
      return;
    }
    const timer = window.setTimeout(
      () => setTerminalSettlementExpired(true),
      remaining,
    );
    return () => window.clearTimeout(timer);
  }, [data?.fetchedAt, needsTerminalSettlement, runId]);

  if (isLoading) {
    return (
      <WorkflowRunInspectorShell runId={runId}>
        <WorkflowRunLoadingState />
      </WorkflowRunInspectorShell>
    );
  }

  if (!data) {
    return (
      <WorkflowRunInspectorShell runId={runId}>
        <EmptyState
          detail={
            error
              ? queryErrorMessage(error)
              : 'The workflow run returned no inspection data.'
          }
          title="Workflow run unavailable"
          tone="alert"
        />
      </WorkflowRunInspectorShell>
    );
  }

  return (
    <WorkflowRunInspectorView
      eventHistory={data.eventHistory}
      events={data.events}
      isSettling={needsTerminalSettlement && !terminalSettlementExpired}
      refreshError={isRefetchError ? queryErrorMessage(error) : undefined}
      run={data.run}
      terminalEventUnavailable={
        needsTerminalSettlement && terminalSettlementExpired
      }
    />
  );
}

export function WorkflowRunInspectorView({
  eventHistory,
  events,
  isSettling = false,
  refreshError,
  run,
  terminalEventUnavailable = false,
}: {
  eventHistory?: WorkflowRunInspectionResponse['eventHistory'];
  events?: WorkflowEventRecord[];
  isSettling?: boolean;
  refreshError?: string;
  run: WorkflowRunRecord;
  terminalEventUnavailable?: boolean;
}) {
  const timelineEvents = events ?? [];
  const resolvedEventHistory = eventHistory ?? {
    totalEventCount: timelineEvents.length,
    retainedEventCount: timelineEvents.length,
    isTruncated: false,
  };
  const payloads = workflowRunPayloads(run);
  const inspection = {
    run,
    events: timelineEvents,
    eventHistory: resolvedEventHistory,
  };
  return (
    <WorkflowRunInspectorShell inspection={inspection} runId={run.runId}>
      {refreshError ? (
        <output
          aria-live="polite"
          className="block border-b border-line bg-soft px-4 py-1.5 font-mono text-[10px] text-muted"
        >
          Refresh delayed; showing the last successful inspection.{' '}
          {refreshError}
        </output>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <aside className="border-b border-line bg-soft lg:border-r lg:border-b-0">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 p-4 font-mono text-[11px]">
            <RunFact label="workflow" value={run.workflowName} />
            <RunFact label="run id" value={run.runId} />
            <RunFact label="started" value={formatTimestamp(run.startedAt)} />
            <RunFact
              label="ended"
              value={run.endedAt ? formatTimestamp(run.endedAt) : 'in progress'}
            />
            <RunFact
              label="duration"
              value={formatRunDuration(run.durationMs)}
            />
            {run.traceCarrier?.traceparent ? (
              <RunFact label="trace" value={run.traceCarrier.traceparent} />
            ) : null}
          </dl>
        </aside>
        <div className="grid min-h-0 min-w-0 grid-cols-1 overflow-auto xl:grid-cols-[minmax(340px,0.9fr)_minmax(380px,1.1fr)] xl:overflow-hidden">
          <WorkflowEventTimeline
            eventHistory={resolvedEventHistory}
            events={timelineEvents}
            isActive={run.status === 'active'}
            isSettling={isSettling}
            terminalEventUnavailable={terminalEventUnavailable}
          />
          <ScrollArea className="min-h-0 border-t border-line bg-panel xl:border-t-0">
            <div className="divide-y divide-line">
              {payloads.map((payload) => (
                <WorkflowRunPayload key={payload.label} payload={payload} />
              ))}
            </div>
          </ScrollArea>
        </div>
      </div>
    </WorkflowRunInspectorShell>
  );
}

function WorkflowEventTimeline({
  eventHistory,
  events,
  isActive,
  isSettling,
  terminalEventUnavailable,
}: {
  eventHistory: WorkflowRunInspectionResponse['eventHistory'];
  events: WorkflowEventRecord[];
  isActive: boolean;
  isSettling: boolean;
  terminalEventUnavailable: boolean;
}) {
  const orderedEvents = useMemo(() => orderWorkflowRunEvents(events), [events]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);

  useEffect(() => {
    if (!followsLatest.current || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [orderedEvents.length]);

  return (
    <section
      aria-labelledby="workflow-run-events"
      className="flex min-h-[260px] flex-col bg-panel xl:min-h-0 xl:border-r xl:border-line"
    >
      <header className="flex min-h-8 items-center justify-between gap-3 border-b border-line px-4 font-mono text-[10px]">
        <h2
          className="m-0 font-medium tracking-[0.06em] text-primary"
          id="workflow-run-events"
        >
          EVENT TIMELINE
        </h2>
        <div
          aria-live="polite"
          className="flex items-center gap-1.5 tabular-nums"
        >
          {isActive ? (
            <Badge className="border-primary/60 text-primary">live</Badge>
          ) : null}
          {isSettling ? (
            <Badge className="border-violet/60 text-violet">settling</Badge>
          ) : null}
          {terminalEventUnavailable ? (
            <Badge className="border-accent/60 text-accent">incomplete</Badge>
          ) : null}
          <span className="text-muted">
            {eventHistory.isTruncated
              ? `${eventHistory.retainedEventCount} of ${eventHistory.totalEventCount}`
              : eventCountLabel(eventHistory.totalEventCount)}
          </span>
        </div>
      </header>
      {eventHistory.isTruncated ? (
        <p
          className="m-0 border-b border-line bg-soft px-4 py-2 font-mono text-[9.5px] leading-4 text-muted"
          role="note"
        >
          Local retention preserved {eventHistory.retainedEventCount} of{' '}
          {eventHistory.totalEventCount} observed events for this run.
        </p>
      ) : null}
      {terminalEventUnavailable ? (
        <p
          className="m-0 border-b border-line bg-soft px-4 py-2 font-mono text-[9.5px] leading-4 text-muted"
          role="note"
        >
          The final run_end observation is unavailable; this timeline may be
          incomplete.
        </p>
      ) : null}
      <ScrollArea
        className="max-h-[55vh] flex-1 xl:max-h-none"
        onScroll={(event) => {
          const target = event.currentTarget;
          followsLatest.current =
            target.scrollHeight - target.scrollTop - target.clientHeight < 48;
        }}
        ref={scrollRef}
      >
        {orderedEvents.length > 0 ? (
          <ol className="m-0 list-none divide-y divide-line p-0">
            {orderedEvents.map((event) => (
              <WorkflowEventRow event={event} key={event.id} />
            ))}
          </ol>
        ) : (
          <div className="p-3">
            <MiniEmpty label="No retained observations for this run." />
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function WorkflowEventRow({ event }: { event: WorkflowEventRecord }) {
  const metadata = [
    event.eventIndex === null ? null : `#${event.eventIndex}`,
    event.name,
    event.operationKind,
    event.durationMs === null ? null : formatRunDuration(event.durationMs),
  ].filter((value): value is string => Boolean(value));

  return (
    <li
      className="grid grid-cols-[68px_minmax(0,1fr)] gap-3 px-4 py-3"
      data-workflow-event={event.eventType}
    >
      <time
        className="font-mono text-[9.5px] leading-5 text-muted tabular-nums"
        dateTime={event.createdAt}
        title={formatTimestamp(event.createdAt)}
      >
        {formatEventTime(event.createdAt)}
      </time>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Badge className={workflowEventBadgeClass(event)}>
            {workflowEventLabel(event.eventType)}
          </Badge>
          {metadata.length > 0 ? (
            <span className="min-w-0 truncate font-mono text-[9.5px] text-muted tabular-nums">
              {metadata.join(' · ')}
            </span>
          ) : null}
        </div>
        <p
          className={`mt-1 text-[11px] leading-4 ${
            event.isError ? 'text-accent' : 'text-ink'
          }`}
        >
          {event.message}
        </p>
        {event.summary !== null ? (
          <details className="mt-1.5 border-t border-line/70 pt-1">
            <summary className="cursor-pointer font-mono text-[9.5px] text-muted hover:text-primary focus:outline-none focus-visible:text-primary">
              event data
            </summary>
            <pre className="m-0 mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words bg-field/50 p-2 font-mono text-[10px] leading-[1.55] text-ink tabular-nums">
              <code>{formatWorkflowPayload(event.summary)}</code>
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function WorkflowRunInspectorShell({
  children,
  inspection,
  runId,
}: {
  children: ReactNode;
  inspection?: {
    run: WorkflowRunRecord;
    events: WorkflowEventRecord[];
    eventHistory: WorkflowRunInspectionResponse['eventHistory'];
  };
  runId: string;
}) {
  const run = inspection?.run;
  return (
    <section className="flex h-full min-h-0 flex-col bg-panel text-ink">
      <header className="flex min-h-10 items-center gap-3 border-b border-line bg-field px-3 font-mono text-[11px]">
        <a
          className="shrink-0 border border-line bg-soft px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
          href="/"
        >
          dashboard
        </a>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] tracking-[0.08em] text-violet">
            WORKFLOW RUN
          </p>
          <h1 className="m-0 truncate text-[12px] font-medium text-ink">
            {run?.workflowName ?? runId}
          </h1>
        </div>
        {run ? (
          <Badge className={workflowRunStatusClass(run.status)}>
            {run.status}
          </Badge>
        ) : null}
        {inspection ? (
          <CopyInspectionJsonButton inspection={inspection} />
        ) : null}
      </header>
      {children}
    </section>
  );
}

function CopyInspectionJsonButton({
  inspection,
}: {
  inspection: {
    run: WorkflowRunRecord;
    events: WorkflowEventRecord[];
    eventHistory: WorkflowRunInspectionResponse['eventHistory'];
  };
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      aria-label="Copy inspection JSON"
      className="shrink-0 border border-line bg-soft px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(
            formatWorkflowPayload(inspection),
          );
          setState('copied');
        } catch {
          setState('failed');
        }
      }}
      title={state === 'failed' ? 'Clipboard access failed' : undefined}
      type="button"
    >
      {state === 'copied'
        ? 'copied'
        : state === 'failed'
          ? 'copy failed'
          : 'copy all JSON'}
    </button>
  );
}

function RunFact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink tabular-nums">{value}</dd>
    </>
  );
}

function WorkflowRunPayload({ payload }: { payload: WorkflowRunPayload }) {
  return (
    <section aria-labelledby={`workflow-run-${payload.label}`}>
      <div className="flex min-h-8 items-center justify-between border-b border-line px-4 font-mono text-[10px]">
        <h2
          className={`m-0 font-medium tracking-[0.06em] ${
            payload.tone === 'error' ? 'text-accent' : 'text-primary'
          }`}
          id={`workflow-run-${payload.label}`}
        >
          {payload.label.toUpperCase()}
        </h2>
        <span className="text-muted">formatted JSON</span>
      </div>
      <pre className="m-0 max-h-[42vh] overflow-auto whitespace-pre-wrap break-words bg-field/50 p-4 font-mono text-[11.5px] leading-[1.6] text-ink tabular-nums">
        <code>{formatWorkflowPayload(payload.value)}</code>
      </pre>
    </section>
  );
}

function WorkflowRunLoadingState() {
  return (
    <output
      aria-label="Loading workflow run"
      className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]"
    >
      <span className="min-h-40 animate-pulse border-b border-line bg-soft lg:border-r lg:border-b-0" />
      <span className="min-h-64 animate-pulse bg-field/50" />
      <span className="sr-only">Loading workflow run inspection.</span>
    </output>
  );
}

function workflowRunStatusClass(status: WorkflowRunRecord['status']) {
  if (status === 'errored') return 'border-accent text-accent';
  if (status === 'active') return 'border-primary text-primary';
  return 'border-violet/60 text-violet';
}

function formatRunDuration(durationMs: number | undefined) {
  if (durationMs === undefined) return 'in progress';
  if (durationMs < 1_000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(timestamp);
}

function formatEventTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(timestamp);
}

function workflowEventLabel(eventType: string) {
  return eventType.replaceAll('_', ' ');
}

function workflowEventBadgeClass(event: WorkflowEventRecord) {
  if (event.isError || event.level === 'error') {
    return 'border-accent/60 text-accent';
  }
  if (event.eventType === 'run_start' || event.eventType === 'run_end') {
    return 'border-violet/60 text-violet';
  }
  if (
    event.eventType === 'tool' ||
    event.eventType === 'tool_start' ||
    event.eventType === 'operation' ||
    event.eventType === 'operation_start'
  ) {
    return 'border-primary/60 text-primary';
  }
  return '';
}

function eventCountLabel(count: number) {
  return `${count} ${count === 1 ? 'event' : 'events'}`;
}
