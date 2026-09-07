import { FactoryTimelineEvidence } from './FactoryTimelineEvidence';
/* Bounded regions intentionally support keyboard scrolling. */
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getFactoryHealth,
  getFactoryTimeline,
} from '../../api/factory-diagnostics';
import { FactoryOperationsTask, operationsTime } from './FactoryOperations';
import { FactoryOperationsPreview } from './FactoryOperationsPreview';
import type { FactoryTimelineEntry } from '../../../../shared/factory-diagnostics';
import './FactoryOperations.css';

function TimelineEntry({ entry }: { entry: FactoryTimelineEntry }) {
  const [copyStatus, setCopyStatus] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(entry.correlation, null, 2),
      );
      setCopyStatus('Correlation copied.');
    } catch {
      setCopyStatus('Copy unavailable. Select the correlation values below.');
    }
  }
  return (
    <li className="factory-timeline-entry">
      <h4>{entry.summary}</h4>
      <p className="factory-operations-meta">
        {entry.kind} · {entry.recordType} ·{' '}
        {entry.timeBasis === 'unknown'
          ? 'Time not recorded'
          : operationsTime(entry.occurredAt)}
      </p>
      <p>
        Actor:{' '}
        {entry.actor
          ? `${entry.actor.kind} · ${entry.actor.id}`
          : 'Not recorded'}
        {entry.correlation.specVersion !== undefined &&
          ` · Specification v${entry.correlation.specVersion}`}
      </p>
      <details>
        <summary>
          Correlation and evidence · {entry.evidenceRefs.length} references
        </summary>
        <button onClick={() => void copy()}>Copy correlation IDs</button>
        <output>{copyStatus}</output>
        <dl className="factory-operations-facts">
          {Object.entries(entry.correlation).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                <code>{value}</code>
              </dd>
            </div>
          ))}
        </dl>
        {entry.revision && (
          <>
            <p>
              {entry.kind === 'repair'
                ? 'Historical repair source revision'
                : 'Exact revision binding'}
            </p>
            {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
            <pre
              className="factory-operations-json"
              tabIndex={0}
              aria-label="Exact revision binding"
            >
              {JSON.stringify(entry.revision, null, 2)}
            </pre>
          </>
        )}
        {entry.evidenceRefs.length ? (
          <ul aria-label="Recorded evidence references">
            {entry.evidenceRefs.map((ref, i) => (
              <li key={`${i}:${ref}`}>
                <code>{ref}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>No evidence references recorded.</p>
        )}
        {entry.repairTarget && (
          <p>
            Repair target: run <code>{entry.repairTarget.runId}</code> · attempt{' '}
            <code>{entry.repairTarget.attemptId}</code>
          </p>
        )}
        <FactoryTimelineEvidence entry={entry} />
      </details>
    </li>
  );
}
export function FactoryTimeline({ workId }: { workId: string }) {
  const [open, setOpen] = useState(false);
  const [cursors, setCursors] = useState<string[]>([]);
  const [generation, setGeneration] = useState(0);
  const cursor = cursors.at(-1);
  const timeline = useQuery({
    queryKey: ['factory-operations-timeline', workId, generation, cursor],
    queryFn: () => getFactoryTimeline(workId, cursor),
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    retry: false,
  });
  const health = useQuery({
    queryKey: ['factory-operations-health', workId],
    queryFn: () => getFactoryHealth(workId),
    enabled: open,
    refetchInterval: open ? 15000 : false,
  });
  return (
    <details
      className="factory-timeline"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Task timeline and diagnostics</summary>
      {open && (
        <>
          {health.data?.tasks.map((task) => (
            <FactoryOperationsTask task={task} key={task.workId} />
          ))}
          {health.isPending && <output>Loading task diagnosis…</output>}
          {health.error && (
            <p role="alert">
              Task diagnosis unavailable.
              {health.data &&
                ' Showing the last loaded snapshot; it may be stale.'}{' '}
              <button
                disabled={health.isFetching}
                onClick={() => void health.refetch()}
              >
                Retry diagnosis
              </button>
            </p>
          )}
          <div className="factory-toolbar">
            <h3>Recorded timeline</h3>
            <button
              disabled={timeline.isFetching}
              onClick={() => {
                setCursors([]);
                setGeneration((value) => value + 1);
              }}
            >
              Refresh timeline
            </button>
          </div>
          {timeline.isFetching && <output>Loading timeline…</output>}
          {timeline.error && (
            <p role="alert">
              {timeline.error.message}. Refresh timeline to start from the
              latest records.
              {timeline.data && ' The last loaded page is retained.'}
            </p>
          )}
          {timeline.data && (
            <>
              <p className="factory-operations-meta">
                {timeline.data.coverage.note}
                {timeline.data.coverage.truncated && ' Coverage is limited.'}
              </p>
              <section
                className="factory-operations-scroll"
                tabIndex={0}
                aria-label="Task timeline entries"
                key={cursor ?? 'first'}
              >
                {timeline.data.entries.length ? (
                  <ol>
                    {timeline.data.entries.map((entry) => (
                      <TimelineEntry key={entry.id} entry={entry} />
                    ))}
                  </ol>
                ) : (
                  <p>No retained timeline records for this task.</p>
                )}
              </section>
            </>
          )}
          <nav className="factory-toolbar" aria-label="Timeline pagination">
            <button
              disabled={!cursors.length || timeline.isFetching}
              onClick={() => setCursors((values) => values.slice(0, -1))}
            >
              Previous page
            </button>
            <span>Page {cursors.length + 1}</span>
            <button
              disabled={
                !timeline.data?.nextCursor ||
                timeline.isFetching ||
                !!timeline.error
              }
              onClick={() => {
                if (timeline.data?.nextCursor)
                  setCursors((values) => [
                    ...values,
                    timeline.data.nextCursor!,
                  ]);
              }}
            >
              Next page
            </button>
          </nav>
          <FactoryOperationsPreview key={workId} workId={workId} />
        </>
      )}
    </details>
  );
}
