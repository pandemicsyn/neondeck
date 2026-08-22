import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  GitHubPrReviewDraft,
  GitHubPrReviewDraftComment,
  PrReviewRecord,
  PrReviewReportOnlyFinding,
} from '../../api';
import { MarkdownMessage } from '../../components/MarkdownMessage';
import { queryErrorMessage } from '../../lib/query';
import { prReviewDraftQueryOptions, useGitHubPrReviewDraft } from './queries';
import {
  isReportOnlyFindingDrafted,
  reportOnlyFindingBody,
} from './PrReviewFindingsSidebar';
import {
  usePrReviewBriefingActions,
  type PrReviewBriefingActions,
} from './usePrReviewBriefingActions';

type Severity = 'critical' | 'major' | 'minor' | 'nit';

export function PrReviewBriefingOverlay({
  onClose,
  onReviewChange,
  review,
}: {
  onClose: () => void;
  onReviewChange?: (review: PrReviewRecord) => void;
  review: PrReviewRecord;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const draftQuery = useGitHubPrReviewDraft(
    {
      repo: review.repoFullName,
      number: review.prNumber,
    },
    prReviewDraftQueryOptions(review),
  );
  const actions = usePrReviewBriefingActions(review, draftQuery, {
    onReviewChange,
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  if (!review.briefingOverview) return null;
  return createPortal(
    <dialog
      aria-label={`Review briefing for ${review.repoFullName}#${review.prNumber}`}
      className="fixed inset-0 z-[100] m-0 flex h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-black/80 p-2 sm:p-5"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <section className="h-[min(92vh,980px)] w-[min(96vw,1440px)] border border-line bg-panel">
        <PrReviewBriefing
          actions={actions}
          draft={draftQuery.data}
          draftError={draftQuery.error}
          draftLoading={draftQuery.isLoading}
          onClose={onClose}
          review={review}
        />
      </section>
    </dialog>,
    document.body,
  );
}

export function PrReviewBriefing({
  actions,
  draft,
  draftError,
  draftLoading = false,
  onClose,
  review,
}: {
  actions?: PrReviewBriefingActions;
  draft: GitHubPrReviewDraft | null | undefined;
  draftError?: unknown;
  draftLoading?: boolean;
  onClose?: () => void;
  review: PrReviewRecord;
}) {
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('blockers');
  const [approvalNote, setApprovalNote] = useState(draft?.body ?? '');
  const [approvalNoteTouched, setApprovalNoteTouched] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const overview = review.briefingOverview;
  useEffect(() => {
    if (!approvalNoteTouched) setApprovalNote(draft?.body ?? '');
  }, [approvalNoteTouched, draft?.body, draft?.id]);
  if (!overview) return null;
  const needsHuman = overview.recommendation === 'needs-human';
  const draftKnown =
    !draftLoading && (draftError === undefined || draftError === null);
  const comments = draftKnown ? (draft?.comments ?? []) : [];
  const noteOnlyFindings = draftKnown
    ? review.reportOnlyFindings.filter(
        (finding) => !isReportOnlyFindingDrafted(draft ?? null, finding),
      )
    : review.reportOnlyFindings;
  const activeFilter = needsHuman ? queueFilter : 'all';
  const visibleItems = reviewQueueItems(
    comments,
    noteOnlyFindings,
    activeFilter,
    review.reportOnlyFindings,
  );
  const blockers = draftKnown
    ? reviewQueueItems(
        comments,
        noteOnlyFindings,
        'all',
        review.reportOnlyFindings,
      ).filter((item) => isBlocker(item.severity)).length
    : null;
  const submitted = review.status === 'submitted';
  const submitting = review.status === 'submitting';
  const rejectedCommentCount = Math.min(
    actions?.rejectedCommentCount ?? 0,
    comments.length,
  );
  const submittedCommentCount = comments.length - rejectedCommentCount;
  const commentPayload = `${submittedCommentCount} comment${submittedCommentCount === 1 ? '' : 's'}`;
  const rejectedCommentWarning = rejectedCommentCount
    ? ` · ${rejectedCommentCount} rejected draft${rejectedCommentCount === 1 ? '' : 's'} omitted until edited`
    : '';
  const payloadLabel = approvalNote.trim()
    ? `note + ${commentPayload}${rejectedCommentWarning}`
    : `${commentPayload}${rejectedCommentWarning}`;
  const archived = review.archivedAt !== null;
  const actionable =
    Boolean(actions) &&
    draftKnown &&
    !archived &&
    review.status === 'ready' &&
    (!draft || (draft.status === 'draft' && draft.headSha === review.headSha));
  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(queryErrorMessage(error));
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
      <header className="flex min-h-14 shrink-0 items-start justify-between gap-4 border-b border-line bg-panel px-4 py-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-[0.14em] text-primary">
            REVIEW BRIEFING · {review.repoFullName}#{review.prNumber} ·{' '}
            {review.headSha.slice(0, 8)}
          </p>
          <h1 className="mt-1 truncate font-display text-[17px] font-semibold">
            {review.title}
          </h1>
        </div>
        <nav className="flex shrink-0 flex-wrap justify-end gap-1.5 font-mono text-[10px]">
          <button
            className="border border-line px-2 py-1.5 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            onClick={() =>
              window.open(
                `/review-briefing?id=${encodeURIComponent(review.id)}`,
                `neondeck-review-briefing-${review.id}`,
                'popup,width=1440,height=920',
              )
            }
            type="button"
          >
            pop out
          </button>
          <a
            className="border border-line px-2 py-1.5 text-muted hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
            href={review.reviewUrl}
            rel="noreferrer"
            target="_blank"
          >
            workbench
          </a>
          {onClose ? (
            <button
              className="border border-primary px-2 py-1.5 text-primary focus:outline-none focus:ring-1 focus:ring-primary"
              onClick={onClose}
              type="button"
            >
              close
            </button>
          ) : null}
        </nav>
      </header>

      <section
        className={
          needsHuman
            ? 'shrink-0 border-b border-accent bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] px-4 py-3'
            : 'shrink-0 border-b border-primary bg-[color-mix(in_srgb,var(--primary)_7%,var(--panel))] px-4 py-3'
        }
      >
        <div className="flex items-start gap-3">
          <span
            className={
              needsHuman
                ? 'border border-accent px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-accent'
                : 'border border-primary px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-primary'
            }
          >
            {submitted
              ? `submitted · ${review.verdict ?? 'review'}`
              : submitting
                ? 'submitting to GitHub'
                : needsHuman
                  ? 'needs human review'
                  : 'approve'}
          </span>
          <p className="max-w-[90ch] text-[12px] leading-5">
            {overview.recommendationReason}
          </p>
          {submitted && review.githubReviewUrl ? (
            <a
              className="ml-auto shrink-0 border border-primary px-2 py-1 font-mono text-[10px] text-primary hover:underline"
              href={review.githubReviewUrl}
              rel="noreferrer"
              target="_blank"
            >
              view GitHub receipt
            </a>
          ) : null}
        </div>
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_340px] xl:overflow-hidden">
        <main className="min-h-0 px-4 py-4 xl:overflow-y-auto xl:px-6">
          <SectionLabel>
            {needsHuman ? 'What makes this hard' : 'Why this is safe'}
          </SectionLabel>
          <MarkdownMessage className="mt-2 max-w-[90ch] text-[13px] leading-6">
            {overview.summary}
          </MarkdownMessage>

          <div className="mt-6 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-2">
            <div>
              <SectionLabel>
                {needsHuman ? 'Blockers first' : 'Review queue'}
              </SectionLabel>
              <p className="mt-1 text-[11px] text-muted">
                {draftKnown ? comments.length : '—'} live draft
                {draftKnown && comments.length === 1 ? '' : 's'} ·{' '}
                {noteOnlyFindings.length} note-only
              </p>
            </div>
            <span className="font-mono text-[10px] text-muted">
              {draftLoading
                ? 'syncing local draft…'
                : draftError
                  ? `draft unavailable: ${queryErrorMessage(draftError)}`
                  : draft
                    ? `${draft.status} · revision ${draft.revision}`
                    : 'no local draft'}
            </span>
          </div>

          {needsHuman ? (
            <fieldset
              aria-label="Review queue filter"
              className="mt-3 flex flex-wrap gap-1 font-mono text-[10px]"
            >
              {(['blockers', 'worth', 'all'] as const).map((filter) => (
                <button
                  aria-pressed={queueFilter === filter}
                  className={
                    queueFilter === filter
                      ? 'border border-primary bg-primary px-2 py-1 text-primary-ink'
                      : 'border border-line px-2 py-1 text-muted hover:border-primary hover:text-primary'
                  }
                  key={filter}
                  onClick={() => setQueueFilter(filter)}
                  type="button"
                >
                  {filter === 'worth'
                    ? 'worth a look'
                    : filter === 'all'
                      ? 'everything'
                      : 'blockers'}
                </button>
              ))}
            </fieldset>
          ) : null}

          {draft && draft.headSha !== review.headSha ? (
            <p className="mt-3 border border-accent px-3 py-2 font-mono text-[10px] text-accent">
              The live draft belongs to {draft.headSha.slice(0, 8)}; this
              briefing was generated for {review.headSha.slice(0, 8)}.
            </p>
          ) : null}

          {archived ? (
            <p className="mt-3 border border-accent px-3 py-2 font-mono text-[10px] text-accent">
              This review is archived. Restore it from the review queue before
              changing its draft or submitting an approval.
            </p>
          ) : null}

          <div className="mt-3 space-y-2">
            {visibleItems.map((item) =>
              item.kind === 'comment' ? (
                <DraftCommentCard
                  actions={actionable ? actions : undefined}
                  compact={!needsHuman}
                  comment={item.comment}
                  defaultExpanded={needsHuman && isBlocker(item.severity)}
                  key={`comment:${item.comment.id}`}
                  review={review}
                  severity={item.severity}
                  summary={item.summary}
                />
              ) : (
                <ReportOnlyFindingCard
                  actions={actionable ? actions : undefined}
                  compact={!needsHuman}
                  defaultExpanded={needsHuman && isBlocker(item.severity)}
                  finding={item.finding}
                  key={`finding:${item.key}`}
                  review={review}
                />
              ),
            )}
            {draftKnown && visibleItems.length === 0 ? (
              <div className="border border-line bg-panel px-4 py-5 text-[12px] text-muted">
                {needsHuman && activeFilter !== 'all'
                  ? 'No findings match this filter. Broaden the queue to inspect the remaining context.'
                  : 'No findings are queued. Validate the change map and risk notes before acting on the recommendation.'}
              </div>
            ) : null}
          </div>

          <div className="mt-7">
            <SectionLabel>Change map</SectionLabel>
            <div className="mt-2 divide-y divide-line border border-line bg-panel">
              {overview.changeMap.map((item) => (
                <article
                  className="grid gap-1 px-3 py-2.5 sm:grid-cols-[minmax(180px,0.42fr)_1fr]"
                  key={item.path}
                >
                  <code className="truncate text-[10px] text-primary">
                    {item.path}
                  </code>
                  <div>
                    <p className="text-[11px] leading-4">{item.summary}</p>
                    {item.risk ? (
                      <p className="mt-1 text-[10px] leading-4 text-muted">
                        Risk: {item.risk}
                      </p>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </main>

        <aside className="border-t border-line bg-panel px-4 py-4 xl:min-h-0 xl:overflow-y-auto xl:border-t-0 xl:border-l">
          <SectionLabel>
            {needsHuman ? 'Why I’m escalating' : 'Double-check this'}
          </SectionLabel>
          <div className="mt-3 space-y-2">
            {overview.risks.length > 0 ? (
              overview.risks.map((risk, index) => (
                <div
                  className="border-l-2 border-accent bg-soft px-3 py-2 text-[11px] leading-5"
                  key={`${index}:${risk}`}
                >
                  {risk}
                </div>
              ))
            ) : (
              <p className="border border-line px-3 py-3 text-[11px] leading-5 text-muted">
                No specific risks were recorded. That is context, not proof of
                safety.
              </p>
            )}
          </div>
          <dl className="mt-6 grid grid-cols-2 gap-px border border-line bg-line font-mono text-[10px]">
            <Metric
              label="active"
              value={
                draftKnown ? comments.length + noteOnlyFindings.length : '—'
              }
            />
            <Metric label="blockers" value={blockers ?? '—'} />
            <Metric label="drafts" value={draftKnown ? comments.length : '—'} />
            <Metric label="note-only" value={noteOnlyFindings.length} />
          </dl>
          <div className="mt-6 border border-line bg-canvas p-3">
            <SectionLabel>Trust boundary</SectionLabel>
            <p className="mt-2 text-[10px] leading-4 text-muted">
              {review.trustBoundary}
            </p>
          </div>
          {actions && !submitted && !submitting && !needsHuman ? (
            <div className="mt-6 border border-line bg-canvas p-3">
              <SectionLabel>Approval note</SectionLabel>
              <p className="mt-2 text-[10px] leading-4 text-muted">
                Optional GitHub review body. Written by you; Neon does not draft
                this note.
              </p>
              <textarea
                aria-label="Approval note"
                className="mt-3 min-h-24 w-full resize-y border border-line bg-panel px-2.5 py-2 text-[11px] leading-5 text-ink outline-none focus:border-primary"
                disabled={!actionable || actions.busy}
                onChange={(event) => {
                  setApprovalNoteTouched(true);
                  setApprovalNote(event.target.value);
                }}
                placeholder="Optional note posted with your GitHub approval"
                value={approvalNote}
              />
              <p className="mt-2 text-[10px] leading-4 text-muted">
                Submits one Approve review on {review.repoFullName}#
                {review.prNumber} with {payloadLabel}, as you. Nothing is sent
                until you press this button.
              </p>
              <button
                className="mt-3 w-full border border-primary bg-primary px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-primary-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!actionable || actions.busy}
                onClick={() =>
                  void runAction(() => actions.submitApproval(approvalNote))
                }
                type="button"
              >
                {actions.submitting
                  ? 'submitting…'
                  : actions.busy
                    ? 'draft update in progress…'
                    : `approve & submit ${payloadLabel}`}
              </button>
              {!actionable ? (
                <p className="mt-2 font-mono text-[10px] leading-4 text-muted">
                  {archived
                    ? 'Restore this review from the queue before submitting.'
                    : 'Refresh the live draft and confirm the reviewed head before submitting.'}
                </p>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      {actions && needsHuman && overrideOpen && !submitted && !submitting ? (
        <section className="flex shrink-0 flex-wrap items-start gap-3 border-t border-accent bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel))] px-4 py-3">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
            Hold on
          </span>
          <div className="min-w-[240px] flex-1">
            <p className="text-[12px] leading-5">
              You are overriding a needs-human recommendation. Approving submits{' '}
              {payloadLabel} on {review.repoFullName}#{review.prNumber} as you.
            </p>
            <label className="mt-2 block border border-line bg-field px-2.5 py-2">
              <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted">
                Note with your approval · optional · posts as the review body
              </span>
              <textarea
                aria-label="Approval note"
                className="mt-1 min-h-12 w-full resize-y bg-transparent text-[11px] leading-5 text-ink outline-none"
                disabled={!actionable || actions.busy}
                onChange={(event) => {
                  setApprovalNoteTouched(true);
                  setApprovalNote(event.target.value);
                }}
                value={approvalNote}
              />
            </label>
          </div>
          <div className="flex shrink-0 flex-col gap-1.5 font-mono text-[10px]">
            <button
              className="border border-accent px-3 py-2 text-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!actionable || actions.busy}
              onClick={() =>
                void runAction(() => actions.submitApproval(approvalNote))
              }
              type="button"
            >
              {actions.submitting
                ? 'submitting…'
                : actions.busy
                  ? 'draft update in progress…'
                  : `approve anyway & submit ${payloadLabel}`}
            </button>
            <button
              className="border border-line px-3 py-1.5 text-muted hover:border-primary hover:text-primary"
              disabled={actions.busy}
              onClick={() => setOverrideOpen(false)}
              type="button"
            >
              cancel
            </button>
          </div>
        </section>
      ) : null}

      {actionError ? (
        <div
          aria-live="polite"
          className="shrink-0 border-t border-accent bg-[color-mix(in_srgb,var(--accent)_8%,var(--panel))] px-4 py-2 font-mono text-[10px] text-accent"
        >
          {actionError}
        </div>
      ) : null}

      <footer className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-panel px-4 py-2 font-mono text-[10px]">
        <span className={needsHuman ? 'text-accent' : 'text-primary'}>
          {submitted
            ? `Submitted as ${review.verdict ?? 'review'}${review.submittedAt ? ` · ${review.submittedAt}` : ''}`
            : submitting
              ? 'Submitting this review to GitHub…'
              : blockers === null
                ? 'Live draft state is unavailable'
                : needsHuman
                  ? `${blockers} blocker${blockers === 1 ? '' : 's'} ${blockers === 1 ? 'needs' : 'need'} a decision`
                  : 'Briefing ready for your final check'}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-muted">
            {draftKnown ? 'Draft state is live' : 'Draft state is unavailable'}{' '}
            · briefing overview is fixed to this review run
          </span>
          {actions &&
          needsHuman &&
          !archived &&
          !overrideOpen &&
          !submitted &&
          !submitting ? (
            <button
              className="border border-line px-2 py-1.5 text-muted hover:border-accent hover:text-accent"
              onClick={() => setOverrideOpen(true)}
              type="button"
            >
              approve anyway
            </button>
          ) : null}
          {actions && submitting ? (
            <button
              className="border border-accent px-2 py-1.5 text-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={actions.busy}
              onClick={() => void runAction(() => actions.recoverSubmission())}
              type="button"
            >
              {actions.busy ? 'checking GitHub…' : 'recover submission'}
            </button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

function DraftCommentCard({
  actions,
  comment,
  compact,
  defaultExpanded,
  review,
  severity,
  summary,
}: {
  actions?: PrReviewBriefingActions;
  comment: GitHubPrReviewDraftComment;
  compact: boolean;
  defaultExpanded: boolean;
  review: PrReviewRecord;
  severity: Severity | null | undefined;
  summary: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [actionError, setActionError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) setBody(comment.body);
  }, [comment.body, editing]);
  return (
    <article className={cardClass(severity)}>
      <button
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-left font-mono text-[10px]"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          {severity ? (
            <SeverityBadge severity={severity} />
          ) : (
            <span className="border border-line px-1.5 py-0.5 uppercase text-muted">
              comment
            </span>
          )}
          <code className="truncate text-primary">
            {comment.path}:{comment.line}
          </code>
        </span>
        <span className="shrink-0 text-muted">
          draft comment ·{' '}
          {expanded ? 'collapse' : compact ? 'inspect' : 'expand'}
        </span>
      </button>
      <p className="px-3 py-2 text-[11px] font-semibold leading-5">{summary}</p>
      {expanded ? (
        <>
          {editing ? (
            <form
              className="border-t border-line px-3 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                setActionError(null);
                void actions
                  ?.editComment(comment.id, body)
                  .then(() => setEditing(false))
                  .catch((error) => setActionError(queryErrorMessage(error)));
              }}
            >
              <textarea
                aria-label={`Edit draft comment on ${comment.path}`}
                className="min-h-28 w-full resize-y border border-line bg-canvas px-2.5 py-2 text-[11px] leading-5 outline-none focus:border-primary"
                disabled={actions?.busy}
                onChange={(event) => setBody(event.target.value)}
                value={body}
              />
              <div className="mt-2 flex justify-end gap-1.5 font-mono text-[10px]">
                <button
                  className="border border-line px-2 py-1 text-muted"
                  onClick={() => {
                    setBody(comment.body);
                    setEditing(false);
                  }}
                  type="button"
                >
                  cancel
                </button>
                <button
                  className="border border-primary bg-primary px-2 py-1 text-primary-ink disabled:opacity-50"
                  disabled={actions?.busy || !body.trim()}
                  type="submit"
                >
                  save comment
                </button>
              </div>
            </form>
          ) : summary !== comment.body ? (
            <div className="border-t border-line px-3 py-3">
              <MarkdownMessage className="text-[11px] leading-5">
                {comment.body}
              </MarkdownMessage>
            </div>
          ) : null}
          {actionError ? (
            <p
              className="border-t border-accent px-3 py-2 font-mono text-[10px] text-accent"
              role="alert"
            >
              {actionError}
            </p>
          ) : null}
          <CardActions href={diffHref(review, comment.path)}>
            {actions ? (
              <>
                <button
                  className="text-primary hover:underline disabled:opacity-50"
                  disabled={actions.busy}
                  onClick={() => setEditing(true)}
                  type="button"
                >
                  edit comment
                </button>
                <button
                  className="text-accent hover:underline disabled:opacity-50"
                  disabled={actions.busy}
                  onClick={() => {
                    setActionError(null);
                    void actions
                      .dismissComment(comment.id)
                      .catch((error) =>
                        setActionError(queryErrorMessage(error)),
                      );
                  }}
                  type="button"
                >
                  dismiss
                </button>
              </>
            ) : null}
          </CardActions>
        </>
      ) : null}
    </article>
  );
}

function ReportOnlyFindingCard({
  actions,
  compact,
  defaultExpanded,
  finding,
  review,
}: {
  actions?: PrReviewBriefingActions;
  compact: boolean;
  defaultExpanded: boolean;
  finding: PrReviewReportOnlyFinding;
  review: PrReviewRecord;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(reportOnlyFindingBody(finding));
  const [actionError, setActionError] = useState<string | null>(null);
  return (
    <article className={cardClass(finding.severity)}>
      <button
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 border-b border-line px-3 py-2 text-left font-mono text-[10px]"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          <code className="truncate text-primary">
            {finding.path}
            {finding.line ? `:${finding.line}` : ''}
          </code>
        </span>
        <span className="shrink-0 text-muted">
          note-only · {expanded ? 'collapse' : compact ? 'inspect' : 'expand'}
        </span>
      </button>
      <p className="px-3 py-2 text-[11px] font-semibold leading-5">
        {finding.summary}
      </p>
      {expanded ? (
        <>
          <div className="space-y-2 border-t border-line px-3 py-3 text-[11px] leading-5">
            <p>{finding.suggestedFix}</p>
            <p className="font-mono text-[10px] text-muted">
              Not drafted: {finding.reason}
            </p>
          </div>
          {editing ? (
            <form
              className="border-t border-line px-3 py-3"
              onSubmit={(event) => {
                event.preventDefault();
                setActionError(null);
                void actions
                  ?.promoteFinding(finding, body)
                  .then(() => setEditing(false))
                  .catch((error) => setActionError(queryErrorMessage(error)));
              }}
            >
              <textarea
                aria-label={`Draft a comment from note on ${finding.path}`}
                className="min-h-28 w-full resize-y border border-line bg-canvas px-2.5 py-2 text-[11px] leading-5 outline-none focus:border-primary"
                disabled={actions?.busy}
                onChange={(event) => setBody(event.target.value)}
                value={body}
              />
              <div className="mt-2 flex justify-end gap-1.5 font-mono text-[10px]">
                <button
                  className="border border-line px-2 py-1 text-muted"
                  onClick={() => {
                    setBody(reportOnlyFindingBody(finding));
                    setEditing(false);
                  }}
                  type="button"
                >
                  cancel
                </button>
                <button
                  className="border border-primary bg-primary px-2 py-1 text-primary-ink disabled:opacity-50"
                  disabled={actions?.busy || !body.trim()}
                  type="submit"
                >
                  add draft comment
                </button>
              </div>
            </form>
          ) : null}
          {actionError ? (
            <p
              className="border-t border-accent px-3 py-2 font-mono text-[10px] text-accent"
              role="alert"
            >
              {actionError}
            </p>
          ) : null}
          <CardActions href={diffHref(review, finding.path)}>
            {actions && finding.line && finding.side ? (
              <button
                className="text-primary hover:underline disabled:opacity-50"
                disabled={actions.busy}
                onClick={() => {
                  setActionError(null);
                  setEditing(true);
                }}
                type="button"
              >
                draft a comment from this
              </button>
            ) : finding.line === null ? (
              <span className="text-muted">
                file-level note · cannot be drafted
              </span>
            ) : !finding.side ? (
              <span className="text-muted">
                incomplete line anchor · cannot be drafted
              </span>
            ) : null}
          </CardActions>
        </>
      ) : null}
    </article>
  );
}

function CardActions({
  children,
  href,
}: {
  children?: ReactNode;
  href: string;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-3 border-t border-line px-3 py-1.5 font-mono text-[10px]">
      {children}
      <a
        className="text-primary hover:underline"
        href={href}
        rel="noreferrer"
        target="_blank"
      >
        open in diff
      </a>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
      {children}
    </h2>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const className = isBlocker(severity)
    ? 'border-accent text-accent'
    : severity === 'minor'
      ? 'border-primary text-primary'
      : 'border-line text-muted';
  return (
    <span className={`border px-1.5 py-0.5 uppercase ${className}`}>
      {severity}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-panel p-2">
      <dt className="text-muted">{label}</dt>
      <dd className="mt-1 text-[14px] text-ink">{value}</dd>
    </div>
  );
}

function isBlocker(severity: Severity | null | undefined) {
  return severity === 'critical' || severity === 'major';
}

function cardClass(severity: Severity | null | undefined) {
  return `border bg-panel ${isBlocker(severity) ? 'border-accent' : 'border-line'}`;
}

type QueueFilter = 'blockers' | 'worth' | 'all';

type ReviewQueueItem =
  | {
      kind: 'comment';
      key: string;
      severity: Severity | null | undefined;
      summary: string;
      comment: GitHubPrReviewDraftComment;
    }
  | {
      kind: 'finding';
      key: string;
      severity: Severity;
      finding: PrReviewReportOnlyFinding;
    };

function reviewQueueItems(
  comments: GitHubPrReviewDraftComment[],
  findings: PrReviewReportOnlyFinding[],
  filter: QueueFilter,
  sourceFindings: PrReviewReportOnlyFinding[] = findings,
) {
  const items: ReviewQueueItem[] = [
    ...comments.map((comment) => {
      const promotedFinding = promotedFindingForComment(
        comment,
        sourceFindings,
      );
      return {
        kind: 'comment' as const,
        key: comment.id,
        severity: comment.neonSeverity ?? promotedFinding?.severity,
        summary:
          comment.neonSummary ?? promotedFinding?.summary ?? comment.body,
        comment,
      };
    }),
    ...findings.map((finding) => ({
      kind: 'finding' as const,
      key:
        finding.sourceId ??
        `${finding.path}:${finding.line}:${finding.summary}`,
      severity: finding.severity,
      finding,
    })),
  ];
  return items
    .filter((item) => severityMatchesFilter(item.severity, filter))
    .sort(
      (left, right) =>
        severityRank(left.severity) - severityRank(right.severity),
    );
}

function promotedFindingForComment(
  comment: GitHubPrReviewDraftComment,
  findings: PrReviewReportOnlyFinding[],
) {
  return findings.find((finding) => {
    if (finding.sourceId && comment.sourceFindingId === finding.sourceId) {
      return true;
    }
    return (
      !comment.sourceFindingId &&
      comment.path === finding.path &&
      comment.body === reportOnlyFindingBody(finding)
    );
  });
}

function severityMatchesFilter(
  severity: Severity | null | undefined,
  filter: QueueFilter,
) {
  if (filter === 'all') return true;
  if (filter === 'blockers') return isBlocker(severity);
  return severity === 'minor' || isBlocker(severity);
}

function severityRank(severity: Severity | null | undefined) {
  return severity === 'critical'
    ? 0
    : severity === 'major'
      ? 1
      : severity === 'minor'
        ? 2
        : severity === 'nit'
          ? 3
          : 4;
}

function diffHref(review: PrReviewRecord, path: string) {
  return `${review.reviewUrl}&path=${encodeURIComponent(path)}`;
}
