import { describe, expect, it, vi } from 'vitest';
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
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import {
  createImperativeReviewPathJump,
  createPrReviewNavigationData,
  moveReviewCursorFromPath,
  reportOnlyFindingNavigationId,
  resolveHunkTraversal,
  resolveNeonFindingSelection,
  reviewNavigationAnchor,
  reviewNavigationAnnouncement,
  reviewNavigationPublication,
  reviewNavigationPublicationMatches,
  selectedReviewContext,
  type ReviewPatchNavigationState,
} from './review-navigation';
import {
  neonFindingAnnotationId,
  neonFindingNavigationId,
} from './review-findings';

describe('focused PR review navigation wiring', () => {
  it.each([
    ['pending comment', 'src/pending.ts'],
    ['re-anchor flow', 'src/reanchored.ts'],
  ])(
    'clears an explicit cursor before an imperative %s path jump',
    (_label, path) => {
      const calls: string[] = [];
      const controls = {
        setActivePath: vi.fn<(value: string | null) => void>((value) =>
          calls.push(`path:${value ?? 'none'}`),
        ),
        setNavigationAnnouncement: vi.fn<(value: string) => void>(() =>
          calls.push('announcement'),
        ),
        setNavigationAnnotationId: vi.fn<(value: null) => void>(() =>
          calls.push('annotation'),
        ),
        setNavigationAuthority: vi.fn<
          (value: 'automatic' | 'explicit') => void
        >(() => calls.push('authority')),
        setNavigationBoundary: vi.fn<(value: null) => void>(() =>
          calls.push('boundary'),
        ),
        setNavigationSelection: vi.fn<(value: null) => void>(() =>
          calls.push('selection'),
        ),
        setNavigationStatus: vi.fn<(value: null) => void>(() =>
          calls.push('status'),
        ),
        setNavigationTargetKey: vi.fn<(value: null) => void>(() =>
          calls.push('target'),
        ),
        setPendingHunkNavigation: vi.fn<(value: null) => void>(() =>
          calls.push('pending'),
        ),
      };

      createImperativeReviewPathJump(controls)(path);

      expect(controls.setPendingHunkNavigation).toHaveBeenCalledWith(null);
      expect(controls.setNavigationTargetKey).toHaveBeenCalledWith(null);
      expect(controls.setNavigationAuthority).toHaveBeenCalledWith('automatic');
      expect(controls.setNavigationSelection).toHaveBeenCalledWith(null);
      expect(controls.setNavigationAnnotationId).toHaveBeenCalledWith(null);
      expect(controls.setNavigationBoundary).toHaveBeenCalledWith(null);
      expect(controls.setNavigationStatus).toHaveBeenCalledWith(null);
      expect(controls.setActivePath).toHaveBeenCalledWith(path);
      expect(calls.at(-1)).toBe(`path:${path}`);
    },
  );

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
      {
        id: reportOnlyFindingNavigationId(finding(), 0),
        path: 'src/b.ts',
        severity: 'major',
      },
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
    const findingTarget = reviewCursorTargets(data.model, 'finding')[0]!;
    expect(reviewNavigationAnchor(findingTarget, data.anchors)).toEqual({
      annotationId: reportOnlyFindingNavigationId(finding(), 0),
      selection: null,
    });
  });

  it('preserves multi-line and cross-side draft ranges', () => {
    const draft = reviewDraft();
    draft.comments[0] = {
      ...draft.comments[0]!,
      line: 8,
      side: 'RIGHT',
      startLine: 4,
      startSide: 'LEFT',
    };
    const data = createPrReviewNavigationData({
      draft,
      files: reviewFiles(),
      findings: [],
      staleCommentIds: new Set(),
      threads: [],
    });

    expect(
      reviewNavigationAnchor(
        reviewCursorTargets(data.model, 'local-draft')[0]!,
        data.anchors,
      ),
    ).toEqual({
      annotationId: 'draft-a',
      selection: {
        start: 4,
        side: 'deletions',
        end: 8,
        endSide: 'additions',
      },
    });
  });

  it('publishes one cross-file typed finding target for tree, diff, inline annotation, inspector, and surface state', () => {
    const typedFinding = neonFinding();
    const data = createPrReviewNavigationData({
      draft: null,
      files: reviewFiles(),
      findings: [finding()],
      neonFindings: [typedFinding],
      neonFindingResolutions: new Map([
        [
          typedFinding.id,
          {
            state: 'anchored' as const,
            lineNumber: 4,
            side: 'additions' as const,
            selection: {
              side: 'additions',
              start: 4,
              end: 5,
            } as never,
          },
        ],
      ]),
      staleCommentIds: new Set(),
      threads: [],
    });
    const targets = reviewCursorTargets(data.model, 'finding');
    const result = moveReviewCursorFromPath(
      targets,
      targets[0]!.key,
      targets[0]!.path,
      targets[0]!.orderIndex,
      'next',
    );

    expect(result.target).toMatchObject({
      id: neonFindingNavigationId('typed-finding'),
      path: 'src/c.ts',
      severity: 'critical',
    });
    expect(reviewNavigationPublication(result.target!, data.anchors)).toEqual({
      activePath: 'src/c.ts',
      annotationId: neonFindingAnnotationId('typed-finding'),
      selection: {
        path: 'src/c.ts',
        selection: { side: 'additions', start: 4, end: 5 },
      },
    });
  });

  it('keeps stale Neon history out of current finding and attention cursors', () => {
    const active = neonFinding();
    const stale = {
      ...neonFinding(),
      id: 'stale-finding',
      lifecycle: {
        state: 'stale' as const,
        changedAt: '2026-07-18T13:00:00.000Z',
        reason: 'Revision changed.',
      },
    };
    const data = createPrReviewNavigationData({
      draft: null,
      files: reviewFiles(),
      findings: [],
      neonFindings: [active, stale],
      staleCommentIds: new Set(),
      threads: [],
    });

    expect(
      reviewCursorTargets(data.model, 'finding').map(({ id }) => id),
    ).toEqual([neonFindingNavigationId(active.id)]);
    expect(
      reviewCursorTargets(data.model, 'attention').map(({ id }) => id),
    ).toEqual([neonFindingNavigationId(active.id)]);
  });

  it('uses collision-safe typed finding cursor and annotation identities', () => {
    const typed = neonFinding();
    const report = { ...finding(), sourceId: typed.id };
    const thread = { ...reviewThread(), id: typed.id };
    const data = createPrReviewNavigationData({
      draft: null,
      files: reviewFiles(),
      findings: [report],
      neonFindings: [typed],
      neonFindingResolutions: new Map([
        [
          typed.id,
          {
            state: 'anchored' as const,
            lineNumber: 4,
            side: 'additions' as const,
            selection: {
              side: 'additions',
              start: 4,
              end: 5,
            } as never,
          },
        ],
      ]),
      staleCommentIds: new Set(),
      threads: [thread],
    });
    const findingTargets = reviewCursorTargets(data.model, 'finding');
    const typedTarget = findingTargets.find(
      ({ id }) => id === neonFindingNavigationId(typed.id),
    );

    expect(new Set(findingTargets.map(({ key }) => key)).size).toBe(2);
    expect(typedTarget).toBeDefined();
    expect(reviewNavigationAnchor(typedTarget!, data.anchors)).toMatchObject({
      annotationId: neonFindingAnnotationId(typed.id),
    });
    expect(
      reviewNavigationAnchor(
        reviewCursorTargets(data.model, 'review-thread')[0]!,
        data.anchors,
      ),
    ).toMatchObject({ annotationId: typed.id });
  });

  it('resolves an inspector finding outside the active tree filter from the unfiltered cursor', () => {
    const typed = neonFinding();
    const data = createPrReviewNavigationData({
      draft: null,
      files: reviewFiles(),
      findings: [],
      neonFindings: [typed],
      neonFindingResolutions: new Map([
        [
          typed.id,
          {
            state: 'anchored' as const,
            lineNumber: 4,
            side: 'additions' as const,
            selection: {
              side: 'additions',
              start: 4,
              end: 5,
            } as never,
          },
        ],
      ]),
      staleCommentIds: new Set(),
      threads: [],
    });
    const selection = resolveNeonFindingSelection(typed, data.model, [
      'src/a.ts',
    ]);

    expect(selection).toMatchObject({
      filteredOut: true,
      target: {
        id: neonFindingNavigationId(typed.id),
        path: 'src/c.ts',
      },
    });
    expect(
      reviewNavigationPublication(selection!.target, data.anchors),
    ).toEqual({
      activePath: 'src/c.ts',
      annotationId: neonFindingAnnotationId(typed.id),
      selection: {
        path: 'src/c.ts',
        selection: { side: 'additions', start: 4, end: 5 },
      },
    });
  });

  it('uses the deletion side for deletion-only hunk headers', () => {
    const files: DiffFilePatch[] = [
      {
        additions: 0,
        deletions: 2,
        path: 'src/deleted-lines.ts',
        status: 'modified',
        patch: '@@ -20,2 +19,0 @@\n-old\n-lines',
      },
    ];
    const data = createPrReviewNavigationData({
      draft: null,
      files,
      findings: [],
      staleCommentIds: new Set(),
      threads: [],
    });

    expect(
      reviewNavigationAnchor(
        reviewCursorTargets(data.model, 'hunk')[0]!,
        data.anchors,
      ).selection,
    ).toEqual({ start: 20, end: 20, side: 'deletions' });
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

  it('starts filtered hunk traversal at the directional edge when the active path is filtered out', () => {
    const files = reviewFiles().slice(1);
    const data = createPrReviewNavigationData({
      draft: null,
      files,
      findings: [],
      staleCommentIds: new Set(),
      threads: [],
    });
    expect(
      resolveHunkTraversal({
        activePath: 'src/a.ts',
        availability: patchStates({
          'src/b.ts': 'unloaded',
          'src/c.ts': 'loaded',
        }),
        currentKey: null,
        direction: 'next',
        files,
        targets: reviewCursorTargets(data.model, 'hunk'),
      }),
    ).toEqual({ kind: 'load', path: 'src/b.ts' });
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
      target: {
        id: reportOnlyFindingNavigationId(finding(), 0),
        path: 'src/b.ts',
      },
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
      target: {
        id: reportOnlyFindingNavigationId(finding(), 0),
        path: 'src/b.ts',
      },
    });
  });

  it('refreshes the published path and anchor when an exact stable target moves', () => {
    const before = createPrReviewNavigationData({
      draft: reviewDraft(),
      files: reviewFiles(),
      findings: [],
      staleCommentIds: new Set(),
      threads: [],
    });
    const movedDraft = reviewDraft();
    movedDraft.comments[0] = {
      ...movedDraft.comments[0]!,
      path: 'src/c.ts',
      line: 12,
    };
    const after = createPrReviewNavigationData({
      draft: movedDraft,
      files: reviewFiles(),
      findings: [],
      staleCommentIds: new Set(),
      threads: [],
    });
    const oldTarget = reviewCursorTargets(before.model, 'local-draft')[0]!;
    const nextTargets = reviewCursorTargets(after.model, 'local-draft');
    const reconciled = reconcileReviewCursor(
      reviewCursorTargets(before.model, 'local-draft'),
      nextTargets,
      oldTarget.key,
    );
    const publication = reviewNavigationPublication(
      reconciled.target!,
      after.anchors,
    );

    expect(reconciled.resolution).toBe('exact');
    expect(publication).toEqual({
      activePath: 'src/c.ts',
      annotationId: 'draft-a',
      selection: {
        path: 'src/c.ts',
        selection: { start: 12, end: 12, side: 'deletions' },
      },
    });
    expect(
      reviewNavigationPublicationMatches(
        {
          activePath: 'src/a.ts',
          annotationId: 'draft-a',
          selection: {
            path: 'src/a.ts',
            selection: { start: 7, end: 7, side: 'deletions' },
          },
        },
        publication,
      ),
    ).toBe(false);
  });

  it('keeps explicit traversal authoritative while an automatic file cursor leaves a new composer published', () => {
    const composer = {
      annotationId: 'composer-dirty',
      path: 'src/a.ts',
      selection: { start: 4, end: 5, side: 'additions' as const },
    };
    const sameFileSelection = {
      path: 'src/a.ts',
      selection: { start: 20, end: 20, side: 'additions' as const },
    };
    expect(
      selectedReviewContext({
        activePath: 'src/a.ts',
        composer,
        navigationAuthority: 'explicit',
        navigationAnnotationId: 'thread-a',
        navigationSelection: sameFileSelection,
      }),
    ).toEqual({
      selectedAnnotationId: 'thread-a',
      selectedLines: sameFileSelection.selection,
    });

    const crossFileSelection = {
      path: 'src/c.ts',
      selection: { start: 4, end: 4, side: 'additions' as const },
    };
    expect(
      selectedReviewContext({
        activePath: 'src/c.ts',
        composer,
        navigationAuthority: 'explicit',
        navigationAnnotationId: 'thread-c',
        navigationSelection: crossFileSelection,
      }),
    ).toEqual({
      selectedAnnotationId: 'thread-c',
      selectedLines: crossFileSelection.selection,
    });

    expect(
      selectedReviewContext({
        activePath: 'src/a.ts',
        composer,
        navigationAuthority: 'automatic',
        navigationAnnotationId: null,
        navigationSelection: null,
      }),
    ).toEqual({
      selectedAnnotationId: 'composer-dirty',
      selectedLines: composer.selection,
    });

    expect(
      selectedReviewContext({
        activePath: 'src/a.ts',
        composer,
        navigationAuthority: 'explicit',
        navigationAnnotationId: null,
        navigationSelection: null,
      }),
    ).toEqual({
      selectedAnnotationId: null,
      selectedLines: null,
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

function neonFinding(): NeonReviewFinding {
  return {
    schemaVersion: 1,
    id: 'typed-finding',
    surfaceId: 'surface-a',
    sourceId: 'github-pr:example/repo#42',
    revisionKey: 'git-commit::head-sha',
    file: 'src/c.ts',
    anchor: {
      kind: 'line-range',
      side: 'additions',
      startLine: 4,
      endLine: 5,
    },
    title: 'Critical finding',
    explanation: 'The fallback crosses a trust boundary.',
    severity: 'critical',
    confidence: 'high',
    suggestedAction: 'Reject the untrusted input.',
    provenance: {
      authorRole: 'display-assistant',
      model: 'openai/gpt-5',
      workflowRunId: 'run-42',
      createdAt: '2026-07-18T12:00:00.000Z',
    },
    lifecycle: {
      state: 'active',
      changedAt: '2026-07-18T12:00:00.000Z',
      reason: null,
    },
  };
}

function patchStates(values: Record<string, ReviewPatchNavigationState>) {
  return new Map(Object.entries(values));
}
