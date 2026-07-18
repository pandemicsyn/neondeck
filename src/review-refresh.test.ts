import { describe, expect, it } from 'vitest';
import {
  createReviewNavigationModel,
  reviewCursorTargets,
} from '../shared/review-navigation';
import {
  assertReviewRevisionCurrent,
  canExplicitlyApplyReviewRefresh,
  evaluateReviewRefreshSafety,
  reconcileReviewOrientation,
  reviewSourceRevisionEventMatches,
} from '../shared/review-refresh';
import {
  resolvedReviewRevision,
  reviewSourceSchemaVersion,
  type ReviewFileMetadata,
  type ReviewSourceSnapshot,
} from '../shared/review-source';

describe('review revision refresh contract', () => {
  it('accepts only the mounted revision and rejects a late response', () => {
    const mounted = resolvedReviewRevision({
      kind: 'git-commit',
      id: 'head-b',
      baseId: 'base',
    });
    const late = resolvedReviewRevision({
      kind: 'git-commit',
      id: 'head-a',
      baseId: 'base',
    });
    expect(() =>
      assertReviewRevisionCurrent('git-commit:base:head-b', mounted),
    ).not.toThrow();
    expect(() =>
      assertReviewRevisionCurrent('git-commit:base:head-b', late),
    ).toThrow('review source changed');
  });

  it('permits automatic application only for a provably clean surface', () => {
    expect(evaluateReviewRefreshSafety({})).toEqual({
      safe: true,
      reasons: [],
    });
    expect(
      evaluateReviewRefreshSafety({
        dirtyEditor: true,
        activeSelection: true,
        staleDraft: true,
        reanchorActive: true,
        revisionConfirmationOpen: true,
        mutationPending: true,
      }),
    ).toEqual({
      safe: false,
      reasons: [
        'dirty-editor',
        'active-selection',
        'stale-draft',
        'reanchor-active',
        'revision-confirmation-open',
        'mutation-pending',
      ],
    });
  });

  it('allows explicit application for preserved selection and stale-draft state only', () => {
    expect(
      canExplicitlyApplyReviewRefresh(
        evaluateReviewRefreshSafety({
          activeSelection: true,
          staleDraft: true,
        }),
      ),
    ).toBe(true);
    expect(
      canExplicitlyApplyReviewRefresh(
        evaluateReviewRefreshSafety({ dirtyEditor: true }),
      ),
    ).toBe(false);
    expect(
      canExplicitlyApplyReviewRefresh(
        evaluateReviewRefreshSafety({ mutationPending: true }),
      ),
    ).toBe(false);
  });

  it('preserves an exact path and degrades through a proven rename', () => {
    expect(
      reconcileReviewOrientation({
        previousFiles: files('a.ts', 'b.ts'),
        nextFiles: files('a.ts', 'b.ts'),
        activePath: 'b.ts',
      }),
    ).toMatchObject({ status: 'preserved', activePath: 'b.ts' });

    expect(
      reconcileReviewOrientation({
        previousFiles: files('a.ts', 'b.ts'),
        nextFiles: [file('a.ts'), file('renamed.ts', 'b.ts')],
        activePath: 'b.ts',
      }),
    ).toMatchObject({ status: 'degraded', activePath: 'renamed.ts' });
  });

  it('chooses the deterministic nearest review-order neighbor when a file disappears', () => {
    expect(
      reconcileReviewOrientation({
        previousFiles: files('a.ts', 'b.ts', 'c.ts', 'd.ts'),
        nextFiles: files('a.ts', 'c.ts', 'd.ts'),
        previousOrder: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        nextOrder: ['a.ts', 'c.ts', 'd.ts'],
        activePath: 'b.ts',
      }),
    ).toMatchObject({ status: 'degraded', activePath: 'c.ts' });
  });

  it('resolves a removed hunk or finding to the nearest remaining target', () => {
    const previous = createReviewNavigationModel({
      files: files('a.ts', 'b.ts'),
      items: [
        { kind: 'hunk', id: 'old-hunk', path: 'a.ts', newStart: 10 },
        { kind: 'finding', id: 'old-finding', path: 'a.ts', line: 12 },
      ],
    });
    const next = createReviewNavigationModel({
      files: files('a.ts', 'b.ts'),
      items: [
        { kind: 'hunk', id: 'next-hunk', path: 'a.ts', newStart: 20 },
        { kind: 'finding', id: 'next-finding', path: 'a.ts', line: 22 },
      ],
    });
    const previousTargets = reviewCursorTargets(previous, 'hunk');
    const nextTargets = reviewCursorTargets(next, 'hunk');
    expect(
      reconcileReviewOrientation({
        previousFiles: files('a.ts', 'b.ts'),
        nextFiles: files('a.ts', 'b.ts'),
        activePath: 'a.ts',
        previousTargets,
        nextTargets,
        currentTargetKey: previousTargets[0]!.key,
      }),
    ).toMatchObject({
      status: 'degraded',
      target: { id: 'next-hunk', path: 'a.ts' },
    });

    const previousFindings = reviewCursorTargets(previous, 'finding');
    const nextFindings = reviewCursorTargets(next, 'finding');
    expect(
      reconcileReviewOrientation({
        previousFiles: files('a.ts', 'b.ts'),
        nextFiles: files('a.ts', 'b.ts'),
        activePath: 'a.ts',
        previousTargets: previousFindings,
        nextTargets: nextFindings,
        currentTargetKey: previousFindings[0]!.key,
      }),
    ).toMatchObject({
      status: 'degraded',
      target: { id: 'next-finding', path: 'a.ts' },
    });
  });

  it('reports failure when no useful refreshed target remains', () => {
    expect(
      reconcileReviewOrientation({
        previousFiles: files('a.ts'),
        nextFiles: [],
        activePath: 'a.ts',
      }),
    ).toEqual({
      status: 'failed',
      activePath: null,
      target: null,
      message: 'The refreshed revision has no reviewable files.',
    });
  });

  it('routes source events to the intended revision family and keeps concurrent surfaces independent', () => {
    const first = source('prepared-diff:first', 'worktree-1');
    const second = source('prepared-diff:second', 'worktree-2');
    const event = {
      id: 'event-1',
      action: 'source-changed' as const,
      source: {
        id: null,
        kind: 'prepared-diff' as const,
        repoId: 'repo-1',
        repoFullName: 'owner/repo',
        worktreeId: 'worktree-1',
        prNumber: null,
      },
      revision: null,
      changedAt: '2026-07-18T00:00:00.000Z',
      reason: 'Worktree changed.',
    };
    expect(reviewSourceRevisionEventMatches(first, event)).toBe(true);
    expect(reviewSourceRevisionEventMatches(second, event)).toBe(false);
  });

  it('routes a PR-only event through the declared GitHub promotion target', () => {
    const github = source('github-pr:owner/repo#42', 'worktree-1');
    github.kind = 'github-pr';
    github.promotionTargets = [
      {
        destination: 'github-review-draft',
        repoFullName: 'owner/repo',
        prNumber: 42,
      },
    ];
    expect(
      reviewSourceRevisionEventMatches(github, {
        id: 'event-pr',
        action: 'revision-available',
        source: {
          id: null,
          kind: null,
          repoId: null,
          repoFullName: null,
          worktreeId: null,
          prNumber: 42,
        },
        revision: null,
        changedAt: '2026-07-18T00:00:00.000Z',
        reason: 'PR head changed.',
      }),
    ).toBe(true);
  });
});

function files(...paths: string[]) {
  return paths.map((path) => file(path));
}

function file(
  path: string,
  previousPath: string | null = null,
): ReviewFileMetadata {
  return {
    path,
    previousPath,
    status: previousPath ? 'renamed' : 'modified',
    additions: 1,
    deletions: 1,
    generatedLike: false,
    patchState: 'unloaded',
    patchMessage: null,
  };
}

function source(id: string, worktreeId: string): ReviewSourceSnapshot {
  return {
    schemaVersion: reviewSourceSchemaVersion,
    id,
    kind: 'prepared-diff',
    title: id,
    revision: resolvedReviewRevision({
      kind: 'worktree-diff',
      id: `revision-${worktreeId}`,
    }),
    repository: {
      repoId: 'repo-1',
      repoFullName: 'owner/repo',
      worktreeId,
      localPath: `/tmp/${worktreeId}`,
      localAccess: true,
    },
    files: files('a.ts'),
    capabilities: ['refresh'],
    promotionTargets: [],
    externalUrl: null,
  };
}
