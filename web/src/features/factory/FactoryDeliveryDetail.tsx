import { FactoryDeliveryProgress } from './FactoryDeliveryProgress';
import { getFactoryDeliveryProgressEvidence } from '../../api/factory-progress';
import { FactoryDeliveryCommits } from './FactoryDeliveryCommits';
import {
  triggeringDeliveryFeedback,
  deliveryDiscussionRecords,
  deliveryPlanningEvidence,
} from './FactoryDeliveryPlanningEvidence';
import { FactoryDeliveryEvidenceContent } from './FactoryDeliveryEvidenceContent';
import {
  FactoryDeliveryBudget,
  FactoryDeliveryEvidence,
} from './FactoryDeliveryEvidence';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/http';
import {
  controlFactoryDelivery,
  getFactoryDelivery,
  getFactoryDeliveryEvidence,
  type DeliveryDetail,
} from '../../api/factory-delivery';
import { FactoryDeliveryRevision } from './FactoryDeliveryRevision';

const actionLabels: Record<DeliveryDetail['nextAction'], string> = {
  running: 'Delivery in progress',
  'human-scope': 'Scope decision needed',
  'human-budget': 'Execution budget exhausted',
  'human-authority': 'Delivery authority needs attention',
  reconcile: 'Delivery outcome is uncertain',
  complete: 'Delivery complete',
};
export function FactoryDeliveryDetail({
  id,
  workId,
  onDiscuss,
}: {
  id: string;
  workId: string;
  onDiscuss?: (evidence: string) => void;
}) {
  const detail = useQuery({
    queryKey: ['factory-delivery', id],
    queryFn: async ({ signal }) => {
      const value = await getFactoryDelivery(id, { signal });
      if (
        value.pipeline.workItemId !== workId ||
        value.planningWorkId !== workId
      )
        throw new Error('Delivery belongs to another task.');
      return value;
    },
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  async function discuss() {
    if (!detail.data || !onDiscuss || disabled) return;
    setBusy(true);
    setError('');
    try {
      const records = deliveryDiscussionRecords(detail.data);
      const progress = await Promise.all(
        detail.data.pipeline.progress.assessments.map((assessment) =>
          getFactoryDeliveryProgressEvidence(id, assessment.assessmentId),
        ),
      );
      const content = await Promise.all(
        records.map((record) => getFactoryDeliveryEvidence(id, record)),
      );
      if (
        [...content, ...progress].some(
          (item) =>
            JSON.stringify(item.currentRevision) !==
            JSON.stringify(detail.data.pipeline.revision),
        )
      )
        throw new Error('Delivery revision changed while reading evidence.');
      onDiscuss(deliveryPlanningEvidence(detail.data, content, progress));
    } catch {
      setError(
        'Evidence content could not be loaded. Retry discussion after inspecting the evidence; no incomplete briefing was sent.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function control(action: 'revoke' | 'reconcile') {
    if (!detail.data || detail.error || detail.isFetching || busy) return;
    setBusy(true);
    setError('');
    try {
      await controlFactoryDelivery(
        id,
        action,
        detail.data.pipeline.version,
        action === 'revoke'
          ? reason.trim()
          : 'Human requested observation of uncertain delivery effects',
      );
      setRevoking(false);
      setReason('');
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 409
          ? 'Version conflict. Review the refreshed delivery before acting again.'
          : 'Control receipt is unconfirmed. Refresh and inspect the recorded outcome before retrying.',
      );
    } finally {
      await detail.refetch();
      setBusy(false);
    }
  }
  if (detail.isPending) return <output>Loading delivery evidence…</output>;
  if (!detail.data)
    return (
      <p role="alert" className="factory-error">
        Delivery evidence unavailable or unsupported.{' '}
        <button onClick={() => void detail.refetch()}>
          Reload delivery evidence
        </button>
      </p>
    );
  const { pipeline: p, nextAction } = detail.data;
  const disabled = busy || !!detail.error || detail.isFetching;
  const triggeringFeedback = triggeringDeliveryFeedback(detail.data);
  return (
    <div
      className="factory-delivery-detail"
      id={`factory-delivery-${encodeURIComponent(id)}`}
    >
      <div className="factory-toolbar">
        <h4>{actionLabels[nextAction]}</h4>
        <span className="factory-coding-badge">
          {p.outcome ?? (p.pr ? 'Draft PR recorded' : 'Draft only')}
        </span>
      </div>
      {busy && (
        <output>Preparing the delivery action; waiting for its result…</output>
      )}
      {detail.error && (
        <p role="alert" className="factory-error">
          Refresh failed. Evidence may be stale; controls are disabled.{' '}
          <button onClick={() => void detail.refetch()}>
            Reload delivery evidence
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="factory-error">
          {error}
        </p>
      )}
      {nextAction !== 'running' && nextAction !== 'complete' && (
        <section
          className="factory-delivery-intervention"
          aria-label="Delivery intervention"
        >
          <h4>Continue planning with Neon</h4>
          {p.interventions
            .filter((i) => !i.resolution)
            .map((i) => (
              <div key={i.id}>
                <strong>
                  {i.kind}: {i.reason}
                </strong>
                <details>
                  <summary>Intervention reference</summary>
                  Intervention {i.id} · candidate {i.revision.runId} · spec v
                  {i.revision.specVersion}
                  <br />
                  Tree: <code>{i.revision.treeSha}</code>
                </details>
              </div>
            ))}
          <p>
            Clarify the next step with Neon. A scope change needs a reviewed
            release; conversation alone grants no execution or publication.
          </p>
          {onDiscuss && (
            <button disabled={disabled} onClick={() => void discuss()}>
              Discuss delivery evidence with Neon
            </button>
          )}
          {triggeringFeedback && (
            <FactoryDeliveryEvidenceContent
              deliveryId={id}
              evidence={triggeringFeedback}
              version={p.version}
              label="Triggering external scope feedback"
              initiallyOpen
            />
          )}
          {!onDiscuss && (
            <a
              href={`/factory?task=${encodeURIComponent(detail.data.planningWorkId)}`}
            >
              Open task planning conversation
            </a>
          )}
          {detail.data.plannerSessionId && (
            <details>
              <summary>Planning session reference</summary>
              <code>{detail.data.plannerSessionId}</code>
            </details>
          )}
        </section>
      )}
      <FactoryDeliveryProgress
        detail={detail.data}
        disabled={disabled}
        onDiscuss={onDiscuss ? () => void discuss() : undefined}
      />
      <FactoryDeliveryRevision
        revision={p.revision}
        configFingerprint={p.authorization.configFingerprint}
        branch={p.branch}
      />
      <p>
        Authorized by {p.authorization.authorizedBy} ·{' '}
        {new Date(p.authorization.authorizedAt).toLocaleString()}
        <br />
        Target: {p.authorization.target.owner}/{p.authorization.target.name} →{' '}
        {p.authorization.target.baseBranch}
      </p>
      <FactoryDeliveryBudget detail={detail.data} />
      <FactoryDeliveryEvidence detail={detail.data} />
      {p.pr && (
        <nav className="factory-toolbar" aria-label="Delivered pull request">
          <a href={safeWebUrl(p.pr.url)} target="_blank" rel="noreferrer">
            Open PR #{p.pr.number}
          </a>
          <a
            href={`/review?${new URLSearchParams({ repo: `${p.authorization.target.owner}/${p.authorization.target.name}`, number: String(p.pr.number) })}`}
          >
            Review PR changes
          </a>
        </nav>
      )}
      <p>
        Checks certify the frozen tree. Local commits and confirmed pushes have
        separate receipts. Merge remains a human action.
      </p>
      <FactoryDeliveryCommits detail={detail.data} />
      {p.coordinator.watchId ? (
        <p>
          Attached watch: <code>{p.coordinator.watchId}</code>
        </p>
      ) : (
        p.pr && (
          <p role="status">
            Watch attachment is not recorded yet. The existing PR is retained.
          </p>
        )
      )}
      {!p.outcome && (
        <div className="factory-delivery-controls">
          {nextAction === 'reconcile' && (
            <button
              disabled={disabled}
              onClick={() => void control('reconcile')}
            >
              {busy ? 'Reconciling delivery…' : 'Reconcile delivery receipts'}
            </button>
          )}
          <button
            disabled={disabled}
            aria-expanded={revoking}
            onClick={() => setRevoking(!revoking)}
          >
            Revoke delivery authority
          </button>
          {revoking && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void control('revoke');
              }}
            >
              <label>
                Reason for revocation
                <textarea
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={disabled}
                />
              </label>
              <p>
                Revocation fences new work. In-flight effects must be
                reconciled; an existing PR or push is not undone.
              </p>
              <button disabled={disabled || !reason.trim()} type="submit">
                Confirm revocation
              </button>
            </form>
          )}
        </div>
      )}
      {p.outcome && (
        <p>
          Recorded outcome: {p.outcome}. Retained work and evidence remain
          protected; cleanup is not implied by this outcome.
        </p>
      )}
    </div>
  );
}
function safeWebUrl(value: string) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
