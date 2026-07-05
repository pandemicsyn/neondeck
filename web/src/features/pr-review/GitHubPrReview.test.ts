import type { SelectedLineRange } from '@pierre/diffs/react';
import { describe, expect, it } from 'vitest';
import { ApiError, type GitHubPrReviewDraft } from '../../api';
import {
  buildPatchAnchorIndex,
  commentAnchorExists,
  commentInputFromSelection,
  failingCommentIdsFromError,
  staleDraftCommentIds,
} from './review-helpers';
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
  return new ApiError('Review submit failed.', 422, '/api/github/reviews', data);
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
      createdAt: '2026-07-05T00:00:00Z',
      updatedAt: '2026-07-05T00:00:00Z',
    })),
  };
}
