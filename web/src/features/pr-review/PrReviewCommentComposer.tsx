import type { FormEvent } from 'react';
import type {
  GitHubPrReviewDraft,
  GitHubPrReviewDraftComment,
  GitHubPullRequestReviewThread,
} from '../../api';
import type { DiffReviewAnnotation } from '../diff-viewer/types';

export type PrReviewCommentComposerProps = {
  annotation: DiffReviewAnnotation;
  composerBody: string;
  draft: GitHubPrReviewDraft | null;
  editingBody: string;
  editingCommentId: string | null;
  isAddingComment: boolean;
  isDeletingComment: boolean;
  isReplyingToThread: boolean;
  isResolvingThread: boolean;
  isSavingDraft: boolean;
  isUpdatingComment: boolean;
  onCancelComposer: () => void;
  onCancelEdit: () => void;
  onCancelReply: () => void;
  onComposerBodyChange: (body: string) => void;
  onDeleteComment: (commentId: string) => void;
  onEditingBodyChange: (body: string) => void;
  onReanchorComment: (comment: GitHubPrReviewDraftComment) => void;
  onReplyBodyChange: (body: string) => void;
  onSetThreadResolution: (thread: GitHubPullRequestReviewThread) => void;
  onStartEdit: (commentId: string, body: string) => void;
  onStartReply: (threadId: string) => void;
  onSubmitComposer: (event: FormEvent) => void;
  onSubmitEdit: (event: FormEvent) => void;
  onSubmitReply: (threadId: string, event: FormEvent) => void;
  reanchoringCommentId: string | null;
  replyingThreadId: string | null;
  replyBody: string;
  reviewThreads: GitHubPullRequestReviewThread[];
  selected?: boolean;
};

