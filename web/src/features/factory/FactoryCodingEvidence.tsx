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
  const [offset, setOffset] = useState(0);
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
        <button onClick={() => void events.refetch()}>Refresh events</button>
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
                <time>{event.createdAt}</time>
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
        <button onClick={() => void logs.refetch()}>Refresh log</button>
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
          <pre aria-label="Coding log excerpt">
            {logs.data.text || 'No log output at this offset.'}
          </pre>
          <p className="factory-note">
            Bytes {offset}–{logs.data.nextOffset}
            {logs.data.truncated
              ? ' · More output is available.'
              : ' · End of current output.'}
          </p>
          <div className="factory-toolbar">
            <button disabled={offset === 0} onClick={() => setOffset(0)}>
              Back to log start
            </button>
            <button
              disabled={!logs.data.truncated || logs.data.nextOffset <= offset}
              onClick={() => {
                if (logs.data) setOffset(logs.data.nextOffset);
              }}
            >
              Next log excerpt
            </button>
          </div>
        </>
      )}
    </>
  );
}
