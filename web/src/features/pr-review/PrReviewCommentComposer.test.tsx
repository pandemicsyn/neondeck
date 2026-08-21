import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GitHubPullRequestReviewThread } from '../../api';
import { PrReviewCommentComposer } from './PrReviewCommentComposer';

describe('PrReviewCommentComposer', () => {
  it('labels Neon drafts separately from published review threads', () => {
    const html = renderToStaticMarkup(
      <PrReviewCommentComposer
        annotation={{
          side: 'additions',
          lineNumber: 42,
          metadata: {
            id: 'draft-comment-1',
            kind: 'draft',
            title: 'RIGHT L42',
            body: 'Please guard the empty case.',
            isStale: false,
          },
        }}
        composerBody=""
        draft={{
          id: 'draft-1',
          repo: 'example/repo',
          prNumber: 1,
          headSha: 'abc123',
          verdict: null,
          body: null,
          status: 'draft',
          createdAt: '2026-07-21T20:00:00.000Z',
          updatedAt: '2026-07-21T20:00:00.000Z',
          submittedAt: null,
          comments: [
            {
              id: 'draft-comment-1',
              draftId: 'draft-1',
              path: 'src/app.ts',
              side: 'RIGHT',
              line: 42,
              startLine: null,
              startSide: null,
              body: 'Please guard the empty case.',
              origin: 'neon',
              createdAt: '2026-07-21T20:00:00.000Z',
              updatedAt: '2026-07-21T20:00:00.000Z',
            },
          ],
        }}
        editingBody=""
        editingCommentId={null}
        isAddingComment={false}
        isDeletingComment={false}
        isLocked={false}
        isReplyingToThread={false}
        isResolvingThread={false}
        isSavingDraft={false}
        isSubmissionPending={false}
        isUpdatingComment={false}
        onCancelComposer={noop}
        onCancelEdit={noop}
        onCancelReply={noop}
        onComposerBodyChange={noop}
        onDeleteComment={noop}
        onEditingBodyChange={noop}
        onReanchorComment={noop}
        onReplyBodyChange={noop}
        onSetThreadResolution={noop}
        onStartEdit={noop}
        onStartReply={noop}
        onSubmitComposer={noop}
        onSubmitEdit={noop}
        onSubmitReply={noop}
        reanchoringCommentId={null}
        replyingThreadId={null}
        replyBody=""
        reviewThreads={[]}
      />,
    );

    expect(html).toContain('pr-review-draft');
    expect(html).toContain('pr-review-draft-heading');
    expect(html).toContain('Draft');
    expect(html).toContain('Neon generated · RIGHT L42');
    expect(html).toContain('pr-review-draft-body');
    expect(html).toContain('pr-review-inline-actions');
  });

  it('makes an inline GitHub thread and every participant visible', () => {
    const thread: GitHubPullRequestReviewThread = {
      id: 'thread-1',
      isResolved: false,
      isOutdated: false,
      path: 'src/app.ts',
      line: 42,
      comments: [
        threadComment('comment-1', 'alice', 'Please guard the empty case.'),
        threadComment('comment-2', 'bob', 'Fixed in the latest push.'),
      ],
    };

    const html = renderToStaticMarkup(
      <PrReviewCommentComposer
        annotation={{
          side: 'additions',
          lineNumber: 42,
          metadata: {
            id: thread.id,
            kind: 'thread',
            title: 'Review thread',
            body: 'Please guard the empty case.',
            authorLogin: 'alice',
            url: 'https://github.com/example/repo/pull/1#discussion_r1',
          },
        }}
        composerBody=""
        draft={null}
        editingBody=""
        editingCommentId={null}
        isAddingComment={false}
        isDeletingComment={false}
        isLocked={false}
        isReplyingToThread={false}
        isResolvingThread={false}
        isSavingDraft={false}
        isSubmissionPending={false}
        isUpdatingComment={false}
        onCancelComposer={noop}
        onCancelEdit={noop}
        onCancelReply={noop}
        onComposerBodyChange={noop}
        onDeleteComment={noop}
        onEditingBodyChange={noop}
        onReanchorComment={noop}
        onReplyBodyChange={noop}
        onSetThreadResolution={noop}
        onStartEdit={noop}
        onStartReply={noop}
        onSubmitComposer={noop}
        onSubmitEdit={noop}
        onSubmitReply={noop}
        reanchoringCommentId={null}
        replyingThreadId={null}
        replyBody=""
        reviewThreads={[thread]}
      />,
    );

    expect(html).toContain('pr-review-thread');
    expect(html).toContain('Open review thread');
    expect(html).toContain('2 comments');
    expect(html).toContain('@alice');
    expect(html).toContain('Please guard the empty case.');
    expect(html).toContain('@bob');
    expect(html).toContain('Fixed in the latest push.');
    expect(html).toContain('Open on GitHub');
  });

  it('disables the inline editor for the whole revision-apply transaction', () => {
    const html = renderToStaticMarkup(
      <PrReviewCommentComposer
        annotation={{
          side: 'additions',
          lineNumber: 42,
          metadata: {
            id: 'composer-1',
            kind: 'composer',
            title: 'RIGHT L42',
            body: '',
          },
        }}
        composerBody="Draft on the old revision"
        draft={null}
        editingBody=""
        editingCommentId={null}
        isAddingComment={false}
        isDeletingComment={false}
        isLocked
        isReplyingToThread={false}
        isResolvingThread={false}
        isSavingDraft={false}
        isSubmissionPending={false}
        isUpdatingComment={false}
        onCancelComposer={noop}
        onCancelEdit={noop}
        onCancelReply={noop}
        onComposerBodyChange={noop}
        onDeleteComment={noop}
        onEditingBodyChange={noop}
        onReanchorComment={noop}
        onReplyBodyChange={noop}
        onSetThreadResolution={noop}
        onStartEdit={noop}
        onStartReply={noop}
        onSubmitComposer={noop}
        onSubmitEdit={noop}
        onSubmitReply={noop}
        reanchoringCommentId={null}
        replyingThreadId={null}
        replyBody=""
        reviewThreads={[]}
      />,
    );

    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    expect(html).toContain('<button disabled="" type="button">Cancel</button>');
  });
});

function noop() {}

function threadComment(id: string, authorLogin: string, body: string) {
  return {
    id,
    databaseId: null,
    authorLogin,
    body,
    url: null,
    path: 'src/app.ts',
    line: 42,
    originalLine: null,
    diffHunk: '@@ -40,2 +40,3 @@',
    reviewId: null,
    createdAt: '2026-07-21T20:00:00.000Z',
    updatedAt: '2026-07-21T20:00:00.000Z',
  };
}
