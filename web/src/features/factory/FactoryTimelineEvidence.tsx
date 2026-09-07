/* Bounded evidence supports keyboard scrolling. */
/* oxlint-disable jsx-a11y/no-noninteractive-tabindex */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FactoryTimelineEntry } from '../../../../shared/factory-diagnostics';
import { getFactoryCodingRun } from '../../api/factory-coding';
import { getFactoryDelivery } from '../../api/factory-delivery';
import { FactoryCodingEvidence } from './FactoryCodingEvidence';
import { FactoryCodingCandidate } from './FactoryCodingCandidate';
import { FactoryDeliveryEvidence } from './FactoryDeliveryEvidence';
import { getFactoryDeliveryProgressEvidence } from '../../api/factory-progress';
import { FactoryDeliveryProgressHistory } from './FactoryDeliveryProgressHistory';
import { FactoryDeliveryEvidenceContent } from './FactoryDeliveryEvidenceContent';

const sameRevision = (
  a: NonNullable<FactoryTimelineEntry['revision']>,
  b: NonNullable<FactoryTimelineEntry['revision']>,
) =>
  Object.keys(a).every(
    (key) => a[key as keyof typeof a] === b[key as keyof typeof b],
  );
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
    queryFn: async ({ signal }) => {
      if (deliveryId) {
        const detail = await getFactoryDelivery(deliveryId, { signal });
        if (detail.pipeline.workItemId !== entry.correlation.workItemId)
          throw new Error('Delivery task binding does not match this record.');
        if (!entry.revision)
          throw new Error(
            'This entry has no exact delivery revision binding. Its references remain reference-only.',
          );
        const revision = entry.revision;
        for (const key of [
          'runId',
          'attemptId',
          'releaseId',
          'specVersion',
          'specHash',
        ] as const) {
          if (
            entry.correlation[key] !== undefined &&
            entry.correlation[key] !== revision[key]
          )
            throw new Error(
              'Recorded delivery correlation does not match its revision binding.',
            );
        }
        if (entry.kind === 'repair') {
          const target = entry.repairTarget;
          const repair =
            target &&
            detail.pipeline.repairs.find(
              (item) =>
                item.runId === target.runId &&
                item.attemptId === target.attemptId &&
                sameRevision(item.fromRevision, revision),
            );
          if (!repair)
            throw new Error(
              'Repair target is not bound to this pipeline and historical source revision.',
            );
          const run = await getFactoryCodingRun(repair.runId, { signal });
          const snapshot = run.record.snapshot;
          if (
            run.record.attemptId !== repair.attemptId ||
            snapshot.requestId !== repair.requestId ||
            snapshot.workItemId !== detail.pipeline.workItemId ||
            snapshot.repoId !== detail.pipeline.repoId ||
            snapshot.releaseId !== revision.releaseId ||
            snapshot.specVersion !== revision.specVersion ||
            snapshot.specHash !== revision.specHash
          )
            throw new Error(
              'Repair coding run does not match the recorded target binding.',
            );
          return { kind: 'coding' as const, run, sourceRevision: revision };
        }
        if (entry.kind === 'judge') {
          const assessment = detail.pipeline.progress.assessments.find(
            (item) =>
              sameRevision(item.revision, revision) &&
              item.resultId !== null &&
              entry.evidenceRefs.includes(item.resultId),
          );
          if (!assessment)
            throw new Error(
              'No settled assessment matches these recorded references. References remain reference-only.',
            );
          const content = await getFactoryDeliveryProgressEvidence(
            deliveryId,
            assessment.assessmentId,
            { signal },
          );
          if (!sameRevision(content.assessment.revision, revision))
            throw new Error('Assessment revision does not match this record.');
          return { kind: 'progress' as const, content };
        }
        const matches = detail.pipeline.evidence.filter((item) =>
          sameRevision(item.revision, revision),
        );
        const current = sameRevision(detail.pipeline.revision, revision);
        if (!current && !matches.length)
          throw new Error(
            'The current pipeline differs from this historical revision, and no matching retained validation evidence is available.',
          );
        return { kind: 'delivery' as const, detail, current, matches };
      }
      const run = await getFactoryCodingRun(runId!, { signal });
      const record = run.record;
      const expected = entry.correlation;
      if (
        record.snapshot.workItemId !== expected.workItemId ||
        (expected.attemptId !== undefined &&
          record.attemptId !== expected.attemptId) ||
        (expected.releaseId !== undefined &&
          record.snapshot.releaseId !== expected.releaseId) ||
        (expected.specVersion !== undefined &&
          record.snapshot.specVersion !== expected.specVersion) ||
        (expected.specHash !== undefined &&
          record.snapshot.specHash !== expected.specHash)
      )
        throw new Error('Coding evidence binding does not match this record.');
      if (
        entry.revision &&
        (entry.revision.runId !== record.runId ||
          entry.revision.attemptId !== record.attemptId ||
          entry.revision.releaseId !== record.snapshot.releaseId ||
          entry.revision.specVersion !== record.snapshot.specVersion ||
          entry.revision.specHash !== record.snapshot.specHash ||
          entry.revision.baseSha !== record.candidate?.baseSha ||
          entry.revision.headSha !== record.candidate?.headSha)
      )
        throw new Error(
          'Coding candidate does not match the recorded revision.',
        );
      return { kind: 'coding' as const, run, sourceRevision: null };
    },
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
                  {result.current
                    ? 'Current pipeline evidence matches this entry’s exact revision. Pipeline status may include later activity.'
                    : 'Retained validation evidence for this historical revision. The current pipeline is on a different revision.'}
                </p>
                {result.current ? (
                  <FactoryDeliveryEvidence detail={result.detail} />
                ) : (
                  result.matches.map((item) => (
                    <FactoryDeliveryEvidenceContent
                      key={item.id}
                      deliveryId={result.detail.pipeline.pipelineId}
                      evidenceId={item.id}
                      version={result.detail.pipeline.version}
                      label={`${item.kind} · ${item.result} · Historical revision`}
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
