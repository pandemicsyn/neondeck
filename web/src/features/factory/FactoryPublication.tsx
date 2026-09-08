import {
  reviewedDiffView,
  useFactoryReviewedDiff,
} from './FactoryReviewedDiff';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as v from 'valibot';
import {
  publicationGrantInputSchema,
  type publicationPreviewSchema,
} from '../../../../shared/factory-delivery-api';
import {
  getFactoryPublication,
  grantFactoryPublication,
  type DeliveryDetail,
} from '../../api/factory-delivery';
import { ApiError } from '../../api/http';
import { FactoryDeliveryRevision } from './FactoryDeliveryRevision';
import { currentValidation, sameCandidate } from './FactoryLifecycle';
import { useFactoryRefresh } from './useFactoryRefresh';
import { FactoryPublicationSetup } from './FactoryPublicationSetup';

export function FactoryPublication({
  detail,
  disabled,
  onGranted,
}: {
  detail: DeliveryDetail;
  disabled: boolean;
  onGranted: () => Promise<unknown>;
}) {
  const { pipeline: p } = detail;
  const { refreshing, refresh } = useFactoryRefresh();
  const certified = currentValidation(detail).passed;
  const readiness = useQuery({
    queryKey: ['factory-publication', p.pipelineId, p.version],
    queryFn: ({ signal }) => getFactoryPublication(p.pipelineId, { signal }),
    retry: false,
  });
  const reviewed = useFactoryReviewedDiff(detail);
  const preview = readiness.data?.preview;
  const matchingDiff =
    certified &&
    !!reviewed.data &&
    reviewedDiffView(reviewed.data.diff).kind !== 'unavailable' &&
    sameCandidate(reviewed.data.revision, p.revision);
  const matchingPublicationDiff =
    matchingDiff &&
    !!preview &&
    reviewed.data!.evidenceFingerprint === preview.evidenceFingerprint &&
    sameCandidate(reviewed.data!.revision, preview.revision);
  const reload = () =>
    refresh(() =>
      Promise.all([
        readiness.refetch(),
        certified ? reviewed.refetch() : Promise.resolve(),
      ]),
    );
  return (
    <section
      aria-label="Create draft PR"
      id="factory-publication"
      tabIndex={-1}
    >
      <h4>Create draft PR</h4>
      <p>
        These changes belong to the exact candidate that passed checks and
        independent review. Creating a draft PR needs your separate approval.
      </p>
      {readiness.isPending && <output>Checking publication readiness…</output>}
      {readiness.error && (
        <p role="alert" className="factory-error">
          {readiness.error.message}
        </p>
      )}
      {readiness.data && !readiness.data.ready && (
        <p className="factory-error">
          {readiness.data.message}{' '}
          <a href="#factory-review-result">
            Inspect validation and intervention evidence
          </a>
        </p>
      )}
      {readiness.data?.blocker === 'publication-setup' && (
        <FactoryPublicationSetup
          repoId={p.repoId}
          workId={detail.planningWorkId}
          disabled={disabled || refreshing}
          onSaved={reload}
        />
      )}
      {!certified && (
        <p>
          Checks and independent review must pass for the current candidate
          before publication.
        </p>
      )}
      {matchingDiff && preview && !matchingPublicationDiff && (
        <p className="factory-error">
          Publication evidence changed. Reload the decision before approving;
          the retained reviewed changes remain available.
        </p>
      )}
      <button
        disabled={readiness.isPending || refreshing}
        onClick={() => void reload()}
      >
        {refreshing
          ? 'Refreshing publication readiness…'
          : 'Reload publication readiness'}
      </button>
      {preview && (
        <PublicationDecision
          key={JSON.stringify(preview)}
          preview={preview}
          disabled={
            disabled ||
            refreshing ||
            !!readiness.error ||
            !!reviewed.error ||
            !readiness.data?.ready ||
            !certified ||
            !matchingPublicationDiff ||
            !sameCandidate(preview.revision, p.revision) ||
            preview.expectedVersion !== p.version
          }
          onGranted={onGranted}
          onRefresh={reload}
        />
      )}
    </section>
  );
}
function PublicationDecision({
  preview,
  disabled,
  onGranted,
  onRefresh,
}: {
  preview: v.InferOutput<typeof publicationPreviewSchema>;
  disabled: boolean;
  onGranted: () => Promise<unknown>;
  onRefresh: () => Promise<unknown>;
}) {
  const storageKey = `factory-publication-request:${preview.pipelineId}`;
  const [saved] = useState(() => {
    try {
      const text = sessionStorage.getItem(storageKey);
      return {
        request: text
          ? v.parse(publicationGrantInputSchema, JSON.parse(text))
          : null,
        error: '',
      };
    } catch {
      return {
        request: null,
        error:
          'The saved approval could not be read. Restore browser storage before continuing.',
      };
    }
  });
  const [request, setRequest] = useState(saved.request);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(saved.error);
  const [conflict, setConflict] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const exact = request?.preview ?? preview;
  async function submit() {
    if (
      disabled ||
      busy ||
      accepted ||
      saved.error ||
      conflict ||
      (!consent && !request)
    )
      return;
    setBusy(true);
    setError('');
    try {
      const body = request ?? {
        requestId: crypto.randomUUID(),
        confirm: true as const,
        preview,
      };
      sessionStorage.setItem(storageKey, JSON.stringify(body));
      setRequest(body);
      await grantFactoryPublication(body);
      setAccepted(true);
      sessionStorage.removeItem(storageKey);
      setRequest(null);
      setConsent(false);
      try {
        await onGranted();
      } catch {
        setError(
          'Decision recorded. Reload the task to see its latest status.',
        );
      }
    } catch (cause) {
      const rejected = cause instanceof ApiError && cause.status === 409;
      setConflict(rejected);
      setError(
        rejected
          ? 'The candidate, evidence or authority changed. Review a fresh decision before continuing.'
          : 'The receipt is unconfirmed. Retry this original request to recover its outcome without new authority or budget.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="factory-delivery-grant">
      <FactoryDeliveryRevision
        revision={exact.revision}
        configFingerprint={exact.configFingerprint}
      />
      <p>
        Target:{' '}
        <strong>
          {exact.target.owner}/{exact.target.name} → {exact.target.baseBranch}
        </strong>
      </p>
      <p>
        This approval permits one draft PR and subsequent in-scope feedback
        repairs, checks, independent review and updates to the same PR. The
        remaining repair and execution budget shown above is shared and does not
        reset. Merge and deployment remain human actions.
      </p>
      {!request && (
        <label className="factory-delivery-consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={disabled || busy || accepted || !!saved.error}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I approve this exact reviewed candidate, target and remaining limits,
          including bounded post-PR repairs.
        </label>
      )}
      {request && (
        <p>
          The original approval request is retained until its receipt is
          confirmed.
        </p>
      )}
      {error && (
        <p role="alert" className="factory-error">
          {error}
        </p>
      )}
      <button
        disabled={
          disabled ||
          busy ||
          accepted ||
          !!saved.error ||
          conflict ||
          (!request && !consent)
        }
        onClick={() => void submit()}
      >
        {accepted
          ? 'Decision recorded'
          : busy
            ? 'Confirming decision…'
            : request
              ? 'Retry original decision'
              : 'Create draft PR'}
      </button>
      {conflict && (
        <button
          disabled={busy}
          onClick={() => {
            try {
              sessionStorage.removeItem(storageKey);
              setRequest(null);
              setConsent(false);
              setConflict(false);
              void onRefresh();
            } catch {
              setError(
                'Browser storage is unavailable; the original request is retained.',
              );
            }
          }}
        >
          Review a fresh decision
        </button>
      )}
    </div>
  );
}
