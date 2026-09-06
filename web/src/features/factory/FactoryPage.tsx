import { FactoryPlanning } from './FactoryPlanning';
import { SourceEditor } from './SourceEditor';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  factoryPolicy,
  renderFactorySpec,
  type FactoryDetail,
  type FactorySpec,
} from '../../../../shared/factory';
import {
  getFactoryDetail,
  getFactoryState,
  mutateFactory,
  setFactoryEnabled,
  dashboardEventHub,
} from '../../api/factory';
import { MarkdownMessage } from '../../components/MarkdownMessage';
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
      const task = await mutateFactory(null, '', {
        requestKey,
        title: data.get('title'),
        body: data.get('body'),
        repoId: data.get('repoId') || null,
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
        <span>Manual intake</span>
        <button onClick={() => void refresh()}>Refresh</button>
      </header>
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
              <TaskDetail
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
function TaskDetail({
  detail,
  repos,
  refresh,
}: {
  detail: FactoryDetail;
  repos: { id: string; name: string }[];
  refresh: () => Promise<void>;
}) {
  const [editor, setEditor] = useState<{
    spec: FactorySpec;
    version: number;
    specVersion: number;
    repoFingerprint: string | null;
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sourceDetails = useRef<HTMLDetailsElement>(null);
  const [workbenchView, setWorkbenchView] = useState<'chat' | 'brief'>('brief');
  const latest = detail.revisions.at(-1)!;
  async function mutate(action: string, input: unknown) {
    setBusy(true);
    setError('');
    try {
      const saved = await mutateFactory(detail.work.id, action, input);
      await refresh();
      return saved;
    } catch (e) {
      setError(message(e));
      await refresh();
      return null;
    } finally {
      setBusy(false);
    }
  }
  const beginEdit = () =>
    setEditor({
      spec: structuredClone(latest.spec),
      version: detail.work.version,
      specVersion: latest.version,
      repoFingerprint: latest.repoFingerprint,
    });
  const change = (field: keyof FactorySpec, value: string) => {
    if (editor)
      setEditor({ ...editor, spec: { ...editor.spec, [field]: value } });
  };
  return (
    <>
      <div className="factory-title">
        <div>
          <p>Manual source · {detail.work.repoId ?? 'Repository unresolved'}</p>
          <h2>{detail.work.title}</h2>
        </div>
        <span>
          v{latest.version} · {detail.work.lifecycle}
        </span>
      </div>
      <p className="factory-status">
        {detail.eligible
          ? 'Released — awaiting coding executor'
          : detail.work.lifecycle === 'queued'
            ? 'Release needs review — not eligible for coding'
            : detail.work.lifecycle === 'paused'
              ? 'Paused — reopen to continue shaping'
              : detail.work.lifecycle === 'closed'
                ? 'Closed — history retained'
                : 'Your next step: shape the draft, then review for release.'}
      </p>
      {!detail.work.repoId && (
        <p>
          Select a repository before release.{' '}
          <button
            onClick={() => {
              if (sourceDetails.current) {
                sourceDetails.current.open = true;
                sourceDetails.current.querySelector('select')?.focus();
              }
            }}
          >
            Choose repository
          </button>
        </p>
      )}
      {error && (
        <div className="factory-error" role="alert">
          {error}
          {editor && (
            <p>
              Your local draft is preserved. Compare it with the current saved
              draft below. Cancel to reload; copy your edits first.
            </p>
          )}
        </div>
      )}
      <nav className="factory-workbench-tabs" aria-label="Task views">
        <button
          aria-pressed={workbenchView === 'chat'}
          onClick={() => setWorkbenchView('chat')}
        >
          Conversation
        </button>
        <button
          aria-pressed={workbenchView === 'brief'}
          onClick={() => setWorkbenchView('brief')}
        >
          Brief v{latest.version}
        </button>
      </nav>
      <div className={`factory-workbench factory-view-${workbenchView}`}>
        <FactoryPlanning detail={detail} />
        <div className="factory-brief">
          {!editor ? (
            <>
              <div className="factory-toolbar">
                <h3>
                  Draft v{latest.version}
                  {latest.authorKind === 'model' ? ' · Proposed by Neon' : ''}
                </h3>
                <button
                  disabled={busy || detail.work.lifecycle === 'closed'}
                  onClick={beginEdit}
                >
                  Edit draft
                </button>
              </div>
              <MarkdownMessage>
                {renderFactorySpec(latest.spec)}
              </MarkdownMessage>
            </>
          ) : (
            <form
              className="factory-form"
              onSubmit={async (event) => {
                event.preventDefault();
                if (
                  await mutate('spec', {
                    expectedVersion: editor.version,
                    expectedSpecVersion: editor.specVersion,
                    expectedRepoFingerprint: editor.repoFingerprint,
                    spec: editor.spec,
                  })
                )
                  setEditor(null);
              }}
            >
              <fieldset disabled={busy} className="factory-editor-fields">
                <legend className="sr-only">Draft editor</legend>
                <h3>Editing v{editor.specVersion}</h3>
                <section className="factory-source">
                  <h3>Repository context</h3>
                  {detail.repoContext ? (
                    <>
                      <p>
                        Path: {detail.repoContext.path}
                        <br />
                        Branch: {detail.repoContext.defaultBranch}
                      </p>
                      <p>
                        Configured commands:{' '}
                        {Object.entries(detail.repoContext.commands)
                          .map(([name, command]) => `${name}: ${command}`)
                          .join('; ') || 'None configured'}
                      </p>
                    </>
                  ) : (
                    <p>No registered repository selected.</p>
                  )}
                  {editor.repoFingerprint !== detail.repoFingerprint && (
                    <>
                      <p>
                        The repository configuration differs from this draft's
                        reviewed context. Review the path, branch and commands
                        above before accepting it. Your draft text stays intact.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          setEditor({
                            ...editor,
                            repoFingerprint: detail.repoFingerprint,
                          })
                        }
                      >
                        Use this reviewed repository context
                      </button>
                    </>
                  )}
                </section>

                {(
                  [
                    'outcome',
                    'scope',
                    'nonGoals',
                    'approach',
                    'constraints',
                    'assumptions',
                  ] as const
                ).map((field) => (
                  <label key={field}>
                    {
                      {
                        outcome: 'Outcome',
                        scope: 'Scope',
                        nonGoals: 'Non-goals',
                        approach: 'Approach (Markdown)',
                        constraints: 'Constraints',
                        assumptions: 'Assumptions',
                      }[field]
                    }
                    <textarea
                      rows={field === 'approach' ? 6 : 3}
                      maxLength={20000}
                      value={editor.spec[field]}
                      onChange={(event) => change(field, event.target.value)}
                    />
                  </label>
                ))}
                <fieldset>
                  <legend>Acceptance criteria</legend>
                  {editor.spec.acceptanceCriteria.map((criterion, index) => (
                    <label key={criterion.id}>
                      {criterion.id}
                      <input
                        required
                        maxLength={240}
                        value={criterion.text}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            spec: {
                              ...editor.spec,
                              acceptanceCriteria:
                                editor.spec.acceptanceCriteria.map((c, i) =>
                                  i === index
                                    ? { ...c, text: event.target.value }
                                    : c,
                                ),
                            },
                          })
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setEditor({
                            ...editor,
                            spec: {
                              ...editor.spec,
                              acceptanceCriteria:
                                editor.spec.acceptanceCriteria.filter(
                                  (c) => c.id !== criterion.id,
                                ),
                            },
                          })
                        }
                      >
                        Remove {criterion.id}
                      </button>
                    </label>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setEditor({
                        ...editor,
                        spec: {
                          ...editor.spec,
                          acceptanceCriteria: [
                            ...editor.spec.acceptanceCriteria,
                            {
                              id: `ac-${crypto.randomUUID().slice(0, 8)}`,
                              text: '',
                            },
                          ],
                        },
                      })
                    }
                  >
                    Add criterion
                  </button>
                </fieldset>
                <div className="factory-toolbar">
                  <button disabled={busy} type="submit">
                    Save new revision
                  </button>
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => setEditor(null)}
                  >
                    Cancel edits
                  </button>
                </div>
                {editor.specVersion !== latest.version && (
                  <details open>
                    <summary>Current saved draft v{latest.version}</summary>
                    <MarkdownMessage>
                      {renderFactorySpec(latest.spec)}
                    </MarkdownMessage>
                  </details>
                )}
              </fieldset>
            </form>
          )}
        </div>
      </div>
      <section className="factory-release">
        <h3>Review release v{latest.version}</h3>
        <p>
          Policy {factoryPolicy.version}: implement this exact specification in
          an isolated worktree and run repo-configured checks. No publish, merge
          or deploy authority. No coding executor is available.
        </p>
        <p>
          Source v{detail.source.version} · {latest.authorKind}: {latest.actor}
        </p>
        {detail.blockers.length > 0 && (
          <ul>
            {detail.blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <div className="factory-toolbar">
          <button
            disabled={
              busy || !!editor || detail.blockers.length > 0 || detail.eligible
            }
            onClick={() =>
              void mutate('release', {
                requestKey: crypto.randomUUID(),
                expectedVersion: detail.work.version,
                specVersion: latest.version,
                specHash: latest.hash,
                sourceVersion: detail.source.version,
                repoFingerprint: detail.repoFingerprint,
                policyVersion: factoryPolicy.version,
              })
            }
          >
            Release v{latest.version}
          </button>
          {detail.work.lifecycle === 'paused' ||
          detail.work.lifecycle === 'closed' ? (
            <button
              disabled={busy || !!editor}
              onClick={() =>
                void mutate('transition', {
                  expectedVersion: detail.work.version,
                  action: 'reopen',
                })
              }
            >
              Reopen shaping
            </button>
          ) : (
            <button
              disabled={busy || !!editor}
              onClick={() =>
                void mutate('transition', {
                  expectedVersion: detail.work.version,
                  action: 'pause',
                })
              }
            >
              Pause
            </button>
          )}
          {detail.work.lifecycle === 'queued' && (
            <button
              disabled={busy || !!editor}
              onClick={() =>
                void mutate('transition', {
                  expectedVersion: detail.work.version,
                  action: 'withdraw',
                })
              }
            >
              Withdraw release
            </button>
          )}
        </div>
      </section>
      <details className="factory-source" ref={sourceDetails}>
        <summary>Source and repository</summary>
        <p>
          Changing source context requires saving and reviewing a new revision.
        </p>
        <SourceEditor
          detail={detail}
          repos={repos}
          disabled={busy || !!editor || detail.work.lifecycle === 'closed'}
          onSave={(input) => mutate('source', input)}
          onReload={() => setError('')}
        />
      </details>
      <details className="factory-history">
        <summary>
          Retained history · {detail.revisions.length} revisions ·{' '}
          {detail.releases.length} releases
        </summary>
        {detail.revisions.map((revision) => (
          <details key={revision.version}>
            <summary>
              v{revision.version} · {revision.actor} ·{' '}
              {new Date(revision.createdAt).toLocaleString()}
            </summary>
            <MarkdownMessage>
              {renderFactorySpec(revision.spec)}
            </MarkdownMessage>
          </details>
        ))}
        {detail.releases.map((release) => (
          <p key={release.id}>
            Release v{release.specVersion} · {release.actor} ·{' '}
            {release.withdrawnAt
              ? `Withdrawn: ${release.withdrawalReason}`
              : 'Recorded'}{' '}
            · {release.policy.version}
          </p>
        ))}
      </details>
    </>
  );
}