export function PrReviewCommentComposer({
  annotation,
  composerBody,
  draft,
  editingBody,
  editingCommentId,
  isAddingComment,
  isDeletingComment,
  isReplyingToThread,
  isResolvingThread,
  isSavingDraft,
  isUpdatingComment,
  onCancelComposer,
  onCancelEdit,
  onCancelReply,
  onComposerBodyChange,
  onDeleteComment,
  onEditingBodyChange,
  onReanchorComment,
  onReplyBodyChange,
  onSetThreadResolution,
  onStartEdit,
  onStartReply,
  onSubmitComposer,
  onSubmitEdit,
  onSubmitReply,
  reanchoringCommentId,
  replyingThreadId,
  replyBody,
  reviewThreads,
  selected = false,
}: PrReviewCommentComposerProps) {
  const metadata = annotation.metadata;
  if (metadata.kind === 'composer') {
    return (
      <CommentForm
        body={composerBody}
        id="pr-review-new-comment"
        isAnnotationRoot
        isPending={isAddingComment || isSavingDraft}
        label="Draft review comment"
        onBodyChange={onComposerBodyChange}
        onCancel={onCancelComposer}
        onSubmit={onSubmitComposer}
        placeholder="Draft an inline review comment"
        submitLabel="Save"
      />
    );
  }

  if (metadata.kind === 'draft') {
    const comment = draft?.comments.find((item) => item.id === metadata.id);
    const isEditing = editingCommentId === metadata.id;
    const origin = comment?.origin === 'neon' ? 'neon draft' : 'draft';
    return (
      <div
        className={
          [
            metadata.isStale ? 'pr-review-draft-stale' : null,
            selected ? 'pr-review-annotation-selected' : null,
          ]
            .filter(Boolean)
            .join(' ') || undefined
        }
        data-neondeck-review-annotation=""
        data-navigation-selected={selected ? '' : undefined}
      >
        <div data-neondeck-review-annotation-title="">
          <span>
            {metadata.isStale ? `stale ${origin}` : origin} · {metadata.title}
          </span>
        </div>
        {isEditing ? (
          <CommentForm
            body={editingBody}
            hint={
              reanchoringCommentId === metadata.id
                ? 'Select a new diff line to re-anchor this comment.'
                : null
            }
            isPending={isUpdatingComment}
            label="Edit draft review comment"
            onBodyChange={onEditingBodyChange}
            onCancel={onCancelEdit}
            onSubmit={onSubmitEdit}
            submitLabel="Save"
          />
        ) : (
          <>
            <p>{metadata.body}</p>
            <div className="pr-review-inline-actions">
              <button
                onClick={() =>
                  onStartEdit(metadata.id, comment?.body ?? metadata.body)
                }
                type="button"
              >
                Edit
              </button>
              <button
                disabled={isDeletingComment}
                onClick={() => onDeleteComment(metadata.id)}
                type="button"
              >
                {isDeletingComment ? 'Deleting' : 'Delete'}
              </button>
              {metadata.isStale && comment ? (
                <button
                  disabled={isUpdatingComment}
                  onClick={() => onReanchorComment(comment)}
                  type="button"
                >
                  Re-anchor
                </button>
              ) : null}
            </div>
          </>
        )}
      </div>
    );
  }

  const thread = reviewThreads.find((item) => item.id === metadata.id);
  const isReplying = replyingThreadId === metadata.id;
  const threadComments = thread?.comments ?? [];
  return (
    <div
      className={[
        'pr-review-thread',
        thread?.isResolved ? 'pr-review-thread-resolved' : null,
        thread?.isOutdated ? 'pr-review-thread-outdated' : null,
        selected ? 'pr-review-annotation-selected' : null,
      ]
        .filter(Boolean)
        .join(' ')}
      data-neondeck-review-annotation=""
      data-navigation-selected={selected ? '' : undefined}
    >
      <div
        className="pr-review-thread-heading"
        data-neondeck-review-annotation-title=""
      >
        <span className="pr-review-thread-state">
          {thread?.isResolved ? 'Resolved' : 'Open'} review thread
        </span>
        <span>
          {threadComments.length || 1} comment
          {(threadComments.length || 1) === 1 ? '' : 's'}
          {thread?.isOutdated ? ' · outdated' : ''}
        </span>
      </div>
      <div className="pr-review-thread-comments">
        {threadComments.length > 0 ? (
          threadComments.map((comment) => (
            <article className="pr-review-thread-comment" key={comment.id}>
              <div className="pr-review-thread-comment-meta">
                <span>
                  {comment.authorLogin ? `@${comment.authorLogin}` : 'reviewer'}
                </span>
                <span>{threadCommentTimestamp(comment.createdAt)}</span>
              </div>
              <p>{comment.body}</p>
            </article>
          ))
        ) : (
          <article className="pr-review-thread-comment">
            <div className="pr-review-thread-comment-meta">
              <span>
                {metadata.authorLogin ? `@${metadata.authorLogin}` : 'reviewer'}
              </span>
            </div>
            <p>{metadata.body}</p>
          </article>
        )}
      </div>
      {isReplying ? (
        <CommentForm
          body={replyBody}
          isPending={isReplyingToThread}
          label="Reply to this thread"
          onBodyChange={onReplyBodyChange}
          onCancel={onCancelReply}
          onSubmit={(event) => onSubmitReply(metadata.id, event)}
          placeholder="Reply to this thread"
          submitLabel="Reply"
        />
      ) : (
        <div className="pr-review-inline-actions">
          <button onClick={() => onStartReply(metadata.id)} type="button">
            Reply
          </button>
          {thread ? (
            <button
              disabled={isResolvingThread}
              onClick={() => onSetThreadResolution(thread)}
              type="button"
            >
              {isResolvingThread
                ? 'Updating'
                : thread.isResolved
                  ? 'Unresolve'
                  : 'Resolve'}
            </button>
          ) : null}
          {metadata.url ? (
            <a href={metadata.url} rel="noreferrer" target="_blank">
              Open on GitHub
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}

function threadCommentTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 16);
}

function CommentForm({
  body,
  hint,
  id,
  isAnnotationRoot = false,
  isPending,
  label,
  onBodyChange,
  onCancel,
  onSubmit,
  placeholder,
  submitLabel,
}: {
  body: string;
  hint?: string | null;
  id?: string;
  isAnnotationRoot?: boolean;
  isPending: boolean;
  label: string;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: (event: FormEvent) => void;
  placeholder?: string;
  submitLabel: string;
}) {
  return (
    <form
      className="pr-review-composer"
      data-review-shortcuts="off"
      {...(isAnnotationRoot ? { 'data-neondeck-review-annotation': '' } : {})}
      onSubmit={onSubmit}
    >
      {id ? (
        <label className="sr-only" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <textarea
        {...(id ? { id } : { 'aria-label': label })}
        onChange={(event) => onBodyChange(event.currentTarget.value)}
        placeholder={placeholder}
        value={body}
      />
      <div className="pr-review-composer-actions">
        <button disabled={body.trim().length === 0 || isPending} type="submit">
          {isPending
            ? submitLabel === 'Reply'
              ? 'Replying'
              : 'Saving'
            : submitLabel}
        </button>
        <button onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
      {hint ? <p className="pr-review-inline-hint">{hint}</p> : null}
    </form>
  );
}
