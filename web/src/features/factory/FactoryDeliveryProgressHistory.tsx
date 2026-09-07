import type { DeliveryProgressEvidenceContent } from '../../../../shared/factory-delivery-progress-evidence';
export function FactoryDeliveryProgressHistory({
  content,
}: {
  content: DeliveryProgressEvidenceContent;
}) {
  return (
    <details className="factory-delivery-progress-history">
      <summary>Assessed evidence and repair history</summary>
      {content.truncated && (
        <p role="note">
          Presentation is shortened. Omitted text is not evidence of success.
        </p>
      )}
      {content.missingEvidence.length > 0 && (
        <div>
          <h5>Missing evidence</h5>
          <ul>
            {content.missingEvidence.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      {content.omittedEvidence.length > 0 && (
        <div>
          <h5>Omitted from assessment</h5>
          <ul>
            {content.omittedEvidence.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>Released brief used for assessment</summary>
        <pre tabIndex={0} role="region" aria-label="Recorded evidence text">
          {content.releasedBrief}
        </pre>
      </details>
      {content.priorRepairs.length === 0 ? (
        <p>Initial repair assessment. No prior repair history was supplied.</p>
      ) : (
        <div>
          <h5>Previous repair approaches</h5>
          <ol>
            {content.priorRepairs.map((repair) => (
              <li key={repair.ordinal}>
                <strong>Repair {repair.ordinal}</strong> · candidate{' '}
                {repair.revision.runId}
                <p>{repair.instructions}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
      {content.candidates.map((candidate) => (
        <article key={candidate.revision.candidateDigest}>
          <h5>Candidate {candidate.revision.runId}</h5>
          <p>
            Tree <code>{candidate.revision.treeSha}</code>
          </p>
          {candidate.observations.length === 0 && (
            <p>
              No check, review or feedback observations supplied for this
              candidate.
            </p>
          )}
          {candidate.observations.map((observation) => (
            <details key={observation.ref}>
              <summary>
                {observation.kind} · {observation.ref}
              </summary>
              <pre
                tabIndex={0}
                role="region"
                aria-label="Recorded evidence text"
              >
                {observation.body}
              </pre>
              {observation.truncated && (
                <p>Observation shortened for display.</p>
              )}
            </details>
          ))}
          {candidate.diff === null ? (
            <p>Candidate diff unavailable in this assessment.</p>
          ) : (
            <details>
              <summary>
                Assessed candidate diff
                {candidate.diffTruncated ? ' (shortened)' : ''}
              </summary>
              <pre
                tabIndex={0}
                role="region"
                aria-label="Recorded evidence text"
              >
                {candidate.diff || 'No diff content recorded.'}
              </pre>
            </details>
          )}
        </article>
      ))}
      <details>
        <summary>Assessment references</summary>
        <p>
          Assessment <code>{content.evidenceId}</code>
        </p>
        <p>
          Input digest <code>{content.assessment.inputDigest}</code>
        </p>
        <p>
          Evidence digest <code>{content.assessment.evidenceDigest}</code>
        </p>
        <ul>
          {content.assessment.result?.evidenceRefs.map((ref) => (
            <li key={ref}>
              <code>{ref}</code>
            </li>
          ))}
        </ul>
      </details>
    </details>
  );
}
