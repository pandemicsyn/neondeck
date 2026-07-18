import type { SelectedLineRange } from '@pierre/diffs/react';
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  type GitHubPrReviewDraft,
  type GitHubPullRequestReviewThread,
} from '../../api';
import type { DiffFilePatch } from '../diff-viewer/types';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
  commentInputFromSelection,
  failingCommentIdsFromError,
  normalizeReviewBody,
  reviewDraftNeedsSubmitSave,
  reviewCommentPreview,
  staleDraftCommentIds,
} from './review-helpers';
import {
  backgroundReviewPatchPaths,
  draftCommentIdsWithUnknownPatch,
  reviewPatchQuerySettled,
} from './review-view-model';
import {
  reportOnlyFindingBody,
  isReportOnlyFindingDrafted,
} from './PrReviewFindingsSidebar';
import {
  clearCompletedEditor,
  isCurrentReviewOperation,
} from './review-ui-helpers';
import capturedReviewPatch from './fixtures/captured-review.patch?raw';

describe('GitHubPrReview helpers', () => {
  it('maps Pierre same-side selections to GitHub review comment anchors', () => {
    expect(
      commentInputFromSelection(selection({ side: 'deletions', line: 7 })),
    ).toEqual({
      side: 'LEFT',
      line: 7,
      startLine: null,
      startSide: null,
    });
    expect(
      commentInputFromSelection(selection({ side: 'additions', line: 12 })),
    ).toEqual({
      side: 'RIGHT',
      line: 12,
      startLine: null,
      startSide: null,
    });
  });

  it('normalizes reverse same-side selections before creating range anchors', () => {
    expect(
      commentInputFromSelection({
        side: 'additions',
        start: 20,
        end: 18,
      } as SelectedLineRange),
    ).toEqual({
      side: 'RIGHT',
      line: 20,
      startLine: 18,
      startSide: 'RIGHT',
    });
  });

  it('preserves cross-side range anchors', () => {
    expect(
      commentInputFromSelection({
        side: 'deletions',
        endSide: 'additions',
        start: 4,
        end: 6,
      } as SelectedLineRange),
    ).toEqual({
      side: 'RIGHT',
      line: 6,
      startLine: 4,
      startSide: 'LEFT',
    });
  });

  it('maps the addressing matrix from a captured real patch', () => {
    const reviewIndex = buildPatchAnchorIndex(
      capturedFilePatch('src/review.ts'),
    );
    const renamedIndex = buildPatchAnchorIndex(
      capturedFilePatch('src/new-name.ts'),
    );

    expect(
      commentInputFromSelection(
        selection({ side: 'deletions', line: 3 }),
        reviewIndex,
      ),
    ).toEqual({
      side: 'LEFT',
      line: 3,
      startLine: null,
      startSide: null,
    });
    expect(
      commentInputFromSelection(
        selection({ side: 'additions', line: 5 }),
        reviewIndex,
      ),
    ).toEqual({
      side: 'RIGHT',
      line: 5,
      startLine: null,
      startSide: null,
    });

    expect(
      commentInputFromSelection(
        {
          side: 'additions',
          endSide: 'deletions',
          start: 22,
          end: 20,
        } as SelectedLineRange,
        reviewIndex,
      ),
    ).toEqual({
      side: 'RIGHT',
      line: 22,
      startLine: 20,
      startSide: 'LEFT',
    });
    expect(
      commentInputFromSelection(
        selection({ side: 'additions', line: 1 }),
        renamedIndex,
      ),
    ).toEqual({
      side: 'RIGHT',
      line: 1,
      startLine: null,
      startSide: null,
    });
    expect(
      commentAnchorExists(reviewIndex, {
        side: 'RIGHT',
        line: 22,
        startLine: 20,
        startSide: 'LEFT',
      }),
    ).toBe(true);
    expect(
      staleDraftCommentIds(
        draftWithComments([
          {
            id: 'renamed',
            path: 'src/new-name.ts',
            side: 'RIGHT',
            line: 1,
            startLine: null,
            startSide: null,
          },
        ]),
        new Map([['src/new-name.ts', renamedIndex]]),
      ),
    ).toEqual(new Set());
  });

  it('marks stale ranges when endpoints no longer share an ordered hunk', () => {
    const draft = draftWithComments([
      {
        id: 'same-hunk',
        path: 'src/app.ts',
        side: 'RIGHT',
        line: 3,
        startLine: 2,
        startSide: 'RIGHT',
      },
      {
        id: 'cross-hunk',
        path: 'src/app.ts',
        side: 'RIGHT',
        line: 12,
        startLine: 2,
        startSide: 'RIGHT',
      },
      {
        id: 'reversed',
        path: 'src/app.ts',
        side: 'RIGHT',
        line: 2,
        startLine: 3,
        startSide: 'RIGHT',
      },
    ]);
    const patchIndexes = new Map([
      [
        'src/app.ts',
        buildPatchAnchorIndex(
          [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -1,3 +1,3 @@',
            ' line 1',
            '+line 2',
            '+line 3',
            '@@ -10,3 +10,3 @@',
            ' line 10',
            '+line 11',
            '+line 12',
          ].join('\n'),
        ),
      ],
    ]);

    expect(staleDraftCommentIds(draft, patchIndexes)).toEqual(
      new Set(['cross-hunk', 'reversed']),
    );
  });

  it('does not index a phantom context line from a trailing patch newline', () => {
    const index = buildPatchAnchorIndex(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,1 +1,1 @@',
        ' line 1',
        '',
      ].join('\n'),
    );

    expect(index.has('RIGHT:1')).toBe(true);
    expect(index.has('RIGHT:2')).toBe(false);
    expect(index.has('LEFT:2')).toBe(false);
  });

  it('does not treat stale-head submit failures as failed inline comments', () => {
    expect(
      failingCommentIdsFromError(
        apiError({
          data: {
            code: 'stale-draft',
            failingCommentIds: ['comment-1', 'comment-2'],
          },
        }),
      ),
    ).toEqual([]);
  });

  it('reads failed inline comment ids from GitHub review submit failures', () => {
    expect(
      failingCommentIdsFromError(
        apiError({
          data: {
            code: 'github-review-submit-failed',
            failingCommentIds: ['comment-1', 'comment-2'],
          },
        }),
      ),
    ).toEqual(['comment-1', 'comment-2']);
  });

  it('normalizes blank review bodies to null before draft comparisons', () => {
    expect(normalizeReviewBody('  \n ')).toBeNull();
    expect(normalizeReviewBody(null)).toBeNull();
    expect(normalizeReviewBody(' Looks good. ')).toBe('Looks good.');
  });

  it('requires submit-time saving when the draft head is stale', () => {
    const draft = draftWithComments([]);
    expect(
      reviewDraftNeedsSubmitSave(draft, draft.body, 'comment', 'head456'),
    ).toBe(true);
    expect(
      reviewDraftNeedsSubmitSave(draft, draft.body, 'comment', draft.headSha),
    ).toBe(false);
  });

  it('renders markdown draft comment bodies as plain annotation previews', () => {
    expect(
      reviewCommentPreview(
        [
          '## Suggested change',
          '',
          '- Use `safeValue` here',
          '- Keep **fallbacks** explicit',
        ].join('\n'),
      ),
    ).toBe('Suggested change Use safeValue here Keep fallbacks explicit');
  });

  it('keeps active patch work separate from neighbor and review background paths', () => {
    const files = reviewFiles([
      'src/previous.ts',
      'src/active.ts',
      'src/next.ts',
      'src/draft.ts',
      'src/thread.ts',
    ]);
    const draft = draftWithComments([
      draftComment('active', 'src/active.ts'),
      draftComment('draft', 'src/draft.ts'),
      draftComment('missing', 'src/missing.ts'),
    ]);

    expect(
      backgroundReviewPatchPaths({
        activePath: 'src/active.ts',
        draft,
        files,
        unresolvedThreads: [
          reviewThread('active-thread', 'src/active.ts'),
          reviewThread('thread', 'src/thread.ts'),
          reviewThread('missing-thread', 'src/missing.ts'),
        ],
      }),
    ).toEqual([
      'src/previous.ts',
      'src/next.ts',
      'src/draft.ts',
      'src/thread.ts',
    ]);
  });

  it('releases background patch work only after the active query settles', () => {
    expect(reviewPatchQuerySettled(undefined)).toBe(false);
    expect(reviewPatchQuerySettled(patchQueryState({ isLoading: true }))).toBe(
      false,
    );
    expect(reviewPatchQuerySettled(patchQueryState({ hasData: true }))).toBe(
      true,
    );
    expect(reviewPatchQuerySettled(patchQueryState({ isError: true }))).toBe(
      true,
    );
  });

  it('keeps deferred draft anchors unknown without hiding removed-file staleness', () => {
    const draft = draftWithComments([
      draftComment('deferred', 'src/deferred.ts'),
      draftComment('removed', 'src/removed.ts'),
    ]);

    expect(
      draftCommentIdsWithUnknownPatch(
        draft,
        reviewFiles(['src/deferred.ts']),
        new Map(),
        new Set(['src/deferred.ts']),
      ),
    ).toEqual(new Set(['deferred']));
  });

  it('clears only the editor instance whose mutation completed', () => {
    const submitted = { body: 'First draft', commentId: 'comment-1', token: 1 };
    const newerComment = {
      body: 'Do not erase this draft',
      commentId: 'comment-2',
      token: 2,
    };
    const reopenedComment = {
      body: 'A newer draft for the same comment',
      commentId: 'comment-1',
      token: 3,
    };

    expect(clearCompletedEditor(submitted, submitted.token)).toBeNull();
    expect(clearCompletedEditor(newerComment, submitted.token)).toBe(
      newerComment,
    );
    expect(clearCompletedEditor(reopenedComment, submitted.token)).toBe(
      reopenedComment,
    );
  });

  it('ignores status from an operation superseded by newer work', () => {
    expect(isCurrentReviewOperation(2, 1)).toBe(false);
    expect(isCurrentReviewOperation(2, 2)).toBe(true);
  });

  it('matches report-only drafts by persisted source identity', () => {
    const finding = {
      sourceId: 'prf_source_1',
      severity: 'minor' as const,
      path: 'src/review.ts',
      line: null,
      summary: 'Overlapping summary',
      suggestedFix: 'Keep the source identity.',
      reason: 'unanchorable',
    };
    const draft = draftWithComments([draftComment('generated', finding.path)]);
    const comment = draft.comments[0];
    if (!comment) throw new Error('Expected draft comment fixture.');
    comment.body = 'The user edited the generated text.';
    comment.path = 'src/another-file.ts';
    comment.sourceFindingId = finding.sourceId;

    expect(isReportOnlyFindingDrafted(draft, finding)).toBe(true);
    expect(
      isReportOnlyFindingDrafted(draft, {
        ...finding,
        sourceId: 'prf_source_2',
      }),
    ).toBe(false);
  });

  it('falls back to exact text and path for provenance-less legacy drafts', () => {
    const finding = {
      sourceId: 'prf_synthesized_on_read',
      severity: 'minor' as const,
      path: 'src/review.ts',
      line: null,
      summary: 'Shared words',
      suggestedFix: 'Use exact matching.',
      reason: 'unanchorable',
    };
    const draft = draftWithComments([draftComment('legacy', finding.path)]);
    const comment = draft.comments[0];
    if (!comment) throw new Error('Expected draft comment fixture.');
    comment.body = reportOnlyFindingBody(finding);

    expect(isReportOnlyFindingDrafted(draft, finding)).toBe(true);
    comment.sourceFindingId = 'prf_different_finding';
    expect(isReportOnlyFindingDrafted(draft, finding)).toBe(false);
    comment.sourceFindingId = null;
    comment.path = 'src/other.ts';
    expect(isReportOnlyFindingDrafted(draft, finding)).toBe(false);
  });
});

