import './FactoryCodingEvidence.css';
import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  getFactoryCodingEvents,
  getFactoryCodingLogs,
} from '../../api/factory-coding';

export function FactoryCodingEvidence({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="factory-coding-evidence"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Execution history and bounded logs</summary>
      {open && <EvidencePages id={id} />}
    </details>
  );
}
function EvidencePages({ id }: { id: string }) {
  const [offsets, setOffsets] = useState([0]);
  const offset = offsets.at(-1)!;
  const events = useInfiniteQuery({
    queryKey: ['factory-coding-events', id],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      getFactoryCodingEvents(id, pageParam, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const logs = useQuery({
    queryKey: ['factory-coding-logs', id, offset],
    queryFn: ({ signal }) => getFactoryCodingLogs(id, offset, { signal }),
  });
  return (
    <>
      <div className="factory-toolbar">
        <h4>Recorded events</h4>
        <button
          disabled={events.isFetching}
          onClick={() => void events.refetch()}
        >
          {events.isFetching ? 'Refreshing events…' : 'Refresh events'}
        </button>
      </div>
      {events.isPending && <output>Loading recorded events…</output>}
      {events.error && (
        <p role="alert">Event history unavailable. Refresh events to retry.</p>
      )}
      {events.data && (
        <ol className="factory-coding-events">
          {events.data.pages
            .flatMap((page) => page.items)
            .map((event) => (
              <li key={event.sequence}>
                <span>
                  {event.type} · {event.status}
                </span>
                <time dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
        </ol>
      )}
      {events.data?.pages.every((page) => page.items.length === 0) && (
        <p>No execution events recorded yet.</p>
      )}
      {events.hasNextPage && (
        <button
          disabled={events.isFetchingNextPage}
          onClick={() => void events.fetchNextPage()}
        >
          Load more events
        </button>
      )}
      <div className="factory-toolbar">
        <h4>Log excerpt</h4>
        <button disabled={logs.isFetching} onClick={() => void logs.refetch()}>
          {logs.isFetching ? 'Refreshing log…' : 'Refresh log'}
        </button>
      </div>
      <p className="factory-note">
        Up to 16 KiB per page. Log text is untrusted execution output.
      </p>
      {logs.isPending && <output>Loading log excerpt…</output>}
      {logs.error && (
        <p role="alert">Log excerpt unavailable. Refresh log to retry.</p>
      )}
      {logs.data && (
        <>
          <pre tabIndex={0} role="region" aria-label="Coding log excerpt">
            {logs.data.text || 'No log output at this offset.'}
          </pre>
          <p className="factory-note">
            Bytes {offset}–{logs.data.nextOffset}
            {logs.data.truncated
              ? ' · More output is available.'
              : ' · End of current output.'}
          </p>
        </>
      )}
      <div className="factory-toolbar">
        <button
          disabled={offsets.length === 1}
          onClick={() => setOffsets(offsets.slice(0, -1))}
        >
          Previous log excerpt
        </button>
        <button disabled={offset === 0} onClick={() => setOffsets([0])}>
          Back to log start
        </button>
        <button
          disabled={
            logs.isFetching ||
            !!logs.error ||
            !logs.data?.truncated ||
            logs.data.nextOffset <= offset
          }
          onClick={() => {
            if (logs.data) setOffsets([...offsets, logs.data.nextOffset]);
          }}
        >
          Next log excerpt
        </button>
      </div>
    </>
  );
}
