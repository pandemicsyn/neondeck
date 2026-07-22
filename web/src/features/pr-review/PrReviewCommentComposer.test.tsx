import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GitHubPullRequestReviewThread } from '../../api';
import { PrReviewCommentComposer } from './PrReviewCommentComposer';

describe('PrReviewCommentComposer', () => {
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
        isReplyingToThread={false}
        isResolvingThread={false}
        isSavingDraft={false}
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
