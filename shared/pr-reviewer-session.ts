const revisionSeparator = '@';

export const prReviewerDraftToolNames = [
  'neondeck_pr_review_draft_comment_create',
  'neondeck_pr_review_draft_comment_update',
  'neondeck_pr_review_draft_comment_delete',
] as const;

export const prReviewerReReviewToolName = 'neondeck_pr_review_restart' as const;

export type PrReviewerDraftToolName = (typeof prReviewerDraftToolNames)[number];

export function isPrReviewerDraftToolName(
  value: string,
): value is PrReviewerDraftToolName {
  return (prReviewerDraftToolNames as readonly string[]).includes(value);
}

export function prReviewerConversationId(reviewId: string, headSha: string) {
  return `${reviewId}${revisionSeparator}${headSha}`;
}

export function parsePrReviewerConversationId(value: string) {
  const separatorIndex = value.lastIndexOf(revisionSeparator);
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return { reviewId: value, headSha: null };
  }
  return {
    reviewId: value.slice(0, separatorIndex),
    headSha: value.slice(separatorIndex + revisionSeparator.length),
  };
}
