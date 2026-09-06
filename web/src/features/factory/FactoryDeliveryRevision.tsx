import type { DeliveryRevision } from '../../api/factory-delivery';
export function FactoryDeliveryRevision({
  revision,
  configFingerprint,
  branch,
}: {
  revision: DeliveryRevision;
  configFingerprint?: string;
  branch?: string;
}) {
  return (
    <>
      <p>
        Spec v{revision.specVersion} · candidate{' '}
        <code>{revision.candidateDigest.slice(0, 10)}</code> · tree{' '}
        <code>{revision.treeSha.slice(0, 10)}</code>
      </p>
      <details>
        <summary>Revision details</summary>
        <dl className="factory-coding-facts factory-delivery-revision">
          <div>
            <dt>Candidate / attempt</dt>
            <dd>
              {revision.runId} / {revision.attemptId}
            </dd>
          </div>
          <div>
            <dt>Release / specification</dt>
            <dd>
              {revision.releaseId} · v{revision.specVersion}
              <br />
              {revision.specHash}
            </dd>
          </div>
          <div>
            <dt>Frozen tree identity</dt>
            <dd>{revision.treeSha}</dd>
          </div>
          <div>
            <dt>Candidate content digest</dt>
            <dd>{revision.candidateDigest}</dd>
          </div>
          <div>
            <dt>Original base</dt>
            <dd>{revision.baseSha}</dd>
          </div>
          <div>
            <dt>Original collected head</dt>
            <dd>{revision.headSha}</dd>
          </div>
          {configFingerprint && (
            <div>
              <dt>Configuration fingerprint</dt>
              <dd>{configFingerprint}</dd>
            </div>
          )}
          {branch && (
            <div>
              <dt>Delivery branch</dt>
              <dd>{branch}</dd>
            </div>
          )}
        </dl>
      </details>
    </>
  );
}
