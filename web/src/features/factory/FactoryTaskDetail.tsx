import { FactoryGitHubSource } from './FactoryGitHub';
import { readWorkbenchDraft, writeWorkbenchDraft } from './workbench-draft';
import { useEffect, useRef, useState } from 'react';
import { FactoryPlanning } from './FactoryPlanning';
import { SourceEditor } from './SourceEditor';
import { DocumentRevisionDiff } from '../diff-viewer/DocumentRevisionDiff';
import {
  factorySections,
  factoryDiscussionReference,
} from '../../../../shared/factory-document';
import type { FactoryDiscussionReference } from '../../../../shared/factory-planning';
import {
  factoryPolicy,
  renderFactorySpec,
  type FactoryDetail,
  type FactorySpec,
} from '../../../../shared/factory';
import { mutateFactory } from '../../api/factory';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { BriefingNarrative } from '../../components/BriefingNarrative';
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed. Please retry.';
export function FactoryTaskDetail({
  detail,
  repos,
  refresh,
}: {
  detail: FactoryDetail;
  repos: { id: string; name: string }[];
  refresh: () => Promise<void>;
}) {
  const [stored] = useState(() => readWorkbenchDraft(detail.work.id));
  const [storageError, setStorageError] = useState(false);
  const [editor, setEditor] = useState<{
    spec: FactorySpec;
    version: number;
    specVersion: number;
    repoFingerprint: string | null;
  } | null>(stored?.editor ?? null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sourceDetails = useRef<HTMLDetailsElement>(null);
  const workbench = useRef<HTMLDivElement>(null);
  const [workbenchView, setWorkbenchView] = useState<'chat' | 'brief'>(
    stored?.workbenchView ?? 'brief',
  );
  const latest = detail.revisions.at(-1)!;
  const [viewedVersion, setViewedVersion] = useState(
    stored?.viewedVersion ?? latest.version,
  );
  const viewed =
    detail.revisions.find((r) => r.version === viewedVersion) ?? latest;
  const [compare, setCompare] = useState(stored?.compare ?? false);
  const [compareVersion, setCompareVersion] = useState(
    stored?.compareVersion ??
      detail.revisions.at(-2)?.version ??
      latest.version,
  );
  const before =
    detail.revisions.find((r) => r.version === compareVersion) ?? latest;
  const [discussion, setDiscussion] = useState<
    FactoryDiscussionReference | undefined
  >(stored?.discussion);
  useEffect(() => {
    setStorageError(
      !writeWorkbenchDraft(detail.work.id, {
        editor,
        viewedVersion,
        compareVersion,
        compare,
        workbenchView,
        discussion,
      }),
    );
  }, [
    detail.work.id,
    editor,
    viewedVersion,
    compareVersion,
    compare,
    workbenchView,
    discussion,
  ]);
  const discuss = (
    kind: FactoryDiscussionReference['kind'],
    reference: string,
  ) => {
    setDiscussion(factoryDiscussionReference(viewed, kind, reference));
    setWorkbenchView('chat');
    setTimeout(
      () =>
        workbench.current
          ?.querySelector('.factory-discussion-context')
          ?.scrollIntoView?.({ block: 'center' }),
      0,
    );
  };
  const document = (r: typeof latest) => ({
    id: `${r.workId}:${r.version}:${r.hash}`,
    label: `v${r.version} · ${r.authorKind === 'model' ? 'Neon' : r.actor}`,
    text: renderFactorySpec(r.spec),
  });
  const staleEditor =
    editor &&
    (editor.version !== detail.work.version ||
      editor.specVersion !== latest.version);

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
      {storageError && (
        <p role="alert">
          Browser draft storage is unavailable. Your unsaved work is retained
          while this task stays open; copy it before reloading.
        </p>
      )}
      <div className="factory-title">
        <div>
          <p>
            {detail.source.provider === 'github'
              ? 'GitHub source'
              : 'Manual source'}{' '}
            · {detail.work.repoId ?? 'Repository unresolved'}
          </p>
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
                : latest.spec.decisions.some(
                      (d) => d.blocking && !d.answer?.trim(),
                    )
                  ? 'Needs your decision — answer blocking questions before release.'
                  : detail.blockers.length
                    ? 'Needs your attention — shape the draft and resolve release requirements.'
                    : 'Ready for your review — release requires your explicit decision.'}
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
              draft below. Review the differences, then keep your text against
              the current save base or cancel edits.
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
      <div
        ref={workbench}
        className={`factory-workbench factory-view-${workbenchView}`}
      >
        <FactoryPlanning
          detail={detail}
          discussion={discussion}
          onClearDiscussion={() =>
            setDiscussion((current) =>
              current === discussion ? undefined : current,
            )
          }
        />
        <div className="factory-brief">
          <div className="factory-toolbar factory-version-picker">
            <label>
              Retained version{' '}
              <select
                aria-label="Retained version"
                value={viewed.version}
                onChange={(e) => setViewedVersion(Number(e.target.value))}
              >
                {detail.revisions.map((r) => (
                  <option key={r.version} value={r.version}>
                    v{r.version} · {r.authorKind} ·{' '}
                    {r.version === latest.version ? 'Current' : 'Retained'}
                  </option>
                ))}
              </select>
            </label>
            <button aria-pressed={compare} onClick={() => setCompare(!compare)}>
              {compare ? 'Read brief' : 'Compare versions'}
            </button>
            {viewed.version !== latest.version && (
              <button onClick={() => setViewedVersion(latest.version)}>
                View current v{latest.version}
              </button>
            )}
          </div>
          <div hidden={!compare}>
            <label>
              Compare from{' '}
              <select
                aria-label="Compare from"
                value={before.version}
                onChange={(e) => setCompareVersion(Number(e.target.value))}
              >
                {detail.revisions.map((r) => (
                  <option key={r.version} value={r.version}>
                    v{r.version} · {r.authorKind === 'model' ? 'Neon' : r.actor}
                  </option>
                ))}
              </select>
            </label>
            {compare && (
              <DocumentRevisionDiff
                before={document(before)}
                after={document(viewed)}
              />
            )}
          </div>
          <div hidden={compare}>
            {!editor ? (
              <>
                <div className="factory-toolbar">
                  <h3>
                    Draft v{viewed.version}
                    {viewed.authorKind === 'model' ? ' · Proposed by Neon' : ''}
                  </h3>
                  <button
                    disabled={
                      busy ||
                      detail.work.lifecycle === 'closed' ||
                      viewed.version !== latest.version
                    }
                    onClick={beginEdit}
                  >
                    Edit draft
                  </button>
                </div>
                <p>
                  {viewed.authorKind === 'model' ? 'Neon' : viewed.actor} ·{' '}
                  {new Date(viewed.createdAt).toLocaleString()} · Source v
                  {viewed.sourceVersion}
                </p>
                {factorySections.map(([key, label]) => (
                  <section className="factory-spec-section" key={key}>
                    <div className="factory-toolbar">
                      <h3>{label}</h3>
                      <button onClick={() => discuss('section', key)}>
                        Discuss {label.toLowerCase()}
                      </button>
                    </div>
                    <BriefingNarrative>
                      {viewed.spec[key] || '_Not specified._'}
                    </BriefingNarrative>
                  </section>
                ))}
                <section className="factory-spec-section">
                  <h3>Acceptance criteria</h3>
                  {!viewed.spec.acceptanceCriteria.length && (
                    <p>No acceptance criteria yet.</p>
                  )}
                  {viewed.spec.acceptanceCriteria.map((c) => (
                    <div key={c.id}>
                      <p>
                        <strong>{c.id}</strong> · {c.text}
                      </p>
                      <button onClick={() => discuss('criterion', c.id)}>
                        Discuss {c.id}
                      </button>
                    </div>
                  ))}
                </section>
                <section className="factory-spec-section">
                  <h3>Decisions</h3>
                  {!viewed.spec.decisions.length && <p>No open decisions.</p>}
                  {viewed.spec.decisions.map((d) => (
                    <div key={d.id}>
                      <p>
                        <strong>
                          {d.id} · {d.blocking ? 'Blocking' : 'Optional'}
                        </strong>{' '}
                        — {d.question}
                      </p>
                      <MarkdownMessage>
                        {d.answer?.trim() || '_Needs your answer._'}
                      </MarkdownMessage>
                      <button onClick={() => discuss('decision', d.id)}>
                        Discuss {d.id}
                      </button>
                      {!d.answer?.trim() &&
                        viewed.version === latest.version && (
                          <button disabled={busy} onClick={beginEdit}>
                            Answer in a new revision
                          </button>
                        )}
                    </div>
                  ))}
                </section>
                <section className="factory-spec-section">
                  <h3>References</h3>
                  {viewed.spec.references.map((r) => (
                    <p key={`${r.path}:${r.commit}`}>
                      {r.path} @ {r.commit}: {r.note}
                    </p>
                  ))}
                  {!viewed.spec.references.length && (
                    <p>No references recorded.</p>
                  )}
                </section>
              </>
            ) : (
              <form
                className="factory-form"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const saved = await mutate('spec', {
                    expectedVersion: editor.version,
                    expectedSpecVersion: editor.specVersion,
                    expectedRepoFingerprint: editor.repoFingerprint,
                    spec: editor.spec,
                  });
                  if (saved) {
                    setEditor(null);
                    setViewedVersion(saved.work.specVersion);
                  }
                }}
              >
                <fieldset disabled={busy} className="factory-editor-fields">
                  <legend className="sr-only">Draft editor</legend>
                  <h3>Editing v{editor.specVersion}</h3>
                  {staleEditor && (
                    <section className="factory-error" role="alert">
                      <h3>Saved task changed — your text is retained</h3>
                      <p>
                        Current brief v{latest.version}, source v
                        {detail.source.version}: {detail.source.title}
                      </p>
                      <details>
                        <summary>Review current source</summary>
                        <p>{detail.source.body}</p>
                      </details>
                      <DocumentRevisionDiff
                        before={document(latest)}
                        after={{
                          id: `local:${JSON.stringify(editor.spec)}`,
                          label: 'Your unsaved draft',
                          text: renderFactorySpec(editor.spec),
                        }}
                      />
                      <p>
                        Keeping your text will replace the current brief with
                        your draft in a new revision. Review all differences and
                        the current source first. Repository context requires
                        its own acknowledgement below.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          setEditor({
                            ...editor,
                            version: detail.work.version,
                            specVersion: latest.version,
                          })
                        }
                      >
                        Use current save base and keep my text
                      </button>
                    </section>
                  )}
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
                          above before accepting it. Your draft text stays
                          intact.
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
                  <fieldset>
                    <legend>Decisions — answers create a human revision</legend>
                    {editor.spec.decisions.map((decision, index) => (
                      <label key={decision.id}>
                        {decision.id} · {decision.question} (
                        {decision.blocking ? 'blocking' : 'optional'})
                        <textarea
                          aria-label={`Answer ${decision.id}`}
                          rows={3}
                          maxLength={20000}
                          value={decision.answer ?? ''}
                          onChange={(e) =>
                            setEditor({
                              ...editor,
                              spec: {
                                ...editor.spec,
                                decisions: editor.spec.decisions.map((d, i) =>
                                  i === index
                                    ? {
                                        ...d,
                                        answer: e.target.value.trim()
                                          ? e.target.value
                                          : null,
                                      }
                                    : d,
                                ),
                              },
                            })
                          }
                        />
                      </label>
                    ))}
                    {!editor.spec.decisions.length && (
                      <p>No decisions to resolve.</p>
                    )}
                  </fieldset>
                  <div className="factory-toolbar">
                    <button disabled={busy || !!staleEditor} type="submit">
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
      </div>
      <section className="factory-release">
        <h3>Review release v{viewed.version}</h3>
        <p>
          Policy {factoryPolicy.version}: implement this exact specification in
          an isolated worktree and run repo-configured checks. No publish, merge
          or deploy authority. No coding executor is available.
        </p>
        <p>
          Source v{viewed.sourceVersion} · {viewed.authorKind}:{' '}
          {viewed.authorKind === 'model' ? 'Neon' : viewed.actor}
        </p>
        {viewed.version !== latest.version && (
          <p role="status">
            Viewing retained v{viewed.version}. Only the current version can be
            released. Select and review v{latest.version} first.
          </p>
        )}
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
              busy ||
              !!editor ||
              viewed.version !== latest.version ||
              detail.blockers.length > 0 ||
              detail.eligible
            }
            onClick={() =>
              void mutate('release', {
                requestKey: crypto.randomUUID(),
                expectedVersion: detail.work.version,
                specVersion: viewed.version,
                specHash: viewed.hash,
                sourceVersion: detail.source.version,
                repoFingerprint: detail.repoFingerprint,
                policyVersion: factoryPolicy.version,
              })
            }
          >
            Release v{viewed.version}
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
        {detail.source.provider === 'github' ? (
          <FactoryGitHubSource detail={detail} />
        ) : (
          <SourceEditor
            detail={detail}
            repos={repos}
            disabled={busy || !!editor || detail.work.lifecycle === 'closed'}
            onSave={(input) => mutate('source', input)}
            onReload={() => setError('')}
          />
        )}
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
