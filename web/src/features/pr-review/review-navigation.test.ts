import { describe, expect, it } from 'vitest';
import {
  reconcileReviewCursor,
  reviewCursorTargets,
} from '../../../../shared/review-navigation';
import type {
  GitHubPrReviewDraft,
  GitHubPullRequestReviewThread,
  PrReviewReportOnlyFinding,
} from '../../api';
import type { DiffFilePatch } from '../diff-viewer/types';
import {
  createPrReviewNavigationData,
  moveReviewCursorFromPath,
  resolveHunkTraversal,
  reviewNavigationAnchor,
  reviewNavigationAnnouncement,
  type ReviewPatchNavigationState,
} from './review-navigation';

describe('focused PR review navigation wiring', () => {
  it('builds file, hunk, thread, draft, finding, and attention targets from workbench state', () => {
    const data = createPrReviewNavigationData({
      draft: reviewDraft(),
      files: reviewFiles(),
      findings: [finding()],
      staleCommentIds: new Set(['draft-a']),
      threads: [reviewThread()],
    });

    expect(reviewCursorTargets(data.model, 'file')).toHaveLength(3);
    expect(
      reviewCursorTargets(data.model, 'hunk').map((target) => [
        target.path,
        target.position,
      ]),
    ).toEqual([
      ['src/a.ts', 2],
      ['src/a.ts', 20],
      ['src/c.ts', 4],
    ]);
    expect(reviewCursorTargets(data.model, 'review-thread')).toMatchObject([
      { id: 'thread-a', path: 'src/a.ts', previousPath: 'src/old-a.ts' },
    ]);
    expect(reviewCursorTargets(data.model, 'local-draft')).toMatchObject([
      { id: 'draft-a', stale: true },
    ]);
    expect(reviewCursorTargets(data.model, 'finding')).toMatchObject([
      { id: 'finding-a', path: 'src/b.ts', severity: 'major' },
    ]);
    expect(
      reviewCursorTargets(data.model, 'attention').map(
        (target) => target.attentionKind,
      ),
    ).toEqual(['review-thread', 'local-draft', 'finding']);

    const draftTarget = reviewCursorTargets(data.model, 'local-draft')[0]!;
    expect(reviewNavigationAnchor(draftTarget, data.anchors)).toMatchObject({
      annotationId: 'draft-a',
      selection: { end: 7, side: 'deletions', start: 7 },
    });
    expect(reviewNavigationAnnouncement(draftTarget, 0, 1)).toBe(
      'src/a.ts, local draft, 1 of 1, stale.',
    );
  });

  it('uses the active path for initial traversal and preserves cursor boundaries', () => {
    const data = createPrReviewNavigationData({
      draft: reviewDraft(),
      files: reviewFiles(),
      findings: [finding()],
      staleCommentIds: new Set(),
      threads: [reviewThread()],
    });
    const fileTargets = reviewCursorTargets(data.model, 'file');
    const first = moveReviewCursorFromPath(
      fileTargets,
      null,
      'src/b.ts',
      1,
      'next',
    );
    expect(first).toMatchObject({ target: { path: 'src/b.ts' } });
    expect(
      moveReviewCursorFromPath(
        fileTargets,
        first.target?.key ?? null,
        'src/b.ts',
        1,
        'next',
      ),
    ).toMatchObject({ target: { path: 'src/c.ts' } });
    expect(
      moveReviewCursorFromPath(
        fileTargets,
        fileTargets[0]!.key,
        'src/a.ts',
        0,
        'previous',
      ),
    ).toMatchObject({ boundary: 'start', target: { path: 'src/a.ts' } });
  });

  it('loads cross-file hunk patches one at a time and skips explicit unavailable files', () => {
    const files = reviewFiles();
    const data = createPrReviewNavigationData({
      draft: null,
      files,
      findings: [],
      staleCommentIds: new Set(),
      threads: [],
    });
    const targets = reviewCursorTargets(data.model, 'hunk');
    const availability = patchStates({
      'src/a.ts': 'loaded',
      'src/b.ts': 'unloaded',
      'src/c.ts': 'loaded',
    });
    const lastA = targets
      .filter((target) => target.path === 'src/a.ts')
      .at(-1)!;

    expect(
      resolveHunkTraversal({
        activePath: 'src/a.ts',
        availability,
        currentKey: lastA.key,
        direction: 'next',
        files,
        targets,
      }),
    ).toEqual({ kind: 'load', path: 'src/b.ts' });

    availability.set('src/b.ts', 'unavailable');
    expect(
      resolveHunkTraversal({
        activePath: 'src/b.ts',
        availability,
        currentKey: null,
        direction: 'next',
        files,
        targets,
      }),
    ).toMatchObject({ kind: 'target', target: { path: 'src/c.ts' } });
    expect(
      resolveHunkTraversal({
        activePath: 'src/c.ts',
        availability,
        currentKey: targets.at(-1)!.key,
        direction: 'next',
        files,
        targets,
      }),
    ).toEqual({ boundary: 'end', kind: 'boundary' });
  });

  it('preserves a filtered target and deterministically falls forward when it disappears', () => {
    const data = createPrReviewNavigationData({
      draft: reviewDraft(),
      files: reviewFiles(),
      findings: [finding()],
      staleCommentIds: new Set(),
      threads: [reviewThread()],
    });
    const all = reviewCursorTargets(data.model, 'attention');
    const same = reviewCursorTargets(data.model, 'attention', {
      filter: { paths: ['src/a.ts', 'src/b.ts'] },
    });
    const onlyFinding = reviewCursorTargets(data.model, 'attention', {
      filter: { paths: ['src/b.ts'] },
    });

    expect(reconcileReviewCursor(all, same, all[1]!.key)).toMatchObject({
      resolution: 'exact',
      target: { id: 'draft-a' },
    });
    expect(reconcileReviewCursor(all, onlyFinding, all[1]!.key)).toMatchObject({
      resolution: 'nearest',
      target: { id: 'finding-a', path: 'src/b.ts' },
    });
  });

  it('keeps stable targets across renamed-file revision metadata and falls back after removal', () => {
    const before = createPrReviewNavigationData({
      draft: reviewDraft(),
      files: reviewFiles(),
      findings: [finding()],
      staleCommentIds: new Set(),
      threads: [reviewThread()],
    });
    const renamedFiles = reviewFiles().map((file) =>
      file.path === 'src/a.ts'
        ? { ...file, path: 'src/renamed-a.ts', previousPath: 'src/a.ts' }
        : file,
    );
    const afterRename = createPrReviewNavigationData({
      draft: {
        ...reviewDraft(),
        headSha: 'new-head-sha',
        comments: reviewDraft().comments.map((comment) => ({
          ...comment,
          path: 'src/renamed-a.ts',
        })),
      },
      files: renamedFiles,
      findings: [finding()],
      staleCommentIds: new Set(),
      threads: [
        {
          ...reviewThread(),
          path: 'src/a.ts',
        },
      ],
    });
    const oldTargets = reviewCursorTargets(before.model, 'review-thread');
    const renamedTargets = reviewCursorTargets(
      afterRename.model,
      'review-thread',
    );

    expect(
      reconcileReviewCursor(oldTargets, renamedTargets, oldTargets[0]!.key),
    ).toMatchObject({
      resolution: 'exact',
      target: {
        id: 'thread-a',
        path: 'src/renamed-a.ts',
        previousPath: 'src/a.ts',
      },
    });

    const afterRemoval = createPrReviewNavigationData({
      draft: null,
      files: renamedFiles,
      findings: [finding()],
      staleCommentIds: new Set(),
      threads: [],
    });
    expect(
      reconcileReviewCursor(
        reviewCursorTargets(afterRename.model, 'attention'),
        reviewCursorTargets(afterRemoval.model, 'attention'),
        `attention:review-thread:thread-a`,
      ),
    ).toMatchObject({
      resolution: 'nearest',
      target: { id: 'finding-a', path: 'src/b.ts' },
    });
  });

  it('builds a 305-file cursor from metadata while parsing hunks only for loaded patches', () => {
    const files: DiffFilePatch[] = Array.from({ length: 305 }, (_, index) => ({
      additions: 1,
      deletions: 1,
      path: `src/fixture-${String(index).padStart(3, '0')}.ts`,
      status: 'modified',
      ...(index === 0 ? { patch: '@@ -1 +1 @@\n-old\n+new' } : {}),
    }));
    const data = createPrReviewNavigationData({
      draft: null,
      files,
      findings: [],
      staleCommentIds: new Set(),
      threads: [],
    });

    expect(reviewCursorTargets(data.model, 'file')).toHaveLength(305);
    expect(reviewCursorTargets(data.model, 'hunk')).toMatchObject([
      { path: 'src/fixture-000.ts', position: 1 },
    ]);
  });
});

