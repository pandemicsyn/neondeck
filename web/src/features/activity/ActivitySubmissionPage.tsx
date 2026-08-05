import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getActivitySubmission, type ActivityEventRecord } from '../../api';
import { Badge, EmptyState, MiniEmpty, ScrollArea } from '../../components/ui';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import { activitySubmissionMetrics } from './activity-metrics';

export function ActivitySubmissionPage({
  submissionId,
}: {
  submissionId: string;
}) {
  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.activitySubmission(submissionId),
    queryFn: ({ signal }) => getActivitySubmission(submissionId, { signal }),
    refetchInterval: (query) => {
      const status = query.state.data?.submission.status;
      return status === 'queued' || status === 'running' ? 2_000 : false;
    },
  });

  if (isLoading) {
    return (
      <ActivityShell submissionId={submissionId}>
        Loading activity…
      </ActivityShell>
    );
  }
  if (!data) {
    return (
      <ActivityShell submissionId={submissionId}>
        <EmptyState
          detail={
            error ? queryErrorMessage(error) : 'No activity was returned.'
          }
          title="Submission activity unavailable"
          tone="alert"
        />
      </ActivityShell>
    );
  }

  const { submission } = data;
  const metrics = activitySubmissionMetrics(data.events);
  const showReviewProgress =
    submission.agentName === 'pr-review-assistant' ||
    submission.agentName === 'pr-reviewer';
  return (
    <ActivityShell submissionId={submissionId} status={submission.status}>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <aside className="border-b border-line bg-soft lg:border-r lg:border-b-0">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 p-4 font-mono text-[11px]">
            <Fact label="agent" value={submission.agentName ?? 'unavailable'} />
            <Fact
              label="instance"
              value={submission.instanceId ?? 'unavailable'}
            />
            <Fact label="kind" value={submission.kind} />
            <Fact label="queued" value={formatTimestamp(submission.queuedAt)} />
            <Fact
              label="started"
              value={
                submission.startedAt
                  ? formatTimestamp(submission.startedAt)
                  : 'pending'
              }
            />
            <Fact
              label="settled"
              value={
                submission.settledAt
                  ? formatTimestamp(submission.settledAt)
                  : 'in progress'
              }
            />
            <Fact label="attempts" value={String(submission.attemptCount)} />
          </dl>
          {showReviewProgress ? (
            <ReviewProgress
              metrics={metrics}
              retained={data.eventHistory.retainedEventCount}
              total={data.eventHistory.totalEventCount}
              truncated={data.eventHistory.isTruncated}
            />
          ) : null}
        </aside>
        <ActivityTimeline
          events={data.events}
          retained={data.eventHistory.retainedEventCount}
          total={data.eventHistory.totalEventCount}
          truncated={data.eventHistory.isTruncated}
        />
      </div>
    </ActivityShell>
  );
}

function ReviewProgress({
  metrics,
  retained,
  total,
  truncated,
}: {
  metrics: ReturnType<typeof activitySubmissionMetrics>;
  retained: number;
  total: number;
  truncated: boolean;
}) {
  return (
    <section className="border-t border-line px-4 py-3 font-mono text-[10px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="m-0 font-medium tracking-[0.06em] text-violet">
          REVIEW PROGRESS
        </h2>
        {truncated ? <span className="text-accent">PARTIAL</span> : null}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
        <Fact
          label="coverage"
          value={truncated ? `${retained} of ${total} retained` : 'complete'}
        />
        <Fact label="model turns" value={formatCount(metrics.modelTurns)} />
        <Fact
          label="workspace calls"
          value={formatCount(metrics.workspaceToolCalls)}
        />
        <Fact
          label="model time"
          value={formatDuration(metrics.modelDurationMs)}
        />
        <Fact
          label="tool time"
          value={formatDuration(metrics.toolDurationMs)}
        />
        <Fact
          label="latest tokens"
          value={
            metrics.latestTotalTokens === null
              ? 'pending'
              : formatCount(metrics.latestTotalTokens)
          }
        />
        <Fact label="result payload" value={formatBytes(metrics.resultBytes)} />
        <Fact label="model" value={metrics.responseModel ?? 'pending'} />
        <Fact
          label="git operations"
          value={
            metrics.workspaceOperations.length
              ? metrics.workspaceOperations
                  .map(({ operation, count }) => `${operation} ${count}`)
                  .join(' · ')
              : 'pending'
          }
        />
      </dl>
    </section>
  );
}

function ActivityShell({
  children,
  status,
  submissionId,
}: {
  children: React.ReactNode;
  status?: string;
  submissionId: string;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-panel text-ink">
      <header className="flex min-h-10 items-center gap-3 border-b border-line bg-field px-3 font-mono text-[11px]">
        <a
          className="shrink-0 border border-line bg-soft px-2 py-1 text-muted hover:border-primary hover:text-primary"
          href="/"
        >
          dashboard
        </a>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[10px] tracking-[0.08em] text-violet">
            AGENT ACTIVITY
          </p>
          <h1 className="m-0 truncate text-[12px] font-medium text-ink">
            {submissionId}
          </h1>
        </div>
        {status ? (
          <Badge className={statusClass(status)}>{status}</Badge>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function ActivityTimeline({
  events,
  retained,
  total,
  truncated,
}: {
  events: ActivityEventRecord[];
  retained: number;
  total: number;
  truncated: boolean;
}) {
  const ordered = useMemo(
    () =>
      [...events].sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id - right.id,
      ),
    [events],
  );
  return (
    <section className="flex min-h-0 flex-col bg-panel">
      <header className="flex min-h-8 items-center justify-between border-b border-line px-4 font-mono text-[10px]">
        <h2 className="m-0 font-medium tracking-[0.06em] text-primary">
          EVENT TIMELINE
        </h2>
        <span className="text-muted">
          {truncated ? `${retained} of ${total}` : `${total} events`}
        </span>
      </header>
      <ScrollArea className="flex-1">
        {ordered.length ? (
          <ol className="m-0 list-none divide-y divide-line p-0">
            {ordered.map((event) => (
              <li
                className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 px-4 py-3"
                key={event.id}
              >
                <time
                  className="font-mono text-[9.5px] text-muted"
                  dateTime={event.createdAt}
                >
                  {formatTime(event.createdAt)}
                </time>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge
                      className={
                        event.isError ? 'border-accent text-accent' : ''
                      }
                    >
                      {event.eventType.replaceAll('_', ' ')}
                    </Badge>
                    {event.operationKind ? (
                      <span className="truncate font-mono text-[9.5px] text-muted">
                        {event.operationKind}
                      </span>
                    ) : null}
                  </div>
                  <p
                    className={
                      event.isError
                        ? 'mt-1 text-[11px] text-accent'
                        : 'mt-1 text-[11px] text-ink'
                    }
                  >
                    {event.message}
                  </p>
                  {event.summary !== null ? (
                    <details className="mt-1.5 border-t border-line/70 pt-1">
                      <summary className="cursor-pointer font-mono text-[9.5px] text-muted">
                        event details
                      </summary>
                      <pre className="m-0 mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words bg-field/50 p-2 font-mono text-[10px] text-ink">
                        {JSON.stringify(event.summary, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="p-3">
            <MiniEmpty label="No retained activity events." />
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-ink tabular-nums">{value}</dd>
    </>
  );
}

function statusClass(status: string) {
  if (status === 'failed' || status === 'aborted')
    return 'border-accent text-accent';
  if (status === 'queued' || status === 'running')
    return 'border-primary text-primary';
  return 'border-violet/60 text-violet';
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

function formatTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? value
    : new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      }).format(timestamp);
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatDuration(value: number) {
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
