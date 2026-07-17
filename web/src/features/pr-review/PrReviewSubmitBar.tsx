import type { GitHubPrReviewDraft, GitHubPrReviewVerdict } from '../../api';

export function PrReviewSubmitBar({
  cleanCommentCount,
  draft,
  isBusy,
  isDurableReviewReady,
  isHeadAvailable,
  isSubmitting,
  onBodyBlur,
  onBodyChange,
  onBodyFocus,
  onDiscard,
  onPendingCountClick,
  onSubmit,
  onVerdictChange,
  reviewBody,
  staleCommentCount,
  statusMessage,
  verdict,
  trustBoundary,
}: {
  cleanCommentCount: number;
  draft: GitHubPrReviewDraft | null;
  isBusy: boolean;
  isDurableReviewReady: boolean;
  isHeadAvailable: boolean;
  isSubmitting: boolean;
  onBodyBlur: () => void;
  onBodyChange: (value: string) => void;
  onBodyFocus: () => void;
  onDiscard: () => void;
  onPendingCountClick: () => void;
  onSubmit: () => void;
  onVerdictChange: (value: GitHubPrReviewVerdict) => void;
  reviewBody: string;
  staleCommentCount: number;
  statusMessage: string | null;
  verdict: GitHubPrReviewVerdict;
  trustBoundary: string | null;
}) {
  const hasBody = reviewBody.trim().length > 0;
  const canSubmit =
    isHeadAvailable &&
    isDurableReviewReady &&
    !isBusy &&
    (verdict === 'approve' || cleanCommentCount > 0 || hasBody);

  return (
    <aside
      aria-busy={isBusy}
      aria-label="Review submission controls"
      className="pr-review-bar"
    >
      <div className="pr-review-bar-main">
        <button
          className="pr-review-count"
          disabled={cleanCommentCount === 0}
          onClick={onPendingCountClick}
          title="Cycle through pending draft comments"
          type="button"
        >
          {cleanCommentCount} pending
        </button>
        {staleCommentCount > 0 ? (
          <span className="pr-review-stale-count">
            {staleCommentCount} stale skipped
          </span>
        ) : null}
        <fieldset className="pr-review-verdicts">
          <legend className="sr-only">Review verdict</legend>
          {(['comment', 'approve', 'request-changes'] as const).map((item) => (
            <button
              aria-pressed={verdict === item}
              disabled={!isHeadAvailable || isBusy}
              key={item}
              onClick={() => onVerdictChange(item)}
              type="button"
            >
              {verdictLabel(item)}
            </button>
          ))}
        </fieldset>
      </div>
      <label className="sr-only" htmlFor="pr-review-summary-body">
        Review summary
      </label>
      <textarea
        id="pr-review-summary-body"
        disabled={!isHeadAvailable}
        onBlur={onBodyBlur}
        onChange={(event) => onBodyChange(event.currentTarget.value)}
        onFocus={onBodyFocus}
        placeholder={
          isHeadAvailable ? 'Review summary' : 'PR head SHA unavailable'
        }
        value={reviewBody}
      />
      <div className="pr-review-bar-actions">
        <button disabled={!canSubmit} onClick={onSubmit} type="button">
          {isSubmitting ? 'Submitting to GitHub…' : 'Submit'}
        </button>
        <button disabled={!draft || isBusy} onClick={onDiscard} type="button">
          Discard
        </button>
      </div>
      {trustBoundary ? (
        <p className="pr-review-bar-status">{trustBoundary}</p>
      ) : null}
      {statusMessage ? (
        <p aria-live="polite" className="pr-review-bar-status">
          {statusMessage}
        </p>
      ) : null}
    </aside>
  );
}

function verdictLabel(value: GitHubPrReviewVerdict) {
  if (value === 'approve') return 'Approve';
  if (value === 'request-changes') return 'Request changes';
  return 'Comment';
}
