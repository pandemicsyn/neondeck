import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getFactoryGitHub,
  saveFactoryGitHub,
  syncFactorySource,
} from '../../api/factory';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import type { FactoryDetail } from '../../../../shared/factory';
import type { GitHubConnection } from '../../../../shared/factory-github';
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'Request failed. Retry with your retained input.';
function useGitHub(enabled = true) {
  return useQuery({
    queryKey: ['factory-github'],
    enabled,
    queryFn: getFactoryGitHub,
    refetchInterval: 15000,
  });
}
export function FactoryGitHubSetup({
  repos,
}: {
  repos: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const state = useGitHub(open);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editing, setEditing] = useState<GitHubConnection | null>(null);
  return (
    <details
      className="factory-github factory-source"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>GitHub connections</summary>
      <p>
        Choose which issues enter this inbox. GitHub is read-only here; no
        status or question comments are sent.
      </p>
      {(error || state.error) && (
        <p role="alert" className="factory-error">
          {error || errorText(state.error)}
        </p>
      )}
      {state.isPending && <p>Loading connections…</p>}
      {state.data?.connections.map((connection) => (
        <section key={connection.id}>
          <h3>
            {connection.owner}/{connection.name} ·{' '}
            {connection.enabled ? 'Enabled' : 'Disabled'}
          </h3>
          <p>
            {connection.readiness.length
              ? connection.readiness.join(' ')
              : 'Credentials and mapping ready. Listener exposure must be verified by the operator.'}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setBase(state.data!.configFingerprint);
              setEditingId(connection.id);
              const { readiness: _readiness, ...value } = connection;
              setEditing(value);
            }}
          >
            Edit {connection.id}
          </button>
        </section>
      ))}
      {!editing && (
        <button
          disabled={!state.data || busy}
          onClick={() => {
            setBase(state.data!.configFingerprint);
            setEditingId('');
            setEditing({
              id: '',
              enabled: false,
              repoId: '',
              repositoryId: '',
              owner: '',
              name: '',
              webhookSecretEnv: 'FACTORY_GITHUB_WEBHOOK_SECRET',
              tokenEnv: 'GITHUB_TOKEN',
              admission: { mode: 'label', label: 'factory' },
            });
          }}
        >
          Add GitHub connection
        </button>
      )}
      {editing && (
        <form
          className="factory-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!state.data || busy) return;
            setBusy(true);
            setError('');
            try {
              await saveFactoryGitHub(
                [
                  ...state.data.connections
                    .filter((c) => c.id !== editingId)
                    .map(({ readiness: _readiness, ...c }) => c),
                  editing,
                ],
                base,
              );
              setEditing(null);
              await state.refetch();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="factory-editor-fields">
            <legend>Connection setup</legend>
            {base !== state.data?.configFingerprint && (
              <p role="alert">
                Saved connections changed. Your draft is retained. Cancel and
                reopen the saved connection after copying your changes.
              </p>
            )}
            <label>
              Connection ID
              <input
                required
                value={editing.id}
                onChange={(e) => setEditing({ ...editing, id: e.target.value })}
              />
            </label>
            <label>
              Registered repository
              <select
                required
                value={editing.repoId}
                onChange={(e) => {
                  const repo = repos.find((r) => r.id === e.target.value);
                  const [owner = '', name = ''] = repo?.name.split('/') ?? [];
                  setEditing({
                    ...editing,
                    repoId: e.target.value,
                    owner,
                    name,
                  });
                }}
              >
                <option value="">Choose repository</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              GitHub numeric repository ID
              <input
                required
                inputMode="numeric"
                value={editing.repositoryId}
                onChange={(e) =>
                  setEditing({ ...editing, repositoryId: e.target.value })
                }
              />
            </label>
            <label>
              Webhook secret environment reference
              <input
                required
                value={editing.webhookSecretEnv}
                onChange={(e) =>
                  setEditing({ ...editing, webhookSecretEnv: e.target.value })
                }
              />
            </label>
            <label>
              GitHub read credential environment reference
              <input
                required
                value={editing.tokenEnv}
                onChange={(e) =>
                  setEditing({ ...editing, tokenEnv: e.target.value })
                }
              />
            </label>
            <p>
              Enter environment variable names only. Secret values belong in the
              private runtime environment.
            </p>
            <label>
              Admit issues
              <select
                value={editing.admission.mode}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    admission: {
                      mode: e.target.value as 'label' | 'all',
                      label: editing.admission.label ?? 'factory',
                    },
                  })
                }
              >
                <option value="label">With a specific label</option>
                <option value="all">All issues in this repository</option>
              </select>
            </label>
            {editing.admission.mode === 'label' && (
              <label>
                Admission label
                <input
                  required
                  value={editing.admission.label ?? ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      admission: {
                        ...editing.admission,
                        label: e.target.value,
                      },
                    })
                  }
                />
              </label>
            )}
            <label>
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              Enable connection
            </label>
            <button>Save connection</button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </fieldset>
        </form>
      )}
      {state.data?.sync
        .filter((sync) => sync.error)
        .map((sync) => (
          <p key={sync.id} className="factory-error">
            {sync.id}: {sync.error}
          </p>
        ))}
      {state.data?.deliveries
        .filter((delivery) => delivery.error)
        .map((delivery) => (
          <p key={delivery.id} className="factory-error">
            Issue #{delivery.issueNumber}: {delivery.error}
          </p>
        ))}
    </details>
  );
}
export function FactoryGitHubSource({ detail }: { detail: FactoryDetail }) {
  const state = useGitHub();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remote = detail.source.remote;
  if (!remote) return null;
  return (
    <section className="factory-github">
      <h3>
        <a href={remote.url} target="_blank" rel="noreferrer">
          GitHub issue #{remote.number}
        </a>
      </h3>
      <p>
        Source v{detail.source.version} · {detail.source.status} · reported by{' '}
        {detail.source.actor}
      </p>
      <MarkdownMessage>{detail.source.body}</MarkdownMessage>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await syncFactorySource(detail.work.id);
            await state.refetch();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Sync source
      </button>
      {error && (
        <p role="alert" className="factory-error">
          {error}
        </p>
      )}
      {detail.source.attention && (
        <p className="factory-error">{detail.source.attention}</p>
      )}
      {state.error && (
        <p role="alert">
          Source discussion refresh failed; retained content remains visible.
        </p>
      )}
      {state.data?.deliveries
        .filter(
          (d) =>
            d.connectionId === remote.connectionId &&
            d.issueNumber === remote.number &&
            d.state !== 'complete',
        )
        .map((d) => (
          <p key={d.id}>{d.error ?? 'Source sync pending.'}</p>
        ))}
      <h3>Attributed issue discussion</h3>
      <p>
        External context only. Replies cannot approve, release, or change the
        brief.
      </p>
      {state.data?.comments
        .filter((comment) => comment.workId === detail.work.id)
        .map((comment) => (
          <article key={comment.id}>
            <p>
              <a
                href={`${remote.url}#issuecomment-${comment.remoteId}`}
                target="_blank"
                rel="noreferrer"
              >
                {comment.author}
              </a>{' '}
              · revision {comment.version} ·{' '}
              {comment.deleted ? 'Deleted on GitHub' : comment.remoteUpdatedAt}
            </p>
            <MarkdownMessage>{comment.body}</MarkdownMessage>
            <p>
              {comment.intentId
                ? 'Retained in planner delivery history.'
                : 'Retained context; awaiting an open planning conversation.'}
            </p>
          </article>
        ))}
    </section>
  );
}
