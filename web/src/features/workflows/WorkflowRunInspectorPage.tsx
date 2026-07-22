import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { getWorkflowRun, type WorkflowRunRecord } from '../../api';
import { Badge, EmptyState, ScrollArea } from '../../components/ui';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import {
  formatWorkflowPayload,
  type WorkflowRunPayload,
  workflowRunPayloads,
} from './workflow-run-inspector';

export function WorkflowRunInspectorPage({ runId }: { runId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.workflowRun(runId),
    queryFn: ({ signal }) => getWorkflowRun(runId, { signal }),
  });

  if (isLoading) {
    return (
      <WorkflowRunInspectorShell runId={runId}>
        <WorkflowRunLoadingState />
      </WorkflowRunInspectorShell>
    );
  }

  if (error || !data) {
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

  return <WorkflowRunInspectorView run={data.run} />;
}

export function WorkflowRunInspectorView({ run }: { run: WorkflowRunRecord }) {
  const payloads = workflowRunPayloads(run);
  return (
    <WorkflowRunInspectorShell run={run} runId={run.runId}>
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
        <ScrollArea className="min-h-0 bg-panel">
          <div className="divide-y divide-line">
            {payloads.map((payload) => (
              <WorkflowRunPayload key={payload.label} payload={payload} />
            ))}
          </div>
        </ScrollArea>
      </div>
    </WorkflowRunInspectorShell>
  );
}

function WorkflowRunInspectorShell({
  children,
  run,
  runId,
}: {
  children: ReactNode;
  run?: WorkflowRunRecord;
  runId: string;
}) {
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
        {run ? <CopyRunJsonButton run={run} /> : null}
      </header>
      {children}
    </section>
  );
}

function CopyRunJsonButton({ run }: { run: WorkflowRunRecord }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      className="shrink-0 border border-line bg-soft px-2 py-1 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(formatWorkflowPayload(run));
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
          : 'copy JSON'}
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
