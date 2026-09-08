import { FactoryLinearSource } from './FactoryLinearSource';
import { useQueryClient } from '@tanstack/react-query';
import {
  FactoryLifecycle,
  FactoryStageSection,
  useFactoryLifecycle,
} from './FactoryLifecycle';
import { FactoryTimeline } from './FactoryTimeline';
import { FactoryReleaseCoding } from './FactoryReleaseCoding';
import { FactoryCoding } from './FactoryCoding';
import { FactoryGitHubSource } from './FactoryGitHub';
import { useFactoryWorkbench } from './useFactoryWorkbench';
import { FactoryDraftRecovery } from './FactoryDraftRecovery';
import { FactorySpecEditor } from './FactorySpecEditor';
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
} from '../../../../shared/factory';
import { mutateFactory, type FactoryMutationArgs } from '../../api/factory';
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
  const {
    editor,
    setEditor,
    storageError,
    recovery,
    retryRecovery,
    discardRecovery,
    workbenchView,
    setWorkbenchView,
    viewedVersion,
    setViewedVersion,
    compare,
    setCompare,
    compareVersion,
    setCompareVersion,
    discussion,
    setDiscussion,
  } = useFactoryWorkbench(detail);
  const client = useQueryClient();
  const lifecycle = useFactoryLifecycle(detail);
  const [planReveal, setPlanReveal] = useState(0);
  const [currentNavigation, setCurrentNavigation] = useState(0);
  const [navigationTarget, setNavigationTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!navigationTarget) return;
    const reveal = () => {
      const element = window.document.getElementById(navigationTarget);
      if (!element) return false;
      element.scrollIntoView?.({ block: 'start' });
      element.focus({ preventScroll: true });
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => {
      if (reveal()) observer.disconnect();
    });
    const root = window.document.querySelector('.factory-main');
    if (root) observer.observe(root, { childList: true, subtree: true });
    const timeout = setTimeout(() => observer.disconnect(), 10000);
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [navigationTarget, currentNavigation]);
  const [deliveryEvidence, setDeliveryEvidence] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sourceDetails = useRef<HTMLDetailsElement>(null);
  const workbench = useRef<HTMLDivElement>(null);
  const latest = detail.revisions.at(-1)!;
  const viewed =
    detail.revisions.find((r) => r.version === viewedVersion) ?? latest;
  const before =
    detail.revisions.find((r) => r.version === compareVersion) ?? latest;
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
  async function mutate(...command: FactoryMutationArgs) {
    setBusy(true);
    setError('');
    try {
      const saved = await mutateFactory(detail.work.id, ...command);
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
  return (
    <>
      {recovery && (
        <FactoryDraftRecovery
          recovery={recovery}
          onRetry={retryRecovery}
          onDiscard={discardRecovery}
        />
      )}
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
              : detail.source.provider === 'linear'
                ? 'Linear source'
                : 'Manual source'}{' '}
            · {detail.work.repoId ?? 'Repository unresolved'}
          </p>
          <h2>{detail.work.title}</h2>
        </div>
        <span>
          Brief v{latest.version} · {lifecycle.stage ?? 'Status unavailable'}
        </span>
      </div>
      <FactoryLifecycle
        state={lifecycle}
        onNavigate={() => {
          if (lifecycle.stage === null) {
            void client.invalidateQueries({
              queryKey: ['factory-coding-runs', detail.work.id],
            });
            void client.invalidateQueries({
              queryKey: ['factory-delivery-state'],
            });
          }
          const target =
            lifecycle.title === 'Validation could not start'
              ? 'factory-validation-attention'
              : lifecycle.stage === null
                ? 'factory-code'
                : lifecycle.stage === 'Plan'
                  ? 'factory-plan'
                  : lifecycle.stage === 'Code'
                    ? 'factory-code'
                    : lifecycle.stage === 'Approve PR'
                      ? 'factory-publication'
                      : 'factory-review-result';
          if (lifecycle.stage === 'Plan') setPlanReveal((value) => value + 1);
          setCurrentNavigation((value) => value + 1);
          setNavigationTarget(target);
        }}
      />
      <details className="factory-plan-status">
        <summary>Plan readiness</summary>
        <p className="factory-status">
          {detail.eligible
            ? 'Released · coding status below'
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
                      : recovery
                        ? 'Saved draft needs recovery before release.'
                        : editor
                          ? 'Local draft open — review or cancel edits before release.'
                          : busy
                            ? 'Saving task changes — wait before releasing.'
                            : 'Ready for your review — release requires your explicit decision.'}
        </p>
      </details>
      <FactoryCoding
        currentNavigation={currentNavigation}
        currentReleaseId={
          detail.releases
            .filter(
              (release) =>
                release.specVersion === detail.work.specVersion &&
                !release.withdrawnAt,
            )
            .at(-1)?.id
        }
        automaticValidationReleaseIds={detail.releases
          .filter((release) => release.validationPolicy)
          .map((release) => release.id)}
        onDiscussDelivery={(evidence) => {
          setDeliveryEvidence(evidence);
          setWorkbenchView('chat');
          setTimeout(
            () => workbench.current?.scrollIntoView?.({ block: 'start' }),
            0,
          );
        }}
        key={detail.work.id}
        workId={detail.work.id}
        eligible={detail.eligible}
      />
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
      <div id="factory-plan" tabIndex={-1}>
        <FactoryStageSection
          title="Plan and conversation"
          reveal={planReveal}
          current={
            lifecycle.stage === 'Plan' ||
            !!deliveryEvidence ||
            !!discussion ||
            !!editor
          }
        >
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
              deliveryEvidence={deliveryEvidence}
              onClearDeliveryEvidence={() => setDeliveryEvidence(undefined)}
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
                <button
                  aria-pressed={compare}
                  onClick={() => setCompare(!compare)}
                >
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
                        v{r.version} ·{' '}
                        {r.authorKind === 'model' ? 'Neon' : r.actor}
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
                        {viewed.authorKind === 'model'
                          ? ' · Proposed by Neon'
                          : ''}
                      </h3>
                      <button
                        disabled={
                          busy ||
                          !!recovery ||
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
                      {!viewed.spec.decisions.length && (
                        <p>No open decisions.</p>
                      )}
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
                              <button
                                disabled={busy || !!recovery}
                                onClick={beginEdit}
                              >
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
                  <FactorySpecEditor
                    editor={editor}
                    setEditor={setEditor}
                    detail={detail}
                    busy={busy}
                    onSave={async () => {
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
                  />
                )}
              </div>
            </div>
          </div>
          <section className="factory-release">
            <h3>Review release v{viewed.version}</h3>
            <p>
              Policy {factoryPolicy.version}: implement this exact specification
              in an isolated worktree and run repo-configured checks. No
              publish, merge or deploy authority. When local coding is enabled
              and ready, eligible releases dispatch automatically.
            </p>
            <p>
              Source v{viewed.sourceVersion} · {viewed.authorKind}:{' '}
              {viewed.authorKind === 'model' ? 'Neon' : viewed.actor}
            </p>
            <FactoryReleaseCoding
              key={`${detail.work.id}:${viewed.version}`}
              label="Approve plan and start"
              workflowId={viewed.spec.workflowId}
              repoId={detail.work.repoId ?? undefined}
              releaseNotice={
                <>
                  {editor && (
                    <p>
                      Release and task transitions are blocked while your local
                      draft of v{editor.specVersion} is open. The latest saved
                      brief is v{latest.version}. Review and save your edits, or
                      choose Cancel edits in the editor to use the saved brief.{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setCompare(false);
                          setWorkbenchView('brief');
                          setTimeout(() => {
                            const field =
                              workbench.current?.querySelector<HTMLTextAreaElement>(
                                '.factory-editor-fields textarea',
                              );
                            field?.scrollIntoView?.({ block: 'center' });
                            field?.focus();
                          }, 0);
                        }}
                      >
                        Review local draft
                      </button>
                    </p>
                  )}
                  {recovery && (
                    <p>
                      Release is blocked until you resolve Saved draft needs
                      recovery above. Retained draft data has not been
                      discarded.
                    </p>
                  )}
                  {busy && (
                    <p>
                      <output>
                        Saving task changes. Wait for the result before
                        releasing.
                      </output>
                    </p>
                  )}
                  {viewed.version !== latest.version && (
                    <p>
                      Viewing retained v{viewed.version}. Only the current
                      version can be released. Select and review v
                      {latest.version} first.
                    </p>
                  )}
                  {detail.blockers.length > 0 && (
                    <ul>
                      {detail.blockers.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  {!detail.repoFingerprint && (
                    <p>
                      Release requires current repository context. Review Source
                      and repository below.
                    </p>
                  )}
                  {detail.eligible && (
                    <p>
                      This task is already released. Check coding status above
                      for execution progress.
                    </p>
                  )}
                </>
              }
              disabled={
                busy ||
                !!editor ||
                !!recovery ||
                viewed.version !== latest.version ||
                detail.blockers.length > 0 ||
                !detail.repoFingerprint ||
                detail.eligible
              }
              onRelease={(fingerprint, validationPolicy, workflowId) => {
                if (!detail.repoFingerprint) return;
                void mutate('release', {
                  requestKey: crypto.randomUUID(),
                  expectedVersion: detail.work.version,
                  specVersion: viewed.version,
                  specHash: viewed.hash,
                  sourceVersion: detail.source.version,
                  repoFingerprint: detail.repoFingerprint,
                  policyVersion: factoryPolicy.version,
                  expectedCodingConfigFingerprint: fingerprint,
                  validationPolicy,
                  workflowId,
                });
              }}
            />
            <div className="factory-toolbar">
              {detail.work.lifecycle === 'paused' ||
              detail.work.lifecycle === 'closed' ? (
                <button
                  disabled={busy || !!editor || !!recovery}
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
        </FactoryStageSection>
      </div>
      <details className="factory-source" ref={sourceDetails}>
        <summary>Source and repository</summary>
        <p>
          Changing source context requires saving and reviewing a new revision.
        </p>
        {detail.source.provider === 'github' ? (
          <FactoryGitHubSource detail={detail} />
        ) : detail.source.provider === 'linear' ? (
          <FactoryLinearSource key={detail.work.id} detail={detail} />
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
      <FactoryTimeline
        key={`timeline:${detail.work.id}`}
        workId={detail.work.id}
      />
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
