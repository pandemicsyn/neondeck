import { BriefingNarrative } from '../../components/BriefingNarrative';
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
import { reviewRecommendationLabel } from './review-ui-helpers';

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
  const [approvalNoteOpen, setApprovalNoteOpen] = useState(
    Boolean(draft?.body?.trim()),
  );
  const [approvalNoteTouched, setApprovalNoteTouched] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const approvalNoteRef = useRef<HTMLTextAreaElement>(null);
  const focusApprovalNoteOnOpenRef = useRef(false);
  const initialQueueCountsRef = useRef<{
    reviewRunKey: string;
    counts: Record<QueueFilter, number>;
  } | null>(null);
  const overview = review.briefingOverview;
  useEffect(() => {
    if (!approvalNoteTouched) {
      setApprovalNote(draft?.body ?? '');
      if (draft?.body?.trim()) setApprovalNoteOpen(true);
    }
  }, [approvalNoteTouched, draft?.body, draft?.id]);
  useEffect(() => {
    if (!approvalNoteOpen || !focusApprovalNoteOnOpenRef.current) return;
    focusApprovalNoteOnOpenRef.current = false;
    approvalNoteRef.current?.focus();
  }, [approvalNoteOpen]);
  if (!overview) return null;
  const needsHuman = overview.recommendation === 'needs-human';
  const submissionDraftUnavailable =
    (review.status === 'submitting' || review.status === 'submitted') &&
    !review.submissionDraftId;
  const draftKnown =
    !submissionDraftUnavailable &&
    !draftLoading &&
    (draftError === undefined || draftError === null);
  const comments = draftKnown ? (draft?.comments ?? []) : [];
  const noteOnlyFindings = draftKnown
    ? review.reportOnlyFindings.filter(
        (finding) => !isReportOnlyFindingDrafted(draft ?? null, finding),
      )
    : review.reportOnlyFindings;
  const allItems = reviewQueueItems(
    comments,
    noteOnlyFindings,
    'all',
    review.reportOnlyFindings,
  );
  const activeFilter = needsHuman ? queueFilter : 'all';
  const visibleItems = allItems.filter((item) =>
    severityMatchesFilter(item.severity, activeFilter),
  );
  const filterCounts = {
    blockers: allItems.filter((item) =>
      severityMatchesFilter(item.severity, 'blockers'),
    ).length,
    worth: allItems.filter((item) =>
      severityMatchesFilter(item.severity, 'worth'),
    ).length,
    all: allItems.length,
  };
  const blockers = draftKnown ? filterCounts.blockers : null;
  const reviewRunKey = `${review.id}:${review.headSha}:${review.readyAt ?? ''}`;
  if (
    draftKnown &&
    initialQueueCountsRef.current?.reviewRunKey !== reviewRunKey
  ) {
    initialQueueCountsRef.current = {
      reviewRunKey,
      counts: {
        ...filterCounts,
        all: Math.max(review.findingCount, filterCounts.all),
      },
    };
  }
  const activeQueueTotal = draftKnown
    ? (initialQueueCountsRef.current?.counts[activeFilter] ??
      filterCounts[activeFilter])
    : null;
  const activeQueueCleared =
    activeQueueTotal === null
      ? null
      : Math.max(0, activeQueueTotal - filterCounts[activeFilter]);
  const submitted = review.status === 'submitted';
  const submitting = review.status === 'submitting';
  const rejectedCommentCount = Math.min(
    actions?.rejectedCommentCount ?? 0,
    comments.length,
  );
  const submittedCommentCount = comments.length - rejectedCommentCount;
  const commentPayload =
    submittedCommentCount === 0
      ? 'no comments'
      : `${submittedCommentCount} comment${submittedCommentCount === 1 ? '' : 's'}`;
  const rejectedCommentWarning = rejectedCommentCount
    ? ` · ${rejectedCommentCount} rejected draft${rejectedCommentCount === 1 ? '' : 's'} omitted until edited`
    : '';
  const payloadLabel = approvalNote.trim()
    ? `note + ${commentPayload}${rejectedCommentWarning}`
    : `${commentPayload}${rejectedCommentWarning}`;
  const approvalActionLabel =
    !approvalNote.trim() && submittedCommentCount === 0
      ? `Approve${rejectedCommentWarning}`
      : `Approve & submit ${payloadLabel}`;
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
              ? reviewRecommendationLabel(review)
              : submitting
                ? 'submitting to GitHub'
                : reviewRecommendationLabel(review)}
          </span>
          <p className="max-w-[90ch] text-[12px] leading-5">
            {submitted
              ? `Submitted at ${formatReviewTime(review.submittedAt)} as one review: ${review.verdict ?? 'review'}${draftKnown ? `, ${payloadLabel} attached` : ''}. This briefing is now a receipt.`
              : overview.recommendationReason}
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
          ) : !submitted ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">
              reviewed {review.headSha.slice(0, 8)} ·{' '}
              {formatReviewTime(review.readyAt)}
            </span>
          ) : null}
        </div>
      </section>

      {needsHuman ? (
        <section className="flex shrink-0 flex-wrap items-stretch justify-between gap-x-4 border-b border-line bg-panel">
          <p className="flex items-center px-4 py-2 font-mono text-[11px] text-muted">
            {draftKnown ? allItems.length : '—'} findings · {blockers ?? '—'} of
            them blockers · {draftKnown ? comments.length : '—'} drafted as
            comments
          </p>
          <fieldset
            aria-label="Review queue filter"
            className="flex items-stretch border-l border-line font-mono text-[11px]"
          >
            {(['blockers', 'worth', 'all'] as const).map((filter) => (
              <button
                aria-pressed={queueFilter === filter}
                className={
                  queueFilter === filter
                    ? 'border-r border-line bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-3.5 py-2 text-accent shadow-[inset_0_-2px_0_var(--accent)]'
                    : 'border-r border-line px-3.5 py-2 text-muted hover:text-ink'
                }
                key={filter}
                onClick={() => setQueueFilter(filter)}
                type="button"
              >
                {filter === 'worth'
                  ? 'WORTH A LOOK'
                  : filter === 'all'
                    ? 'EVERYTHING'
                    : 'BLOCKERS'}{' '}
                <span className="ml-1 text-ink">{filterCounts[filter]}</span>
              </button>
            ))}
          </fieldset>
        </section>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_340px] xl:overflow-hidden">
        <main className="min-h-0 px-5 py-5 xl:overflow-y-auto xl:px-[30px] xl:py-[26px]">
          <SectionLabel>
            {needsHuman ? 'What makes this hard' : 'Why I think this is safe'}
          </SectionLabel>
          <BriefingNarrative>{overview.summary}</BriefingNarrative>
          <div className="mt-5 flex flex-wrap items-center gap-2 font-mono text-[10px]">
            {needsHuman ? (
              <>
                <a
                  className="inline-flex min-h-8 items-center border border-primary px-3 py-1.5 font-semibold text-primary no-underline hover:bg-soft focus:outline-none focus:ring-1 focus:ring-primary"
                  href={review.prUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open PR
                </a>
                <span className="text-muted">
                  open · base {review.baseRef} · head{' '}
                  {review.headSha.slice(0, 7)}
                  {review.author ? ` · author ${review.author}` : ''}
                </span>
              </>
            ) : (
              <a
                className="inline-flex min-h-8 items-center border border-primary px-3 py-1.5 font-semibold text-primary no-underline hover:bg-soft focus:outline-none focus:ring-1 focus:ring-primary"
                href={review.reviewUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open in the workbench
              </a>
            )}
            {!needsHuman ? (
              <a
                className="inline-flex min-h-8 items-center border border-line px-3 py-1.5 text-muted no-underline hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                href={review.prUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open PR on GitHub
              </a>
            ) : null}
          </div>

          <div className="mt-[30px] flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line pt-5">
            <SectionLabel>
              {needsHuman ? 'Start here' : 'Riding along'}
            </SectionLabel>
            <p className="text-[11px] text-muted">
              {needsHuman
                ? queueFilter === 'blockers'
                  ? 'the findings behind the verdict'
                  : 'sorted by what blocks you, not by file order'
                : "these submit with the approval — dismiss any you don't want sent"}
            </p>
            <span className="ml-auto font-mono text-[10px] tabular-nums text-muted">
              {draftLoading
                ? 'syncing local draft…'
                : draftError
                  ? `draft unavailable: ${queryErrorMessage(draftError)}`
                  : needsHuman
                    ? `${activeQueueCleared} of ${activeQueueTotal} cleared`
                    : `${submittedCommentCount} of ${comments.length} will be sent`}
            </span>
          </div>

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

          <div className="mt-3 space-y-2.5">
            {visibleItems.map((item) =>
              item.kind === 'comment' ? (
                <DraftCommentCard
                  actions={actionable ? actions : undefined}
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
                  : needsHuman
                    ? 'No findings are queued. Open the workbench to resolve why this review still needs a human.'
                    : 'Nothing to triage. The approval button below is the whole job.'}
              </div>
            ) : null}
          </div>
        </main>

        <aside className="border-t border-line bg-panel xl:min-h-0 xl:overflow-y-auto xl:border-t-0 xl:border-l">
          <div className="border-b border-line px-4 py-3.5">
            <p
              className={`font-mono text-[10px] font-semibold tracking-[0.12em] ${needsHuman ? 'text-accent' : 'text-primary'}`}
            >
              {needsHuman ? "WHY I'M ESCALATING" : 'NOTHING HERE NEEDS YOU'}
            </p>
            <p className="mt-1 text-[11.5px] leading-[1.5] text-muted">
              {needsHuman
                ? overview.risks.length === 1
                  ? 'This is the reason for the verdict. Settle it, then choose in the workbench.'
                  : 'These are the reasons for the verdict. Settle them, then choose in the workbench.'
                : overview.risks.length
                  ? 'One thing to glance at if you have a minute. Otherwise the button below is the whole job.'
                  : 'There is nothing else to triage. The button below is the whole job.'}
            </p>
          </div>
          <div className="px-4 py-3.5">
            <div className="flex items-center gap-2 font-mono text-[9px] tracking-[0.12em] text-muted">
              <span
                className={`h-[5px] w-[5px] ${needsHuman ? 'bg-accent' : 'bg-primary'}`}
              />
              <span>
                {needsHuman
                  ? 'RISKS I COULD NOT SETTLE'
                  : 'IF YOU WANT TO DOUBLE-CHECK ONE THING'}
              </span>
              <span className="ml-auto tabular-nums">
                {overview.risks.length}
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {overview.risks.length > 0 ? (
                overview.risks.map((risk, index) => (
                  <div
                    className="border-l-2 border-accent px-3 py-0.5 text-[12.5px] leading-[1.55]"
                    key={`${index}:${risk}`}
                  >
                    {risk}
                  </div>
                ))
              ) : (
                <p className="text-[11px] leading-5 text-muted">
                  No specific risks were recorded.
                </p>
              )}
            </div>
            <div className="mt-5 border-t border-line pt-4">
              <SectionLabel>Got a question?</SectionLabel>
              <p className="mt-2 text-[12.5px] leading-[1.55] text-muted">
                The workbench has the full diff and the review chat. Asking
                there keeps the answer next to the code it is about.
              </p>
              <a
                className="mt-3 inline-flex min-h-8 items-center border border-line px-2.5 py-1.5 font-mono text-[10px] text-ink no-underline hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                href={review.reviewUrl}
                rel="noreferrer"
                target="_blank"
              >
                Ask Neon in the workbench →
              </a>
            </div>
          </div>
        </aside>
      </div>

      {actions && !submitted && !submitting && !needsHuman ? (
        approvalNoteOpen ? (
          <section className="shrink-0 border-t border-line bg-panel px-4 py-3">
            <div className="flex items-center gap-3">
              <label
                className="font-mono text-[9px] tracking-[0.08em] text-muted"
                htmlFor="pr-review-approval-note"
              >
                NOTE WITH YOUR APPROVAL · POSTS AS THE REVIEW BODY, ABOVE THE
                COMMENTS
              </label>
              <button
                className={`${cardActionClass} ml-auto shrink-0`}
                disabled={actions.busy}
                onClick={() => {
                  setApprovalNoteTouched(true);
                  setApprovalNote('');
                  setApprovalNoteOpen(false);
                }}
                type="button"
              >
                remove note
              </button>
            </div>
            <textarea
              aria-label="Approval note"
              className="mt-2 min-h-11 w-full resize-y border border-primary bg-field px-3 py-2 text-[13.5px] leading-[1.6] text-ink outline-none"
              disabled={!actionable || actions.busy}
              id="pr-review-approval-note"
              onChange={(event) => {
                setApprovalNoteTouched(true);
                setApprovalNote(event.target.value);
              }}
              ref={approvalNoteRef}
              value={approvalNote}
            />
          </section>
        ) : (
          <div className="shrink-0 border-t border-line bg-panel px-4 py-2.5">
            <button
              className={`${cardActionClass} border-dashed`}
              disabled={actions.busy}
              onClick={() => {
                focusApprovalNoteOnOpenRef.current = true;
                setApprovalNoteOpen(true);
              }}
              type="button"
            >
              + add a note with your approval
            </button>
          </div>
        )
      ) : null}

      {actions && needsHuman && overrideOpen && !submitted && !submitting ? (
        <section className="flex shrink-0 flex-wrap items-start gap-3 border-t border-accent bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel))] px-4 py-3">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent">
            Hold on
          </span>
          <div className="min-w-[240px] flex-1">
            <p className="text-[12px] leading-5">
              You are overriding a needs-human recommendation. Approving submits{' '}
              {payloadLabel} on {review.repoFullName}#{review.prNumber} as you.{' '}
              Nothing is sent until you press the submit button.
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
        <div className="flex min-w-0 items-center gap-3">
          {needsHuman &&
          !submitted &&
          !submitting &&
          activeQueueTotal !== null &&
          activeQueueCleared !== null ? (
            <div className="h-[3px] w-[140px] bg-line">
              <div
                className="h-full bg-accent transition-[width] duration-200 ease-out"
                style={{
                  width: `${activeQueueTotal ? (activeQueueCleared / activeQueueTotal) * 100 : 0}%`,
                }}
              />
            </div>
          ) : null}
          <span className="max-w-[78ch] leading-[1.6] text-muted">
            {submitted
              ? 'Review submitted. A GitHub review cannot be withdrawn from here — follow-up happens on the PR.'
              : submitting
                ? 'Submitting this review to GitHub…'
                : blockers === null
                  ? 'Live draft state is unavailable'
                  : needsHuman
                    ? `${activeQueueCleared} of ${activeQueueTotal} cleared · ${comments.length} comments drafted · no verdict chosen`
                    : `Submits one Approve review on ${review.repoFullName}#${review.prNumber} with ${payloadLabel} attached, as you. ${approvalNote.trim() ? 'The note posts as the review body, in your name.' : 'Nothing is sent until you press this.'}${!actionable ? (archived ? ' Restore this review from the queue before submitting.' : ' Refresh the live draft and confirm the reviewed head before submitting.') : ''}`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {actions &&
          needsHuman &&
          !archived &&
          !overrideOpen &&
          !submitted &&
          !submitting ? (
            <button
              className="border-b border-dotted border-muted px-0 py-1.5 text-muted hover:border-accent hover:text-accent"
              onClick={() => setOverrideOpen(true)}
              type="button"
            >
              Approve anyway
            </button>
          ) : null}
          {needsHuman && !submitted && !submitting ? (
            <a
              className="inline-flex min-h-9 items-center border border-primary px-3.5 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-primary no-underline hover:bg-soft focus:outline-none focus:ring-1 focus:ring-primary"
              href={review.reviewUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open workbench →
            </a>
          ) : null}
          {actions && !needsHuman && !submitted && !submitting ? (
            <>
              <a
                className="inline-flex min-h-9 items-center border border-line px-3 py-1.5 text-muted no-underline hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary"
                href={review.reviewUrl}
                rel="noreferrer"
                target="_blank"
              >
                Open workbench instead
              </a>
              <button
                className="inline-flex min-h-9 items-center border border-primary bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] px-3.5 py-1.5 font-semibold tracking-[0.04em] text-primary hover:bg-[color-mix(in_srgb,var(--primary)_22%,transparent)] disabled:cursor-not-allowed disabled:opacity-50"
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
                    : approvalActionLabel}
              </button>
            </>
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
  defaultExpanded,
  review,
  severity,
  summary,
}: {
  actions?: PrReviewBriefingActions;
  comment: GitHubPrReviewDraftComment;
  defaultExpanded: boolean;
  review: PrReviewRecord;
  severity: Severity | null | undefined;
  summary: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [actionError, setActionError] = useState<string | null>(null);
  const commentDetail = draftCommentDetail(comment, summary);
  useEffect(() => {
    if (!editing) setBody(comment.body);
  }, [comment.body, editing]);
  return (
    <article className={cardClass(severity)}>
      <button
        aria-label={`${expanded ? 'Collapse' : 'Expand'} draft comment on ${comment.path}:${comment.line}`}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 bg-transparent px-3.5 py-3 text-left"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        {severity ? (
          <SeverityBadge severity={severity} />
        ) : (
          <span className="inline-flex min-h-5 shrink-0 items-center border border-line px-1.5 py-0.5 font-mono text-[9px] font-semibold leading-none tracking-[0.04em] text-muted uppercase">
            comment
          </span>
        )}
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-primary-strong">
          {comment.path}:{comment.line}
        </code>
        <span className="inline-flex shrink-0 items-center border border-[color-mix(in_srgb,var(--primary)_60%,transparent)] px-1.5 py-0.5 font-mono text-[9px] leading-[1.35] tracking-[0.04em] text-primary-strong">
          draft comment
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[10px] text-muted"
        >
          {expanded ? '−' : '+'}
        </span>
      </button>
      <div className="px-3.5 pb-3">
        <p className="text-[14px] leading-[1.6]">{summary}</p>
        {expanded && editing ? (
          <form
            className="mt-3 border border-primary bg-canvas px-3 py-2.5"
            onSubmit={(event) => {
              event.preventDefault();
              setActionError(null);
              void actions
                ?.editComment(comment.id, body)
                .then(() => setEditing(false))
                .catch((error) => setActionError(queryErrorMessage(error)));
            }}
          >
            <p className="mb-1.5 font-mono text-[9px] tracking-[0.08em] text-muted">
              YOUR COMMENT · POSTS ON {comment.path}:{comment.line}
            </p>
            <textarea
              aria-label={`Edit draft comment on ${comment.path}`}
              className="min-h-20 w-full resize-y bg-transparent text-[13px] leading-[1.6] outline-none"
              disabled={actions?.busy}
              onChange={(event) => setBody(event.target.value)}
              value={body}
            />
            <div className="mt-2 flex justify-end gap-1.5 font-mono text-[10px]">
              <button
                className={cardActionClass}
                onClick={() => {
                  setBody(comment.body);
                  setEditing(false);
                }}
                type="button"
              >
                cancel
              </button>
              <button
                className={`${cardActionClass} border-primary text-primary`}
                disabled={actions?.busy || !body.trim()}
                type="submit"
              >
                save comment
              </button>
            </div>
          </form>
        ) : expanded && commentDetail ? (
          <div className="mt-3 border-t border-line pt-2.5">
            <p className="mb-1.5 font-mono text-[9px] tracking-[0.08em] text-muted">
              {comment.neonSummary ? 'SUGGESTED FIX' : 'COMMENT BODY'}
            </p>
            <MarkdownMessage
              className="text-muted"
              style={{ fontSize: '13px', lineHeight: '1.6' }}
            >
              {commentDetail}
            </MarkdownMessage>
          </div>
        ) : null}
        {actionError ? (
          <p
            className="mt-3 border border-accent px-3 py-2 font-mono text-[10px] text-accent"
            role="alert"
          >
            {actionError}
          </p>
        ) : null}
        <CardActions href={diffHref(review, comment.path)}>
          {actions ? (
            <>
              <button
                className={cardActionClass}
                disabled={actions.busy}
                onClick={() => {
                  setExpanded(true);
                  setEditing(true);
                }}
                type="button"
              >
                edit comment
              </button>
              <button
                className={`${cardActionClass} hover:border-accent hover:text-accent`}
                disabled={actions.busy}
                onClick={() => {
                  setActionError(null);
                  void actions
                    .dismissComment(comment.id)
                    .catch((error) => setActionError(queryErrorMessage(error)));
                }}
                type="button"
              >
                dismiss
              </button>
            </>
          ) : null}
        </CardActions>
      </div>
    </article>
  );
}

function ReportOnlyFindingCard({
  actions,
  defaultExpanded,
  finding,
  review,
}: {
  actions?: PrReviewBriefingActions;
  defaultExpanded: boolean;
  finding: PrReviewReportOnlyFinding;
  review: PrReviewRecord;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(reportOnlyFindingBody(finding));
  const [actionError, setActionError] = useState<string | null>(null);
  const location = `${finding.path}${finding.line ? `:${finding.line}` : ''}`;
  return (
    <article className={cardClass(finding.severity)}>
      <button
        aria-label={`${expanded ? 'Collapse' : 'Expand'} note on ${location}`}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 bg-transparent px-3.5 py-3 text-left"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <SeverityBadge severity={finding.severity} />
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-primary-strong">
          {location}
        </code>
        <span className="inline-flex shrink-0 items-center border border-line px-1.5 py-0.5 font-mono text-[9px] leading-[1.35] tracking-[0.04em] text-muted">
          note only
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[10px] text-muted"
        >
          {expanded ? '−' : '+'}
        </span>
      </button>
      <div className="px-3.5 pb-3">
        <p className="text-[14px] leading-[1.6]">{finding.summary}</p>
        {expanded ? (
          <>
            <div className="mt-3 border-t border-line pt-2.5">
              <p className="mb-1.5 font-mono text-[9px] tracking-[0.08em] text-muted">
                SUGGESTED FIX
              </p>
              <p className="text-[13px] leading-[1.6] text-muted">
                {finding.suggestedFix}
              </p>
              <p className="mt-2 font-mono text-[10px] text-muted">
                Not drafted: {finding.reason}
              </p>
            </div>
            {editing ? (
              <form
                className="mt-3 border border-primary bg-canvas px-3 py-2.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  setActionError(null);
                  void actions
                    ?.promoteFinding(finding, body)
                    .then(() => setEditing(false))
                    .catch((error) => setActionError(queryErrorMessage(error)));
                }}
              >
                <p className="mb-1.5 font-mono text-[9px] tracking-[0.08em] text-muted">
                  YOUR COMMENT · POSTS ON {location}
                </p>
                <textarea
                  aria-label={`Draft a comment from note on ${finding.path}`}
                  className="min-h-20 w-full resize-y bg-transparent text-[13px] leading-[1.6] outline-none"
                  disabled={actions?.busy}
                  onChange={(event) => setBody(event.target.value)}
                  value={body}
                />
                <div className="mt-2 flex justify-end gap-1.5 font-mono text-[10px]">
                  <button
                    className={cardActionClass}
                    onClick={() => {
                      setBody(reportOnlyFindingBody(finding));
                      setEditing(false);
                    }}
                    type="button"
                  >
                    cancel
                  </button>
                  <button
                    className={`${cardActionClass} border-primary text-primary`}
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
                className="mt-3 border border-accent px-3 py-2 font-mono text-[10px] text-accent"
                role="alert"
              >
                {actionError}
              </p>
            ) : null}
          </>
        ) : null}
        <CardActions href={diffHref(review, finding.path)}>
          {actions && finding.line && finding.side ? (
            <button
              className={cardActionClass}
              disabled={actions.busy}
              onClick={() => {
                setActionError(null);
                setExpanded(true);
                setEditing(true);
              }}
              type="button"
            >
              draft a comment from this
            </button>
          ) : finding.line === null ? (
            <span className="text-muted">
              file-level note · cannot be drafted as a comment
            </span>
          ) : !finding.side ? (
            <span className="text-muted">
              incomplete line anchor · cannot be drafted
            </span>
          ) : null}
        </CardActions>
      </div>
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
    <div className="mt-3 flex flex-wrap items-center justify-start gap-[7px] font-mono text-[10px]">
      <a
        className={cardActionClass}
        href={href}
        rel="noreferrer"
        target="_blank"
      >
        open in diff
      </a>
      {children}
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
      ? 'border-warning text-warning'
      : 'border-line text-muted';
  return (
    <span
      className={`inline-flex min-h-5 shrink-0 items-center border px-1.5 py-0.5 font-mono text-[9px] font-semibold leading-none tracking-[0.04em] uppercase ${className}`}
    >
      {severity}
    </span>
  );
}

const cardActionClass =
  'inline-flex min-h-6 items-center border border-line px-2.5 py-1 font-mono text-[10px] leading-[1.2] text-muted no-underline hover:border-primary hover:text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-50';

function draftCommentDetail(
  comment: GitHubPrReviewDraftComment,
  summary: string,
) {
  if (!comment.neonSummary) {
    return comment.body.trim() === summary.trim() ? null : comment.body;
  }
  let detail = comment.body.trim().replace(/^bot:\s*/i, '');
  if (detail.startsWith(summary)) detail = detail.slice(summary.length).trim();
  return detail.replace(/^Suggested fix:\s*/i, '').trim() || null;
}

function formatReviewTime(value: string | null | undefined) {
  if (!value) return 'time unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function isBlocker(severity: Severity | null | undefined) {
  return severity === 'critical' || severity === 'major';
}

function cardClass(severity: Severity | null | undefined) {
  const edgeClass = isBlocker(severity)
    ? 'border-l-accent'
    : severity === 'minor'
      ? 'border-l-warning'
      : 'border-l-muted';
  return `border border-line border-l-2 bg-panel ${edgeClass}`;
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
