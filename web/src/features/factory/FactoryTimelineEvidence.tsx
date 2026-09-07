/* Bounded evidence supports keyboard scrolling. */
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FactoryTimelineEntry } from '../../../../shared/factory-diagnostics';
import { FactoryCodingEvidence } from './FactoryCodingEvidence';
import { FactoryCodingCandidate } from './FactoryCodingCandidate';
import { FactoryDeliveryEvidence } from './FactoryDeliveryEvidence';
import { loadFactoryTimelineEvidence } from './factory-timeline-evidence';
import { FactoryDeliveryProgressHistory } from './FactoryDeliveryProgressHistory';
import { FactoryDeliveryEvidenceContent } from './FactoryDeliveryEvidenceContent';

export function FactoryTimelineEvidence({
  entry,
}: {
  entry: FactoryTimelineEntry;
}) {
  const [open, setOpen] = useState(false);
  const { deliveryId, runId } = entry.correlation;
  // The timeline producer retains reservations separately from settled results.
  const reservation =
    entry.kind === 'judge' && entry.id.startsWith('judge-reserved:');
  const evidence = useQuery({
    queryKey: ['factory-timeline-evidence', entry],
    enabled: open && !reservation && !!(deliveryId || runId),
    retry: false,
    queryFn: ({ signal }) => loadFactoryTimelineEvidence(entry, signal),
  });
  const result = evidence.data;
  if (reservation)
    return (
      <p>
        Reference-only: these are the inputs recorded when the progress
        assessment was reserved. Inspect the settled assessment entry for result
        evidence.
      </p>
    );
  if (!deliveryId && !runId)
    return (
      <p>
        Reference-only: no recorded coding run or delivery binding is available
        for inspection.
      </p>
    );
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Inspect recorded evidence</summary>
      {open && (
        <section
          className="factory-operations-scroll"
          tabIndex={0}
          aria-label="Recorded evidence inspector"
        >
          {evidence.isPending && <output>Loading bound evidence…</output>}
          {evidence.error && (
            <p role="alert">
              {evidence.error.message}{' '}
              <button
                disabled={evidence.isFetching}
                onClick={() => void evidence.refetch()}
              >
                Retry evidence
              </button>
            </p>
          )}
          {result &&
            !evidence.error &&
            (result.kind === 'progress' ? (
              <FactoryDeliveryProgressHistory content={result.content} />
            ) : result.kind === 'coding' ? (
              <>
                <p>
                  {result.sourceRevision ? 'Repair target run' : 'Recorded run'}{' '}
                  {result.run.record.runId}. Logs may include later activity.
                  Worktree changes are current, not a frozen historical diff.
                </p>
                {result.sourceRevision && (
                  <p>
                    Historical source candidate: {result.sourceRevision.runId} ·
                    tree <code>{result.sourceRevision.treeSha}</code>. The
                    evidence below belongs to the repair target, not this source
                    candidate.
                  </p>
                )}
                <FactoryCodingEvidence id={result.run.record.runId} />
                {result.run.diff ? (
                  <FactoryCodingCandidate diff={result.run.diff} />
                ) : (
                  <p>No retained worktree diff is available.</p>
                )}
              </>
            ) : (
              <>
                <p>
                  {result.validation
                    ? 'Only the selected validation record is shown, bound to its recorded ID, receipt reference, kind, and exact revision.'
                    : 'Current pipeline evidence matches this entry’s exact revision. Pipeline status may include later activity.'}
                </p>
                {!result.validation ? (
                  <FactoryDeliveryEvidence detail={result.detail} />
                ) : (
                  result.matches.map((item) => (
                    <FactoryDeliveryEvidenceContent
                      key={item.id}
                      deliveryId={result.detail.pipeline.pipelineId}
                      evidence={item}
                      version={result.detail.pipeline.version}
                      label={`${item.kind} · ${item.result} · ${result.current ? 'Current' : 'Historical'} revision`}
                    />
                  ))
                )}
              </>
            ))}
        </section>
      )}
    </details>
  );
}
