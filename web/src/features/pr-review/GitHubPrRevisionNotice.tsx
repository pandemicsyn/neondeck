import { canExplicitlyApplyReviewRefresh } from '../../../../shared/review-refresh';
import type { ReviewRefreshSafety } from '../../../../shared/review-refresh';
import { ReviewRefreshNotice } from '../diff-viewer/ReviewRefreshNotice';

export function GitHubPrRevisionNotice({
  headSha,
  onApply,
  safety,
}: {
  headSha: string | null | undefined;
  onApply: () => void;
  safety: ReviewRefreshSafety;
}) {
  return (
    <ReviewRefreshNotice
      actionAriaLabel="Update the review workspace to the available revision"
      actionLabel="Update to new revision"
      availableLabel={`GitHub head ${headSha?.slice(0, 7) ?? 'unavailable'} differs from the mounted review. Updating loads that revision and moves any local draft to the same head. Comments that no longer anchor remain blocked until re-anchored; nothing is submitted to GitHub.`}
      disabled={!canExplicitlyApplyReviewRefresh(safety)}
      onApply={onApply}
      safety={safety}
    />
  );
}

export function GitHubPrDraftRevisionNotice({
  disabled,
  headSha,
  onApply,
  safety,
}: {
  disabled: boolean;
  headSha: string;
  onApply: () => void;
  safety: ReviewRefreshSafety;
}) {
  return (
    <ReviewRefreshNotice
      actionAriaLabel="Update the local draft to the mounted review revision"
      actionLabel="Update draft to current revision"
      availableLabel={`The diff is showing GitHub head ${headSha.slice(0, 7)}, but the local draft belongs to an older revision. Updating moves only the local draft; comments that no longer anchor remain blocked until re-anchored.`}
      disabled={disabled}
      onApply={onApply}
      readyLabel="It is safe to update the draft now."
      safety={safety}
      title="Draft revision is outdated"
    />
  );
}