function reviewFiles(): DiffFilePatch[] {
  return [
    {
      additions: 4,
      deletions: 2,
      path: 'src/a.ts',
      previousPath: 'src/old-a.ts',
      status: 'modified',
      patch: [
        'diff --git a/src/a.ts b/src/a.ts',
        '@@ -2,2 +2,3 @@ function first()',
        '-old',
        '+new',
        '@@ -18,2 +20,3 @@ function second()',
        '-old two',
        '+new two',
      ].join('\n'),
    },
    {
      additions: 1,
      deletions: 1,
      path: 'src/b.ts',
      status: 'modified',
    },
    {
      additions: 1,
      deletions: 1,
      path: 'src/c.ts',
      status: 'modified',
      patch: [
        'diff --git a/src/c.ts b/src/c.ts',
        '@@ -4 +4 @@',
        '-old',
        '+new',
      ].join('\n'),
    },
  ];
}

function reviewDraft(): GitHubPrReviewDraft {
  return {
    id: 'draft-1',
    repo: 'example/repo',
    prNumber: 42,
    headSha: 'head-sha',
    verdict: 'comment',
    body: null,
    status: 'draft',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    submittedAt: null,
    comments: [
      {
        id: 'draft-a',
        draftId: 'draft-1',
        path: 'src/a.ts',
        body: 'Keep the fallback explicit.',
        side: 'LEFT',
        line: 7,
        startLine: null,
        startSide: null,
        origin: 'human',
        sourceFindingId: null,
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
    ],
  };
}

function reviewThread(): GitHubPullRequestReviewThread {
  return {
    id: 'thread-a',
    isResolved: false,
    isOutdated: false,
    path: 'src/old-a.ts',
    line: 5,
    originalLine: 5,
    diffSide: 'RIGHT',
    pullRequestRepo: 'example/repo',
    pullRequestNumber: 42,
    comments: [],
  };
}

function finding(): PrReviewReportOnlyFinding {
  return {
    sourceId: 'finding-a',
    severity: 'major',
    path: 'src/b.ts',
    line: 3,
    summary: 'Unsafe fallback',
    suggestedFix: 'Return an explicit result.',
    reason: 'unanchorable',
  };
}

function patchStates(values: Record<string, ReviewPatchNavigationState>) {
  return new Map(Object.entries(values));
}
