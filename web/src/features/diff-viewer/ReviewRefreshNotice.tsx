import type { ReviewRefreshSafety } from '../../../../shared/review-refresh';
import { reviewRefreshPauseMessage } from '../../../../shared/review-refresh';

export function ReviewRefreshNotice({
  actionAriaLabel = 'Apply the available review revision',
  actionLabel = 'Apply revision',
  availableLabel,
  disabled,
  onApply,
  readyLabel = 'It is safe to refresh now.',
  safety,
  title = 'New revision available',
}: {
  actionAriaLabel?: string;
  actionLabel?: string;
  availableLabel: string;
  disabled: boolean;
  onApply: () => void;
  readyLabel?: string;
  safety: ReviewRefreshSafety;
  title?: string;
}) {
  const pauseMessage = reviewRefreshPauseMessage(safety.reasons);
  return (
    <section
      aria-atomic="true"
      aria-label="Review revision availability"
      aria-live="polite"
      className="review-refresh-notice"
    >
      <div className="min-w-0">
        <p className="review-refresh-title">{title}</p>
        <p className="review-refresh-copy">
          {availableLabel}
          {pauseMessage ? ` ${pauseMessage}` : ` ${readyLabel}`}
        </p>
      </div>
      <button
        aria-label={actionAriaLabel}
        disabled={disabled}
        onClick={onApply}
        type="button"
      >
        {actionLabel}
      </button>
    </section>
  );
}
