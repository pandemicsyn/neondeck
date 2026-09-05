import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FactoryDetail } from '../../../../shared/factory';
import {
  statusLabels,
  type WritebackApprovalInput,
  type WritebackRepair,
} from '../../../../shared/factory-writeback';
import {
  getFactoryWriteback,
  setFactoryWriteback,
  approveFactoryWriteback,
  recoverFactoryWriteback,
  previewFactoryWritebackRepair,
  approveFactoryWritebackRepair,
} from '../../api/factory';
import { MarkdownMessage } from '../../components/MarkdownMessage';
export function FactoryWriteback({ detail }: { detail: FactoryDetail }) {
  const query = useQuery({
    queryKey: ['factory-writeback', detail.work.id],
    queryFn: () => getFactoryWriteback(detail.work.id),
    refetchInterval: 5000,
  });
  const [draft, setDraft] = useState<WritebackApprovalInput | null>(null);
  const [preview, setPreview] = useState(false);
  const [policyPreview, setPolicyPreview] = useState<{
    epoch: string;
    fingerprint: string;
    template: string;
  } | null>(null);
  const [repair, setRepair] = useState<WritebackRepair | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const data = query.data,
    remote = detail.source.remote!;
  async function perform(action: () => Promise<unknown>, done?: () => void) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      done?.();
      await query.refetch();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Request failed. Your input is retained.',
      );
    } finally {
      setBusy(false);
    }
  }
  function compose(
    kind: 'summary' | 'question',
    body = '',
    decisionId: string | null = null,
  ) {
    const revision = detail.revisions.at(-1)!;
    setPreview(false);
    setDraft({
      requestKey: crypto.randomUUID(),
      expectedVersion: detail.work.version,
      specVersion: revision.version,
      specHash: revision.hash,
      sourceVersion: detail.source.version,
      issueId: remote.issueId,
      kind,
      body,
      decisionId,
    });
  }
  return (
    <section
      className="factory-writeback factory-source"
      aria-label="GitHub publishing"
    >
      <h3>GitHub publishing</h3>
      <p>
        Target:{' '}
        <a href={remote.url} target="_blank" rel="noreferrer">
          {remote.url}
        </a>
        . Public comments are visible to everyone with issue access.
      </p>
      {(error || query.error) && (
        <p role="alert" className="factory-error">
          {error ||
            'Publishing status refresh failed. Retained content and your input remain available.'}
        </p>
      )}
      {!data && <p>Loading publishing policy…</p>}
      {data && (
        <>
          <p>
            <strong>
              {data.policy.enabled
                ? 'Writeback enabled for this connection'
                : 'Writeback off — no new comments or updates'}
            </strong>
          </p>
          <p>
            Disabling cancels queued writes. A request already sent may finish;
            its receipt remains visible. Publication failures do not block human
            release.
          </p>
          <button
            disabled={busy}
            onClick={() =>
              data.policy.enabled
                ? void perform(() =>
                    setFactoryWriteback(remote.connectionId, {
                      enabled: false,
                      expectedEpoch: data.policy.epoch,
                      expectedFingerprint: data.connectionFingerprint,
                    }),
                  )
                : setPolicyPreview({
                    epoch: data.policy.epoch,
                    fingerprint: data.connectionFingerprint,
                    template: data.template,
                  })
            }
          >
            {data.policy.enabled
              ? 'Disable writeback'
              : 'Review writeback policy'}
          </button>
          {policyPreview && (
            <div className="factory-writeback-preview">
              <h4>Allow one maintained status comment per admitted issue</h4>
              <p>
                This connection may publish the following template statuses, an
                exact human-approved scope summary, and separately approved
                questions. No chat, source body, private context, issue edits,
                labels or assignments are published. No private workbench link
                is included.
              </p>
              <ul>
                {Object.values(statusLabels).map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
              <h4>Current status preview</h4>
              <MarkdownMessage>{policyPreview.template}</MarkdownMessage>
              <button
                disabled={busy}
                onClick={() =>
                  void perform(
                    () =>
                      setFactoryWriteback(remote.connectionId, {
                        enabled: true,
                        expectedEpoch: policyPreview.epoch,
                        expectedFingerprint: policyPreview.fingerprint,
                      }),
                    () => setPolicyPreview(null),
                  )
                }
              >
                Enable these status updates
              </button>
              <button disabled={busy} onClick={() => setPolicyPreview(null)}>
                Cancel
              </button>
            </div>
          )}
          <p>
            Scope summaries apply only to their approved spec and source
            version. A new draft requires a new public summary approval.
          </p>
          <div className="factory-actions">
            <button
              disabled={busy || !data.policy.enabled || !!draft}
              onClick={() => compose('summary')}
            >
              Review public summary
            </button>
            <button
              disabled={busy || !data.policy.enabled || !!draft}
              onClick={() => compose('question')}
            >
              Ask on GitHub
            </button>
          </div>
          {!draft &&
            detail.revisions
              .at(-1)!
              .spec.decisions.filter((d) => !d.answer)
              .map((d) => (
                <button
                  key={d.id}
                  disabled={busy || !data.policy.enabled}
                  onClick={() => compose('question', d.question, d.id)}
                >
                  Draft question: {d.question}
                </button>
              ))}
          {draft && (
            <form
              className="factory-form"
              onSubmit={(event) => {
                event.preventDefault();
                setPreview(true);
              }}
            >
              <fieldset disabled={busy}>
                <legend>
                  {draft.kind === 'question'
                    ? 'Exact question for GitHub'
                    : 'Public scope summary'}{' '}
                  · spec v{draft.specVersion}
                </legend>
                {draft.expectedVersion !== detail.work.version && (
                  <p role="alert">
                    Task changed. Your text is retained. Review the latest
                    brief, then explicitly rebind this draft before approving.
                  </p>
                )}
                <label>
                  {draft.kind === 'question' ? 'Question text' : 'Summary text'}
                  <textarea
                    required
                    maxLength={8000}
                    value={draft.body}
                    onChange={(e) => {
                      setDraft({
                        ...draft,
                        body: e.target.value,
                        requestKey: crypto.randomUUID(),
                      });
                      setPreview(false);
                    }}
                  />
                </label>
                <button disabled={!draft.body.trim()}>
                  Preview exact publication
                </button>
                {draft.expectedVersion !== detail.work.version && (
                  <button
                    type="button"
                    onClick={() =>
                      compose(draft.kind, draft.body, draft.decisionId)
                    }
                  >
                    Use current version after review
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setDraft(null);
                    setPreview(false);
                  }}
                >
                  Cancel draft
                </button>
                {preview && (
                  <div className="factory-writeback-preview">
                    <h4>
                      {draft.kind === 'question'
                        ? 'Question to send'
                        : 'Summary to approve'}{' '}
                      on issue #{remote.number}
                    </h4>
                    <MarkdownMessage>{draft.body}</MarkdownMessage>
                    <p>
                      {draft.kind === 'question'
                        ? 'Send exactly this text as a new comment, with an invisible ownership marker. Replies remain untrusted context; they cannot release work.'
                        : 'Allow exactly this summary in the maintained status comment. This does not publish the rest of the draft.'}
                    </p>
                    <button
                      type="button"
                      disabled={
                        !data.policy.enabled ||
                        draft.expectedVersion !== detail.work.version
                      }
                      onClick={() =>
                        void perform(
                          () => approveFactoryWriteback(detail.work.id, draft),
                          () => {
                            setDraft(null);
                            setPreview(false);
                          },
                        )
                      }
                    >
                      {draft.kind === 'question'
                        ? 'Send this question to GitHub'
                        : `Approve public summary for v${draft.specVersion}`}
                    </button>
                  </div>
                )}
              </fieldset>
            </form>
          )}
          <h4>Publishing health</h4>
          {data.status?.relinquished && (
            <p>
              Management relinquished. Neon will not overwrite or recreate this
              status comment.
            </p>
          )}
          {!data.effects.length && (
            <p>
              {data.policy.enabled
                ? 'Status will be prepared by the next recovery pass.'
                : 'No outbound effects authorized.'}
            </p>
          )}
          {data.effects
            .slice(-12)
            .reverse()
            .map((effect) => (
              <article key={effect.id} className="factory-writeback-effect">
                <p>
                  <strong>
                    {effect.kind === 'question' ? 'Question' : 'Status'} ·{' '}
                    {effect.state === 'uncertain'
                      ? 'Sync uncertain'
                      : effect.state}
                  </strong>
                  {effect.remoteId && (
                    <>
                      {' '}
                      ·{' '}
                      <a
                        href={`${remote.url}#issuecomment-${effect.remoteId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Comment #{effect.remoteId}
                      </a>
                    </>
                  )}
                </p>
                {effect.error && <p>{effect.error}</p>}
                {effect.retryAt > 0 && (
                  <p>
                    Next eligible check:{' '}
                    {new Date(effect.retryAt).toLocaleString()}
                  </p>
                )}
                <details>
                  <summary>Authorized content and receipt</summary>
                  <MarkdownMessage>{effect.body}</MarkdownMessage>
                  <p>
                    Spec v{effect.specVersion} · {effect.createdAt}
                  </p>
                </details>
                {['failed', 'uncertain'].includes(effect.state) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        recoverFactoryWriteback(
                          detail.work.id,
                          effect.id,
                          'retry',
                        ),
                      )
                    }
                  >
                    {effect.state === 'uncertain'
                      ? 'Recheck receipt (read only)'
                      : 'Retry authorized send'}
                  </button>
                )}
                {effect.state === 'repair' && effect.kind === 'status' && (
                  <button
                    disabled={busy || !data.policy.enabled}
                    onClick={() =>
                      void perform(async () =>
                        setRepair(
                          await previewFactoryWritebackRepair(
                            detail.work.id,
                            effect.id,
                          ),
                        ),
                      )
                    }
                  >
                    Review remote comment repair
                  </button>
                )}
                {['failed', 'uncertain', 'repair'].includes(effect.state) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform(() =>
                        recoverFactoryWriteback(
                          detail.work.id,
                          effect.id,
                          'relinquish',
                        ),
                      )
                    }
                  >
                    Relinquish{' '}
                    {effect.kind === 'status'
                      ? 'status management'
                      : 'question reconciliation'}
                  </button>
                )}
              </article>
            ))}
          {repair && (
            <div className="factory-writeback-preview">
              <h4>
                {repair.observed
                  ? 'Replace the remotely edited status comment'
                  : 'Recreate the confirmed missing status comment'}
              </h4>
              {repair.observed && (
                <>
                  <h5>Current remote content</h5>
                  <MarkdownMessage>{repair.observed.body}</MarkdownMessage>
                </>
              )}
              <h5>Exact replacement</h5>
              <MarkdownMessage>{repair.replacement}</MarkdownMessage>
              <p>
                GitHub offers no documented conditional replacement guarantee.
                Neon checks this remote revision again immediately before
                writing; another remote edit can still race that request.
              </p>
              <button
                disabled={busy || !data.policy.enabled}
                onClick={() =>
                  void perform(
                    () =>
                      approveFactoryWritebackRepair(
                        detail.work.id,
                        repair.id,
                        repair.replacement,
                      ),
                    () => setRepair(null),
                  )
                }
              >
                Approve this repair
              </button>
              <button disabled={busy} onClick={() => setRepair(null)}>
                Cancel repair
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
