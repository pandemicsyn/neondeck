import type { ValidationAdmissionAttention } from '../../../../shared/factory-coding';

export function FactoryValidationAttention({
  attention,
  runId,
  releaseId,
  workId,
  canRetry,
  pending,
  stale,
  onRetry,
  onDiscuss,
}: {
  attention: ValidationAdmissionAttention;
  runId: string;
  releaseId: string;
  workId: string;
  canRetry: boolean;
  pending: boolean;
  stale: boolean;
  onRetry: () => void;
  onDiscuss?: (message: string) => void;
}) {
  return (
    <section
      className="factory-error"
      aria-label="Validation admission needs attention"
      id="factory-validation-attention"
      tabIndex={-1}
    >
      <h4>Validation could not start</h4>
      <p>{attention.message}</p>
      {attention.recovery && <p>{attention.recovery}</p>}
      {!attention.reasonCode &&
        attention.nextAction === 'retry-validation' &&
        canRetry && (
          <p>
            Earlier failure did not record a specific reason. Retry validation
            with this version to recheck the retained candidate.
          </p>
        )}
      {attention.reasonCode && (
        <details>
          <summary>Validation diagnostic details</summary>
          <dl>
            <dt>Reason</dt>
            <dd>
              <code>{attention.reasonCode}</code>
            </dd>
            {attention.stage && (
              <>
                <dt>Stage</dt>
                <dd>{attention.stage}</dd>
              </>
            )}
            <dt>Observed</dt>
            <dd>{attention.observedAt}</dd>
            <dt>Run</dt>
            <dd>{runId}</dd>
            <dt>Release</dt>
            <dd>{releaseId}</dd>
            {attention.diagnosticReference && (
              <>
                <dt>Stored diagnostic reference</dt>
                <dd>
                  <code>{attention.diagnosticReference}</code>
                </dd>
              </>
            )}
          </dl>
          <p>
            These details are retained with this coding run. Include them when
            reporting the failure to the Neondeck maintainer.
          </p>
        </details>
      )}
      {attention.nextAction === 'inspect-diagnostics' && canRetry && (
        <p>Resolve the issue above, then recheck validation.</p>
      )}
      {(attention.nextAction === 'retry-validation' ||
        attention.nextAction === 'inspect-diagnostics') &&
      canRetry ? (
        <button disabled={pending || stale} onClick={onRetry}>
          {pending
            ? attention.nextAction === 'inspect-diagnostics'
              ? 'Rechecking validation…'
              : 'Retrying validation admission…'
            : attention.nextAction === 'inspect-diagnostics'
              ? 'Recheck validation'
              : 'Retry validation admission'}
        </button>
      ) : attention.nextAction === 'review-plan' ? (
        onDiscuss ? (
          <button
            disabled={pending || stale}
            onClick={() =>
              onDiscuss(
                `Validation admission needs a plan review: ${attention.message}`,
              )
            }
          >
            Review validation with Neon
          </button>
        ) : (
          <a href={`/factory?task=${encodeURIComponent(workId)}`}>
            Open task planning
          </a>
        )
      ) : null}
    </section>
  );
}
