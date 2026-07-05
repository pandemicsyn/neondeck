import type { SelectedLineRange } from '@pierre/diffs/react';
import { describe, expect, it } from 'vitest';
import type { GitHubPrReviewDraft } from '../../api';
import {
  buildPatchAnchorIndex,
  commentInputFromSelection,
  staleDraftCommentIds,
} from './review-helpers';

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

  it('normalizes reversed cross-side selections with captured patch order', () => {
    const index = buildPatchAnchorIndex(
      [
        'diff --git a/src/review.ts b/src/review.ts',
        'index 4f74247..9a9f5fd 100644',
        '--- a/src/review.ts',
        '+++ b/src/review.ts',
        '@@ -20,8 +20,9 @@ export function review() {',
        '   const state = readState();',
        '-  const body = state.body;',
        '-  return body.trim();',
        '+  const body = state.body ?? "";',
        '+  const trimmed = body.trim();',
        '+  return trimmed;',
        ' }',
      ].join('\n'),
    );

    expect(
      commentInputFromSelection(
        {
          side: 'additions',
          endSide: 'deletions',
          start: 22,
          end: 21,
        } as SelectedLineRange,
        index,
      ),
    ).toEqual({
      side: 'RIGHT',
      line: 22,
      startLine: 21,
      startSide: 'LEFT',
    });
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
});

function selection(input: { side: 'additions' | 'deletions'; line: number }) {
  return {
    side: input.side,
    start: input.line,
    end: input.line,
  } as SelectedLineRange;
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
