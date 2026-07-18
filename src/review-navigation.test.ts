import { describe, expect, it } from 'vitest';
import {
  createReviewNavigationModel,
  moveReviewCursor,
  reconcileReviewCursor,
  reviewCursorTargets,
  type ReviewNavigationInput,
} from '../shared/review-navigation';

describe('review navigation model', () => {
  it('keeps canonical order while resolving a complete guided projection', () => {
    const model = createReviewNavigationModel({
      files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }],
      guidedOrder: ['src/c.ts', 'src/c.ts', 'missing.ts'],
    });

    expect(model.canonicalFilePaths).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
    expect(model.guidedFilePaths).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts']);
    expect(
      reviewCursorTargets(model, 'file', { order: 'guided' }).map(
        (target) => target.path,
      ),
    ).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts']);
  });

  it('normalizes file, hunk, thread, draft, finding, and attention targets', () => {
    const model = createReviewNavigationModel(fixture());

    expect(reviewCursorTargets(model, 'file')).toHaveLength(3);
    expect(
      reviewCursorTargets(model, 'hunk').map((target) => target.id),
    ).toEqual(['hunk-a-1', 'hunk-a-2']);
    expect(
      reviewCursorTargets(model, 'review-thread').map((target) => target.id),
    ).toEqual(['thread-a']);
    expect(
      reviewCursorTargets(model, 'local-draft').map((target) => target.id),
    ).toEqual(['draft-a', 'draft-b']);
    expect(
      reviewCursorTargets(model, 'finding').map((target) => target.id),
    ).toEqual(['finding-a']);
    expect(
      reviewCursorTargets(model, 'attention').map((target) => [
        target.attentionKind,
        target.id,
      ]),
    ).toEqual([
      ['review-thread', 'thread-a'],
      ['local-draft', 'draft-a'],
      ['finding', 'finding-a'],
      ['local-draft', 'draft-b'],
    ]);
  });

  it('deduplicates files and target identities deterministically', () => {
    const model = createReviewNavigationModel({
      files: [
        { path: 'src/a.ts' },
        { path: 'src/a.ts', previousPath: 'src/old-a.ts' },
      ],
      items: [
        { kind: 'local-draft', id: 'draft-1', path: 'src/a.ts', line: 8 },
        { kind: 'local-draft', id: 'draft-1', path: 'src/a.ts', line: 2 },
      ],
    });

    expect(model.canonicalFilePaths).toEqual(['src/a.ts']);
    expect(reviewCursorTargets(model, 'local-draft')).toMatchObject([
      { id: 'draft-1', position: 8 },
    ]);
  });

  it('resolves targets on previous paths to renamed files', () => {
    const model = createReviewNavigationModel({
      files: [{ path: 'src/new.ts', previousPath: 'src/old.ts' }],
      guidedOrder: ['src/old.ts'],
      items: [
        {
          kind: 'review-thread',
          id: 'thread-old',
          path: 'src/old.ts',
          line: 4,
        },
      ],
    });
    const target = reviewCursorTargets(model, 'review-thread')[0];

    expect(model.guidedFilePaths).toEqual(['src/new.ts']);
    expect(target).toMatchObject({
      missing: false,
      path: 'src/new.ts',
      previousPath: 'src/old.ts',
      requestedPath: 'src/old.ts',
      stale: false,
    });
  });

  it('reconciles a renamed file cursor through its previous path', () => {
    const before = createReviewNavigationModel({
      files: [{ path: 'src/old.ts' }],
    });
    const after = createReviewNavigationModel({
      files: [{ path: 'src/new.ts', previousPath: 'src/old.ts' }],
    });

    expect(
      reconcileReviewCursor(
        reviewCursorTargets(before, 'file'),
        reviewCursorTargets(after, 'file'),
        'file:src/old.ts',
      ),
    ).toMatchObject({
      resolution: 'nearest',
      target: { path: 'src/new.ts', previousPath: 'src/old.ts' },
    });
  });

  it('retains removed-file targets as unavailable without navigating to them', () => {
    const model = createReviewNavigationModel({
      files: [{ path: 'src/live.ts' }],
      items: [
        {
          kind: 'finding',
          id: 'removed-finding',
          path: 'src/removed.ts',
          severity: 'major',
        },
      ],
    });

    expect(reviewCursorTargets(model, 'finding')).toEqual([]);
    expect(model.unavailableTargets).toMatchObject([
      {
        id: 'removed-finding',
        missing: true,
        stale: true,
      },
    ]);
    expect(
      reviewCursorTargets(model, 'finding', {
        filter: { includeMissing: true },
      }),
    ).toHaveLength(1);
  });

  it('filters by current path, previous path, summary, kind, and stale state', () => {
    const model = createReviewNavigationModel(fixture());

    expect(
      reviewCursorTargets(model, 'finding', {
        filter: { query: 'unsafe fallback' },
      }).map((target) => target.id),
    ).toEqual(['finding-a']);
    expect(
      reviewCursorTargets(model, 'attention', {
        filter: { query: 'src/old-a.ts' },
      }).map((target) => target.id),
    ).toEqual(['thread-a', 'draft-a', 'finding-a']);
    expect(
      reviewCursorTargets(model, 'local-draft', {
        filter: { includeStale: false },
      }).map((target) => target.id),
    ).toEqual(['draft-a']);
    expect(
      reviewCursorTargets(model, 'local-draft').find(
        (target) => target.id === 'draft-b',
      ),
    ).toMatchObject({ stale: true });
    expect(
      reviewCursorTargets(model, 'attention', {
        filter: { kinds: ['finding'] },
      }).map((target) => target.id),
    ).toEqual(['finding-a']);
  });

  it('moves deterministically at empty, initial, previous, next, and boundary states', () => {
    const targets = reviewCursorTargets(
      createReviewNavigationModel(fixture()),
      'hunk',
    );

    expect(moveReviewCursor([], null, 'next')).toMatchObject({
      boundary: null,
      resolution: 'empty',
      target: null,
    });
    expect(moveReviewCursor(targets, null, 'next')).toMatchObject({
      index: 0,
      resolution: 'initial',
      target: { id: 'hunk-a-1' },
    });
    expect(moveReviewCursor(targets, null, 'previous')).toMatchObject({
      index: 1,
      target: { id: 'hunk-a-2' },
    });
    expect(moveReviewCursor(targets, targets[0] ?? null, 'next')).toMatchObject(
      {
        boundary: null,
        index: 1,
        target: { id: 'hunk-a-2' },
      },
    );
    expect(
      moveReviewCursor(targets, targets[0] ?? null, 'previous'),
    ).toMatchObject({
      boundary: 'start',
      index: 0,
    });
    expect(moveReviewCursor(targets, targets[1] ?? null, 'next')).toMatchObject(
      {
        boundary: 'end',
        index: 1,
      },
    );
  });

  it('uses the nearest following target when a stale current target is missing', () => {
    const model = createReviewNavigationModel({
      files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
      items: [
        { kind: 'local-draft', id: 'draft-a', path: 'src/a.ts', line: 10 },
        { kind: 'local-draft', id: 'draft-b', path: 'src/a.ts', line: 20 },
        { kind: 'local-draft', id: 'draft-c', path: 'src/b.ts', line: 1 },
      ],
    });
    const targets = reviewCursorTargets(model, 'local-draft');
    const staleAnchor = {
      ...targets[0]!,
      key: 'local-draft:removed',
      position: 15,
    };

    expect(moveReviewCursor(targets, staleAnchor, 'next')).toMatchObject({
      resolution: 'nearest',
      target: { id: 'draft-b' },
    });
  });

  it('preserves exact targets across filtering and falls back to the nearest remaining target', () => {
    const model = createReviewNavigationModel(fixture());
    const allTargets = reviewCursorTargets(model, 'attention');
    const filteredTargets = reviewCursorTargets(model, 'attention', {
      filter: { paths: ['src/b.ts'] },
    });

    expect(
      reconcileReviewCursor(
        allTargets,
        allTargets,
        'attention:local-draft:draft-a',
      ),
    ).toMatchObject({
      resolution: 'exact',
      target: { id: 'draft-a' },
    });
    expect(
      reconcileReviewCursor(
        allTargets,
        filteredTargets,
        'attention:finding:finding-a',
      ),
    ).toMatchObject({
      resolution: 'nearest',
      target: { id: 'draft-b', path: 'src/b.ts' },
    });
  });

  it('falls forward to a neighboring file when the active file is removed', () => {
    const before = createReviewNavigationModel({
      files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/c.ts' }],
    });
    const after = createReviewNavigationModel({
      files: [{ path: 'src/a.ts' }, { path: 'src/c.ts' }],
    });
    const previousTargets = reviewCursorTargets(before, 'file');
    const nextTargets = reviewCursorTargets(after, 'file');

    expect(
      reconcileReviewCursor(previousTargets, nextTargets, 'file:src/b.ts'),
    ).toMatchObject({
      resolution: 'nearest',
      target: { path: 'src/c.ts' },
    });
  });
});

function fixture(): ReviewNavigationInput {
  return {
    files: [
      { path: 'src/a.ts', previousPath: 'src/old-a.ts' },
      { path: 'src/b.ts' },
      { path: 'src/deleted.ts' },
    ],
    items: [
      {
        kind: 'hunk',
        id: 'hunk-a-2',
        path: 'src/a.ts',
        newStart: 20,
      },
      {
        kind: 'hunk',
        id: 'hunk-a-1',
        path: 'src/a.ts',
        newStart: 4,
      },
      {
        kind: 'review-thread',
        id: 'thread-a',
        path: 'src/old-a.ts',
        line: 5,
      },
      {
        kind: 'review-thread',
        id: 'resolved-thread',
        path: 'src/a.ts',
        line: 6,
        resolved: true,
      },
      {
        kind: 'local-draft',
        id: 'draft-a',
        path: 'src/a.ts',
        line: 7,
      },
      {
        kind: 'finding',
        id: 'finding-a',
        path: 'src/a.ts',
        line: 8,
        severity: 'critical',
        summary: 'Unsafe fallback can erase data',
      },
      {
        kind: 'local-draft',
        id: 'draft-b',
        path: 'src/b.ts',
        line: 3,
        stale: true,
      },
    ],
  };
}
