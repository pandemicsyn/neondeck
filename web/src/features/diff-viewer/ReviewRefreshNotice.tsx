import type { ReviewRefreshSafety } from '../../../../shared/review-refresh';
import { reviewRefreshPauseMessage } from '../../../../shared/review-refresh';

export function ReviewRefreshNotice({
  availableLabel,
  disabled,
  onApply,
  safety,
}: {
  availableLabel: string;
  disabled: boolean;
  onApply: () => void;
  safety: ReviewRefreshSafety;
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
        <p className="review-refresh-title">New revision available</p>
        <p className="review-refresh-copy">
          {availableLabel}
          {pauseMessage ? ` ${pauseMessage}` : ' It is safe to refresh now.'}
        </p>
      </div>
      <button
        aria-label="Apply the available review revision"
        disabled={disabled}
        onClick={onApply}
        type="button"
      >
        Apply revision
      </button>
    </section>
  );
}
