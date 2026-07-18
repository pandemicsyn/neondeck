import { describe, expect, it } from 'vitest';
import {
  reviewSourceSchemaVersion,
  resolvedReviewRevision,
  reviewRevisionKey,
  type ReviewSourceSnapshot,
} from '../../../../shared/review-source';
import type { ReviewSurfaceNavigationCommand } from '../../../../shared/review-surface';
import {
  createReviewSurfaceSnapshot,
  resolveReviewSurfaceNavigation,
} from './use-review-surface';

describe('review surface context', () => {
  it('publishes bounded focus and selection state without patch bodies', () => {
    const source = reviewSource();
    const snapshot = createReviewSurfaceSnapshot({
      activePath: 'src/app.ts',
      selection: {
        side: 'additions',
        start: 12,
        end: 10,
      },
      selectedAnnotationId: 'draft-2',
      fileFilter: 'src/',
      reviewOrder: ['src/other.ts', 'src/app.ts'],
      source,
      surfaceId: 'surface-1',
    });

    expect(snapshot).toMatchObject({
      surfaceId: 'surface-1',
      activePath: 'src/app.ts',
      selection: {
        path: 'src/app.ts',
        side: 'additions',
        startLine: 10,
        endLine: 12,
      },
      selectedAnnotationId: 'draft-2',
      fileFilter: 'src/',
      reviewOrder: ['src/other.ts', 'src/app.ts'],
      viewMode: 'file',
      presentationMode: 'unified',
    });
    expect(JSON.stringify(snapshot)).not.toContain('@@');
  });

  it('resolves only files from the command revision', () => {
    const surface = createReviewSurfaceSnapshot({
      activePath: 'src/app.ts',
      source: reviewSource(),
      surfaceId: 'surface-1',
    });
    expect(
      resolveReviewSurfaceNavigation(
        surface,
        navigation('src/other.ts', reviewRevisionKey(surface.source.revision)),
      ),
    ).toMatchObject({
      status: 'resolved',
      resolvedPath: 'src/other.ts',
    });
    expect(
      resolveReviewSurfaceNavigation(
        surface,
        navigation(
          'src/missing.ts',
          reviewRevisionKey(surface.source.revision),
        ),
      ),
    ).toMatchObject({
      status: 'target-unavailable',
      resolvedPath: null,
    });
    expect(
      resolveReviewSurfaceNavigation(
        surface,
        navigation('src/app.ts', 'git-commit::older-head'),
      ),
    ).toMatchObject({
      status: 'stale-revision',
      resolvedPath: null,
    });
  });
});

function navigation(
  path: string,
  revisionKey: string | null,
): ReviewSurfaceNavigationCommand {
  return {
    commandId: 'command-1',
    surfaceId: 'surface-1',
    revisionKey,
    target: { path, focus: false },
    requestedAt: '2026-07-18T00:00:00.000Z',
  };
}

function reviewSource(): ReviewSourceSnapshot {
  return {
    schemaVersion: reviewSourceSchemaVersion,
    id: 'github-pr:example/repo#42',
    kind: 'github-pr',
    title: 'Review surface contract',
    revision: resolvedReviewRevision({
      kind: 'git-commit',
      id: 'head-sha',
    }),
    repository: {
      repoId: 'repo-1',
      repoFullName: 'example/repo',
      worktreeId: null,
      localPath: '/tmp/repo',
      localAccess: true,
    },
    files: ['src/app.ts', 'src/other.ts'].map((path) => ({
      path,
      previousPath: null,
      status: 'modified' as const,
      additions: 1,
      deletions: 1,
      generatedLike: false,
      patchState: 'available' as const,
      patchMessage: null,
    })),
    capabilities: ['comments', 'refresh'],
    externalUrl: 'https://github.com/example/repo/pull/42',
  };
}
