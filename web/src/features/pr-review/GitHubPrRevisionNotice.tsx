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
      availableLabel={`GitHub head ${headSha?.slice(0, 7) ?? 'unavailable'} differs from the mounted review. Applying it will not move or submit the local draft.`}
      disabled={!canExplicitlyApplyReviewRefresh(safety)}
      onApply={onApply}
      safety={safety}
    />
  );
}
