import type {
  GitHubPrReviewDraftComment,
  GitHubPullRequestReviewThread,
} from '../../api';

export function commentAnchorLabel(comment: GitHubPrReviewDraftComment) {
  if (comment.startLine) {
    return `${comment.startSide ?? comment.side} L${comment.startLine} -> ${comment.side} L${comment.line}`;
  }
  return `${comment.side} L${comment.line}`;
}

export function threadPath(thread: GitHubPullRequestReviewThread) {
  return (
    thread.path ?? thread.comments.find((comment) => comment.path)?.path ?? null
  );
}

export function latestThreadComment(thread: GitHubPullRequestReviewThread) {
  return thread.comments.at(-1) ?? thread.comments[0] ?? null;
}

export function clearCompletedEditor<T extends { token: number }>(
  current: T | null,
  completedToken: number,
) {
  return current?.token === completedToken ? null : current;
}

export function isCurrentReviewOperation(
  currentToken: number,
  completedToken: number,
) {
  return currentToken === completedToken;
}
