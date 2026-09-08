import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FactoryDetail } from '../../../../shared/factory';
import {
  getFactoryLinear,
  syncFactoryLinearSource,
} from '../../api/factory-linear';
import { MarkdownMessage } from '../../components/MarkdownMessage';

export function FactoryLinearSource({ detail }: { detail: FactoryDetail }) {
  const client = useQueryClient();
  const state = useQuery({
    queryKey: ['factory-linear'],
    queryFn: getFactoryLinear,
    refetchInterval: 15000,
  });
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const remote = detail.source.linear;
  if (!remote) return null;
  const connection = state.data?.connections.find(
    (item) => item.id === remote.connectionId,
  );
  return (
    <section aria-label="Linear source">
      <h3>
        <a href={remote.url} target="_blank" rel="noreferrer">
          Linear issue {remote.identifier}
        </a>
      </h3>
      <p>
        Source v{detail.source.version} · {detail.source.status} · Linear state{' '}
        {remote.stateType}
      </p>
      <p>
        Team {remote.teamId}
        {remote.projectId ? ` / project ${remote.projectId}` : ''}
      </p>
      <MarkdownMessage>{detail.source.body}</MarkdownMessage>
      {detail.source.attention && (
        <p className="factory-error">{detail.source.attention}</p>
      )}
      <p>
        Repository mappings are configured in{' '}
        <a
          href="#factory-setup"
          onClick={() => {
            const setup = document.getElementById('factory-setup');
            if (setup instanceof HTMLDetailsElement) setup.open = true;
          }}
        >
          Factory setup
        </a>
        . Resolve connection conflicts there, then sync this source.
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          if (submitting.current) return;
          submitting.current = true;
          setBusy(true);
          setError('');
          try {
            await syncFactoryLinearSource(detail.work.id);
            await Promise.all([
              state.refetch(),
              client.invalidateQueries({
                queryKey: ['factory-detail', detail.work.id],
              }),
              client.invalidateQueries({ queryKey: ['factory-state'] }),
            ]);
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : 'Linear sync failed. Retry when ready.',
            );
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        {busy ? 'Syncing Linear source…' : 'Sync Linear source'}
      </button>
      {error && (
        <p role="alert" className="factory-error">
          {error}
        </p>
      )}
      {state.error && (
        <p role="alert">
          Linear connection status could not refresh.{' '}
          <button
            disabled={state.isFetching}
            onClick={() => void state.refetch()}
          >
            Retry Linear status
          </button>
        </p>
      )}
      {connection && (
        <p>
          Status writeback{' '}
          {connection.writeback.enabled
            ? 'enabled for configured lifecycle states'
            : 'disabled'}
          .
        </p>
      )}
      {connection?.readiness.map((reason) => (
        <p key={reason}>{reason}</p>
      ))}
      {state.data?.deliveries
        .filter(
          (delivery) =>
            delivery.connectionId === remote.connectionId &&
            delivery.issueId === remote.issueId &&
            delivery.state !== 'complete',
        )
        .map((delivery) => (
          <p key={delivery.id} role="status">
            {delivery.error ?? 'Source reconciliation pending.'}
          </p>
        ))}
      {state.data?.writebacks
        .filter((effect) => effect.workId === detail.work.id)
        .map((effect) => (
          <p key={effect.id}>
            Status writeback to {effect.stateId}: {effect.state}
            {effect.error ? `. ${effect.error}` : ''}
          </p>
        ))}
    </section>
  );
}
