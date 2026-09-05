import { FactoryGitHubSetup } from './FactoryGitHub';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  getFactoryDetail,
  getFactoryState,
  mutateFactory,
  setFactoryEnabled,
  dashboardEventHub,
} from '../../api/factory';
import { FactoryTaskDetail } from './FactoryTaskDetail';
import './factory.css';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed. Please retry.';
export function FactoryNav() {
  const state = useQuery({
    queryKey: ['factory-state'],
    queryFn: getFactoryState,
    refetchInterval: 30000,
  });
  return state.data?.enabled ? (
    <a className="factory-nav" href="/factory">
      Factory inbox
    </a>
  ) : null;
}
export function FactoryPage() {
  const client = useQueryClient();
  const [id, setId] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('task'),
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const state = useQuery({
    queryKey: ['factory-state'],
    queryFn: getFactoryState,
    refetchInterval: 15000,
  });
  useEffect(
    () =>
      dashboardEventHub.subscribe('factory-change', () => {
        void client.invalidateQueries({ queryKey: ['factory-state'] });
        void client.invalidateQueries({ queryKey: ['factory-detail'] });
      }),
    [client],
  );
  const selected = useQuery({
    queryKey: ['factory-detail', id],
    queryFn: () => getFactoryDetail(id!),
    enabled: !!id,
    refetchInterval: 15000,
  });
  const select = (next: string | null) => {
    if (busy) return;
    setId(next);
    history.replaceState(
      null,
      '',
      next ? `/factory?task=${encodeURIComponent(next)}` : '/factory',
    );
    setError('');
  };
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['factory-state'] });
    await client.invalidateQueries({ queryKey: ['factory-detail'] });
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    try {
      const task = await mutateFactory(null, 'create', {
        requestKey,
        title: String(data.get('title') ?? ''),
        body: String(data.get('body') ?? ''),
        repoId: String(data.get('repoId') ?? '') || null,
      });
      setRequestKey(crypto.randomUUID());
      form.reset();
      select(task.work.id);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="factory-page bg-bg text-ink">
      <header className="factory-header">
        <a href="/">← Dashboard</a>
        <h1>Factory inbox</h1>
        <span>Intake and shaping</span>
        <button onClick={() => void refresh()}>Refresh</button>
      </header>
      {state.data && <FactoryGitHubSetup repos={state.data.repos} />}
      {state.error && state.data && (
        <p className="factory-error" role="alert">
          Inbox refresh failed: {message(state.error)}. Showing the last loaded
          data; your edits are retained.
        </p>
      )}
      {selected.error && selected.data && (
        <p className="factory-error" role="alert">
          Task refresh failed: {message(selected.error)}. Showing the last
          loaded data; your edits are retained.
        </p>
      )}
      {state.isPending ? (
        <output>Loading factory…</output>
      ) : state.error && !state.data ? (
        <div role="alert">
          <h2>Factory unavailable</h2>
          <p>{message(state.error)}</p>
          <button onClick={() => void state.refetch()}>Retry</button>
        </div>
      ) : state.data && !state.data.enabled ? (
        <section className="factory-empty">
          <h2>Collect the next piece of work</h2>
          <p>
            Factory is disabled. Enable manual intake to keep tasks and draft
            specifications here.
          </p>
          <p>
            Releasing a reviewed version records permission for future isolated
            implementation and repo-configured checks. Publishing, merging and
            deployment are not permitted. Coding execution is not available yet.
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await setFactoryEnabled(true);
                await refresh();
              } catch (e) {
                setError(message(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Enable manual intake
          </button>
        </section>
      ) : state.data ? (
        <div className="factory-layout">
          <aside className="factory-inbox">
            <h2>
              Tasks <span>({state.data.items.length})</span>
            </h2>
            <button disabled={busy} onClick={() => select(null)}>
              New task
            </button>
            {!state.data.items.length ? (
              <p>No tasks yet. Add an outcome to start a draft.</p>
            ) : (
              <ul>
                {state.data.items.map((item) => (
                  <li key={item.id}>
                    <button
                      disabled={busy}
                      aria-current={id === item.id ? 'page' : undefined}
                      onClick={() => select(item.id)}
                    >
                      <strong>{item.title}</strong>
                      <span>
                        {item.lifecycle === 'queued'
                          ? 'Released · review eligibility in detail'
                          : item.lifecycle}{' '}
                        · {item.repoId ?? 'Repo needed'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="factory-note">
              Neon triages new tasks and helps shape a brief. You review and
              release each task.
            </p>
          </aside>
          <section className="factory-main">
            {!id ? (
              <>
                <h2>New task</h2>
                <p>
                  Describe the outcome. Choose a repository now, or resolve it
                  before release.
                </p>
                <form onSubmit={submit} className="factory-form">
                  <fieldset disabled={busy}>
                    <label>
                      Title
                      <input name="title" required maxLength={240} />
                    </label>
                    <label>
                      Requested outcome
                      <textarea name="body" rows={7} maxLength={20000} />
                    </label>
                    <label>
                      Repository
                      <select name="repoId">
                        <option value="">Unresolved — choose later</option>
                        {state.data.repos.map((repo) => (
                          <option key={repo.id} value={repo.id}>
                            {repo.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button disabled={busy} type="submit">
                      {busy ? 'Saving…' : 'Create task'}
                    </button>
                  </fieldset>
                </form>
              </>
            ) : selected.isPending ? (
              <output>Loading task…</output>
            ) : selected.error && !selected.data ? (
              <div role="alert">
                <h2>Task unavailable</h2>
                <p>{message(selected.error)}</p>
                <button onClick={() => void selected.refetch()}>Retry</button>
              </div>
            ) : selected.data ? (
              <FactoryTaskDetail
                key={id}
                detail={selected.data}
                repos={state.data.repos}
                refresh={refresh}
              />
            ) : null}
          </section>
        </div>
      ) : null}
      {error && (
        <p className="factory-error" role="alert">
          {error} Your input is retained; retry when ready.
        </p>
      )}
    </main>
  );
}
