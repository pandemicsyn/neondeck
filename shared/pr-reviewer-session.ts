const revisionSeparator = '@';

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
