import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LinearConnection } from '../../../../shared/factory-linear';
import { getFactoryLinear, saveFactoryLinear } from '../../api/factory-linear';
import { FactoryLinearConnectionForm } from './FactoryLinearConnectionForm';

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Request failed. Retry with your retained input.';
export function FactoryLinearSetup({
  repos,
}: {
  repos: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const state = useQuery({
    queryKey: ['factory-linear'],
    queryFn: getFactoryLinear,
    enabled: open,
    refetchInterval: 15000,
  });
  const [draft, setDraft] = useState<{
    value: LinearConnection;
    originalId: string | null;
    fingerprint: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  async function save() {
    if (
      !draft ||
      !state.data ||
      submitting.current ||
      draft.fingerprint !== state.data.configFingerprint
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await saveFactoryLinear(
        [
          ...state.data.connections
            .filter((connection) => connection.id !== draft.originalId)
            .map(({ readiness: _readiness, ...connection }) => connection),
          draft.value,
        ],
        draft.fingerprint,
      );
      setDraft(null);
      await state.refetch();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="factory-source"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Linear connections</summary>
      <p>
        Map a Linear team and optional project to a registered repository.
        Issues enter the same review and release flow as other factory tasks.
      </p>
      {(error || state.error) && (
        <p className="factory-error" role="alert">
          {error || errorText(state.error)}
        </p>
      )}
      {open && state.isPending && <output>Loading Linear connections…</output>}
      {state.error && (
        <button
          disabled={state.isFetching}
          onClick={() => void state.refetch()}
        >
          Retry Linear connections
        </button>
      )}
      {state.data?.connections.length === 0 && (
        <p>No Linear connections yet. Add a mapping to configure admission.</p>
      )}
      {state.data?.connections.map(({ readiness, ...connection }) => (
        <section key={connection.id}>
          <h3>
            {connection.id} ·{' '}
            {connection.enabled ? 'Admission enabled' : 'Admission disabled'}
          </h3>
          <p>
            Team {connection.teamId}
            {connection.projectId
              ? ` / project ${connection.projectId}`
              : ' / all projects'}{' '}
            →{' '}
            {repos.find((repo) => repo.id === connection.repoId)?.name ??
              connection.repoId}
          </p>
          <p>
            {readiness.length
              ? readiness.join(' ')
              : 'Credentials and mapping configured. Verify webhook exposure and live sync before relying on intake.'}
          </p>
          <p>
            Status writeback{' '}
            {connection.writeback.enabled ? 'enabled' : 'disabled'}
          </p>
          <button
            disabled={busy || !!draft}
            onClick={() => {
              setError('');
              setDraft({
                value: structuredClone(connection),
                originalId: connection.id,
                fingerprint: state.data!.configFingerprint,
              });
            }}
          >
            Edit Linear {connection.id}
          </button>
        </section>
      ))}
      {!draft && (
        <button
          disabled={!state.data || busy}
          onClick={() => {
            setError('');
            setDraft({
              originalId: null,
              fingerprint: state.data!.configFingerprint,
              value: {
                id: '',
                enabled: false,
                organizationId: '',
                teamId: '',
                projectId: null,
                repoId: '',
                tokenEnv: 'LINEAR_API_KEY',
                webhookSecretEnv: 'FACTORY_LINEAR_WEBHOOK_SECRET',
                admission: { mode: 'all' },
                writeback: { enabled: false, states: {} },
              },
            });
          }}
        >
          Add Linear connection
        </button>
      )}
      {draft && (
        <FactoryLinearConnectionForm
          value={draft.value}
          onChange={(value) => setDraft({ ...draft, value })}
          repos={repos}
          busy={busy}
          stale={draft.fingerprint !== state.data?.configFingerprint}
          onSave={() => void save()}
          onCancel={() => {
            setDraft(null);
            setError('');
          }}
        />
      )}
      {state.data?.sync.map((sync) => (
        <p key={sync.id} className={sync.error ? 'factory-error' : undefined}>
          {sync.id}:{' '}
          {sync.error ??
            (sync.cursor
              ? 'Reconciliation in progress.'
              : 'Reconciliation ready.')}{' '}
          {sync.error && sync.retryAt > 0
            ? `Retry after ${new Date(sync.retryAt).toLocaleString()}.`
            : ''}
        </p>
      ))}
      {state.data?.deliveries
        .filter((delivery) => delivery.error)
        .map((delivery) => (
          <p key={delivery.id} className="factory-error">
            Issue {delivery.issueId}: {delivery.error}
          </p>
        ))}
    </details>
  );
}