function selection(input: { side: 'additions' | 'deletions'; line: number }) {
  return {
    side: input.side,
    start: input.line,
    end: input.line,
  } as SelectedLineRange;
}

function capturedFilePatch(path: string) {
  const sections = capturedReviewPatch
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((section) => `diff --git ${section}`);
  const section = sections.find((item) =>
    item.startsWith(`diff --git a/${path} b/${path}\n`),
  );
  if (section) return section;
  const renamedSection = sections.find((item) =>
    item.startsWith(`diff --git a/src/old-name.ts b/${path}\n`),
  );
  if (renamedSection) return renamedSection;
  throw new Error(`Missing captured patch for ${path}.`);
}

function apiError(data: unknown) {
  return new ApiError(
    'Review submit failed.',
    422,
    '/api/github/reviews',
    data,
  );
}

function draftWithComments(
  comments: Array<{
    id: string;
    path: string;
    side: 'RIGHT' | 'LEFT';
    line: number;
    startLine: number | null;
    startSide: 'RIGHT' | 'LEFT' | null;
  }>,
): GitHubPrReviewDraft {
  return {
    id: 'draft-1',
    repo: 'pandemicsyn/neondeck',
    prNumber: 123,
    headSha: 'head123',
    verdict: 'comment',
    body: null,
    status: 'draft',
    createdAt: '2026-07-05T00:00:00Z',
    updatedAt: '2026-07-05T00:00:00Z',
    submittedAt: null,
    comments: comments.map((comment) => ({
      ...comment,
      draftId: 'draft-1',
      body: comment.id,
      origin: 'human',
      createdAt: '2026-07-05T00:00:00Z',
      updatedAt: '2026-07-05T00:00:00Z',
    })),
  };
}

function draftComment(id: string, path: string) {
  return {
    id,
    path,
    side: 'RIGHT' as const,
    line: 1,
    startLine: null,
    startSide: null,
  };
}

function reviewFiles(paths: string[]): DiffFilePatch[] {
  return paths.map((path) => ({
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
  }));
}

function reviewThread(id: string, path: string): GitHubPullRequestReviewThread {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path,
    line: 1,
    originalLine: null,
    diffSide: 'RIGHT',
    pullRequestRepo: 'pandemicsyn/neondeck',
    pullRequestNumber: 123,
    comments: [],
  };
}

function patchQueryState(
  input: Partial<{
    hasData: boolean;
    isError: boolean;
    isLoading: boolean;
  }>,
) {
  return {
    file: null,
    hasData: false,
    isError: false,
    isLoading: false,
    error: null,
    ...input,
  };
}
