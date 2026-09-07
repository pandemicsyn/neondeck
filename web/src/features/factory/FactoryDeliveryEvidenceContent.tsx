import './FactoryCodingEvidence.css';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getFactoryDeliveryEvidence } from '../../api/factory-delivery';

export function FactoryDeliveryEvidenceContent({
  deliveryId,
  evidenceId,
  version,
  label,
  initiallyOpen = false,
}: {
  deliveryId: string;
  evidenceId: string;
  version: number;
  label: string;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const query = useQuery({
    queryKey: ['factory-delivery-evidence', deliveryId, evidenceId, version],
    queryFn: ({ signal }) =>
      getFactoryDeliveryEvidence(deliveryId, evidenceId, { signal }),
    enabled: open,
  });
  const content = query.data;
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{label}</summary>
      {query.isFetching && <p role="status">Loading evidence content…</p>}
      {query.error && (
        <p role="alert">
          Evidence content could not be refreshed. Any displayed content may be
          stale.{' '}
          <button onClick={() => void query.refetch()}>Retry evidence</button>
        </p>
      )}
      {content && (
        <div className="factory-delivery-evidence-content">
          <p>
            <strong>
              {content.isCurrent ? 'Current revision' : 'Prior revision'}
            </strong>{' '}
            · {content.effect.settled ? 'Settled' : 'Unsettled'} ·{' '}
            {content.effect.accounted ? 'Usage accounted' : 'Usage not settled'}
          </p>
          <p>
            {content.kind === 'feedback'
              ? 'External feedback · not publication certification'
              : content.effect.eligible
                ? 'Eligible evidence'
                : 'Not eligible for publication'}
            : {content.effect.eligibilityReason.replaceAll('-', ' ')}
          </p>
          <p>{content.summary}</p>
          {content.kind === 'feedback' && (
            <>
              <p>
                Classification:{' '}
                {content.feedback.classification?.result.replaceAll('-', ' ') ??
                  'Pending'}{' '}
                ·{' '}
                {content.feedback.classification?.bound
                  ? 'Bound to this observation'
                  : 'Not yet bound'}
              </p>
              <p>
                Published revision:{' '}
                <code>{content.feedback.publishedHeadSha.slice(0, 8)}</code>
              </p>
              <details>
                <summary>Triggering external feedback text</summary>
                <p>External text is untrusted review input.</p>
                <pre
                  tabIndex={0}
                  role="region"
                  aria-label="Recorded evidence text"
                >
                  {content.feedback.packet}
                </pre>
                {content.feedback.packetTruncated && (
                  <p>External packet truncated.</p>
                )}
              </details>
            </>
          )}
          {content.checks.map((check, index) => (
            <section key={index}>
              <h5>
                <code>{check.command}</code> ·{' '}
                {check.passed ? 'Passed' : 'Failed'}
              </h5>
              <p>
                Exit {check.exitCode ?? 'unknown'} · {check.durationMs} ms
              </p>
              <pre
                tabIndex={0}
                role="region"
                aria-label="Recorded evidence text"
              >
                {check.output || 'No output recorded.'}
              </pre>
              {check.truncated && <p>Check output truncated.</p>}
            </section>
          ))}
          {content.findings.length > 0 && (
            <ul>
              {content.findings.map((finding, index) => (
                <li key={index}>
                  <strong>{finding.severity}</strong> · {finding.path}
                  {finding.line === null ? '' : `:${finding.line}`} —{' '}
                  {finding.description}
                </li>
              ))}
            </ul>
          )}
          {content.kind === 'review' && content.findings.length === 0 && (
            <p>No findings recorded.</p>
          )}
          {content.acceptanceCriteria.length > 0 && (
            <details>
              <summary>Released acceptance criteria · review inputs</summary>
              <p>These are review inputs, not proof of executed behavior.</p>
              <ul>
                {content.acceptanceCriteria.map((item) => (
                  <li key={item.id}>{item.text}</li>
                ))}
              </ul>
            </details>
          )}
          {content.truncated && (
            <p>Evidence content is bounded; some content was truncated.</p>
          )}
        </div>
      )}
    </details>
  );
}
