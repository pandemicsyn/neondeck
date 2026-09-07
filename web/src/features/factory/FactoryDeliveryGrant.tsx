import { useFactoryRefresh } from './useFactoryRefresh';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as v from 'valibot';
import { ApiError } from '../../api/http';
import {
  deliveryGrantInputSchema,
  getFactoryDeliveryPreview,
  grantFactoryDelivery,
  type DeliveryGrantPreview,
} from '../../api/factory-delivery';
import { FactoryDeliveryRevision } from './FactoryDeliveryRevision';

export function FactoryDeliveryGrant({
  runId,
  workId,
  disabled,
  onGranted,
}: {
  runId: string;
  workId: string;
  disabled: boolean;
  onGranted: () => Promise<unknown>;
}) {
  const { refreshing, refresh } = useFactoryRefresh();
  const preview = useQuery({
    queryKey: ['factory-delivery-preview', runId],
    queryFn: async ({ signal }) => {
      const value = await getFactoryDeliveryPreview(runId, { signal });
      if (value.workItemId !== workId)
        throw new Error('Candidate belongs to another task.');
      return value;
    },
    staleTime: 0,
  });
  return (
    <>
      <p>
        Releasing a brief does not permit publication. Inspect the exact
        candidate and grant checks, bounded repairs and one draft PR below.
      </p>
      {preview.isPending && <output>Loading exact delivery preview…</output>}
      {preview.error && (
        <p role="alert" className="factory-error">
          Delivery preview unavailable, changed or unsupported. Controls are
          disabled.
        </p>
      )}
      <button
        disabled={preview.isPending || refreshing}
        onClick={() => void refresh(() => preview.refetch())}
      >
        Refresh candidate preview
      </button>
      {preview.data && (
        <GrantForm
          key={JSON.stringify(preview.data)}
          preview={preview.data}
          disabled={
            disabled || !!preview.error || preview.isPending || refreshing
          }
          onGranted={onGranted}
          refresh={() => refresh(() => preview.refetch())}
        />
      )}
    </>
  );
}
function GrantForm({
  preview,
  disabled,
  onGranted,
  refresh,
}: {
  preview: DeliveryGrantPreview;
  disabled: boolean;
  onGranted: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
}) {
  const storageKey = `factory-delivery-grant:${preview.revision.runId}`;
  const [saved] = useState(() => {
    try {
      const value = sessionStorage.getItem(storageKey);
      return {
        request: value
          ? v.parse(deliveryGrantInputSchema, JSON.parse(value))
          : undefined,
        error: '',
      };
    } catch {
      return {
        request: undefined,
        error:
          'Saved grant could not be read. Restore browser storage before granting delivery.',
      };
    }
  });
  const [request, setRequest] = useState(saved.request);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(saved.error);
  const [rejected, setRejected] = useState(false);
  async function grant() {
    if (busy || disabled || saved.error || rejected || (!request && !checked))
      return;
    setBusy(true);
    setError('');
    try {
      const exact = request ?? {
        requestId: crypto.randomUUID(),
        confirm: true as const,
        preview,
      };
      sessionStorage.setItem(storageKey, JSON.stringify(exact));
      setRequest(exact);
      await grantFactoryDelivery(exact);
      sessionStorage.removeItem(storageKey);
      await onGranted();
    } catch (cause) {
      const conflict = cause instanceof ApiError && cause.status === 409;
      setRejected(conflict);
      setError(
        conflict
          ? 'Version conflict: the candidate or authority changed. Refresh and inspect the current preview before a new grant.'
          : 'Grant receipt is unconfirmed. Retry the original request to recover its receipt without granting new budget.',
      );
    } finally {
      setBusy(false);
    }
  }
  const exact = request?.preview ?? preview;
  return (
    <div className="factory-delivery-grant">
      <FactoryDeliveryRevision
        revision={exact.revision}
        configFingerprint={exact.configFingerprint}
      />
      <dl className="factory-coding-facts">
        <div>
          <dt>Target repository / base</dt>
          <dd>
            {exact.target.owner}/{exact.target.name} → {exact.target.baseBranch}
          </dd>
        </div>
      </dl>
      <h4>Authorized checks</h4>
      <ul>
        {exact.checkCommands.map((command) => (
          <li key={command}>
            <code>{command}</code>
          </li>
        ))}
      </ul>
      <p>
        At most 2 repairs total · 3 hours cumulative execution ·{' '}
        {Math.ceil(exact.maxAttemptMs / 60000)} minutes per attempt. Initial
        execution already consumed:{' '}
        {Math.ceil(exact.initialExecutionMs / 60000)} minutes. Checks and review
        also count toward the limit.
      </p>
      <p>
        Publication: draft PR only. Merge and deployment are never authorized.
      </p>
      {!request && (
        <label className="factory-delivery-consent">
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled || busy || !!saved.error}
            onChange={(event) => setChecked(event.target.checked)}
          />
          I authorize these exact candidate, release, target and limits.
        </label>
      )}
      {request && (
        <p role="status">
          The original grant request and exact preview are retained until its
          receipt is confirmed.
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
          !!saved.error ||
          rejected ||
          (!request && !checked)
        }
        onClick={() => void grant()}
      >
        {busy
          ? 'Confirming delivery grant…'
          : request
            ? 'Retry original delivery grant'
            : 'Grant bounded draft delivery'}
      </button>
      {rejected && (
        <button
          disabled={busy}
          onClick={() => {
            try {
              sessionStorage.removeItem(storageKey);
              setRequest(undefined);
              setChecked(false);
              setRejected(false);
              void refresh();
            } catch {
              setError(
                'Browser storage unavailable; original request retained.',
              );
            }
          }}
        >
          Review a fresh grant
        </button>
      )}
    </div>
  );
}
