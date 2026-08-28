import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishReviewTourPresentation,
  readBoundPrReviewTour,
  replacePrReviewTour,
} from './modules/pr-review-tours';
import type { PrReviewTourServiceDependencies } from './modules/pr-review-tours';
import type { PrReviewRecord } from './modules/pr-reviews';
import type { ReviewSurfaceChangeEvent } from '../shared/review-surface';
import { initializeAppDatabase } from './runtime-home/app-db';
import { runtimePaths } from './runtime-home';

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe('PR review guided tours', () => {
  it('atomically replaces one exact-revision tour and increments generation', async () => {
    const { paths, review } = await fixture();
    const publishEvent = vi.fn<(event: unknown) => void>();
    const first = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('First tour'),
      provenance('call-1'),
      paths,
      {
        readReview: () => review,
        loadFiles: async () => changedFiles(),
        publishEvent,
      },
    );
    const second = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Replacement tour'),
      provenance('call-2'),
      paths,
      {
        readReview: () => review,
        loadFiles: async () => changedFiles(),
        publishEvent,
      },
    );

    expect(first).toMatchObject({ ok: true, changed: true });
    expect(second).toMatchObject({
      ok: true,
      changed: true,
      tour: { title: 'Replacement tour', generation: 2 },
    });
    expect(
      readBoundPrReviewTour(review.id, review.headSha, paths),
    ).toMatchObject({
      title: 'Replacement tour',
      generation: 2,
      steps: [{ ordinal: 1 }, { ordinal: 2 }],
    });
    expect(publishEvent).toHaveBeenCalledTimes(2);
  });

  it('preserves the current tour when any replacement anchor is invalid', async () => {
    const { paths, review } = await fixture();
    await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Valid tour'),
      provenance('call-1'),
      paths,
      { readReview: () => review, loadFiles: async () => changedFiles() },
    );
    const invalid = tourDraft('Invalid replacement');
    invalid.steps[1]!.endLine = 99;

    await expect(
      replacePrReviewTour(
        { reviewId: review.id, headSha: review.headSha },
        invalid,
        provenance('call-2'),
        paths,
        { readReview: () => review, loadFiles: async () => changedFiles() },
      ),
    ).resolves.toMatchObject({
      ok: false,
      changed: false,
      requires: ['visiblePatchAnchor'],
    });
    expect(
      readBoundPrReviewTour(review.id, review.headSha, paths),
    ).toMatchObject({ title: 'Valid tour', generation: 1 });
  });

  it('accepts changed content that resembles unified-diff file headers', async () => {
    const { paths, review } = await fixture();
    const result = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      {
        title: 'Header-like content',
        summary: 'Changed Markdown and operator lines remain addressable.',
        sourceFindingId: null,
        steps: [
          {
            key: 'rule',
            file: 'README.md',
            side: 'deletions',
            startLine: 2,
            endLine: 2,
            symbol: null,
            explanation: 'The deleted rule starts with three hyphens.',
          },
          {
            key: 'operator',
            file: 'README.md',
            side: 'additions',
            startLine: 5,
            endLine: 5,
            symbol: null,
            explanation: 'The added content starts with three plus signs.',
          },
        ],
      },
      provenance('call-headers'),
      paths,
      {
        readReview: () => review,
        loadFiles: async () => [
          {
            path: 'README.md',
            patch: '@@ -1,3 +4,3 @@\n context\n---\n-old\n+++value\n+new',
            binary: false,
            truncated: false,
          },
        ],
      },
    );

    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it('accepts anchors in a newly added file whose old hunk starts at zero', async () => {
    const { paths, review } = await fixture();
    const result = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      {
        title: 'Added file',
        summary: 'New-file lines remain addressable.',
        sourceFindingId: null,
        steps: [
          {
            key: 'new-line',
            file: 'src/new.ts',
            side: 'additions',
            startLine: 1,
            endLine: 2,
            symbol: null,
            explanation: 'Both added lines are visible.',
          },
        ],
      },
      provenance('call-added-file'),
      paths,
      {
        readReview: () => review,
        loadFiles: async () => [
          {
            path: 'src/new.ts',
            patch:
              'diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+first\n+second',
            binary: false,
            truncated: false,
          },
        ],
      },
    );

    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it('deduplicates a recovered durable tool call without replacing newer work', async () => {
    const { paths, review } = await fixture();
    const dependencies = {
      readReview: () => review,
      loadFiles: async () => changedFiles(),
    };
    const original = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Original'),
      provenance('call-1'),
      paths,
      dependencies,
    );
    await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Newer'),
      provenance('call-2'),
      paths,
      dependencies,
    );
    const replay = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Original'),
      provenance('call-1'),
      paths,
      {
        readReview: () => ({ ...review, status: 'submitted' as const }),
        loadFiles: async () => {
          throw new Error('A replay must not re-read patches.');
        },
      },
    );

    expect(replay).toMatchObject({
      ok: true,
      changed: false,
      tour: { id: original.tour?.id, generation: 1 },
    });
    expect(
      readBoundPrReviewTour(review.id, review.headSha, paths),
    ).toMatchObject({ title: 'Newer', generation: 2 });
  });

  it('rejects a stale or non-ready bound review', async () => {
    const { paths, review } = await fixture();
    const dependencies = {
      readReview: () => review,
      loadFiles: async () => changedFiles(),
    };
    await expect(
      replacePrReviewTour(
        { reviewId: review.id, headSha: 'older-head' },
        tourDraft('Stale'),
        provenance('call-stale'),
        paths,
        dependencies,
      ),
    ).resolves.toMatchObject({
      ok: false,
      requires: ['currentReviewRevision'],
    });
    await expect(
      replacePrReviewTour(
        { reviewId: review.id, headSha: review.headSha },
        tourDraft('Submitted'),
        provenance('call-submitted'),
        paths,
        {
          ...dependencies,
          readReview: () => ({ ...review, status: 'submitted' as const }),
        },
      ),
    ).resolves.toMatchObject({ ok: false, requires: ['readyReview'] });
  });

  it('rechecks the revision binding inside the replacement transaction', async () => {
    const { paths, review } = await fixture();
    let current: PrReviewRecord = review;

    const result = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Racing replacement'),
      provenance('call-racing'),
      paths,
      {
        readReview: () => current,
        loadFiles: async () => {
          current = { ...review, status: 'submitted' };
          return changedFiles();
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      requires: ['readyReview'],
    });
    expect(readBoundPrReviewTour(review.id, review.headSha, paths)).toBeNull();
  });

  it('rejects a same-head replacement when the base revision changes in flight', async () => {
    const { paths, review } = await fixture();
    let current: PrReviewRecord = review;

    const result = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Base-racing replacement'),
      provenance('call-base-racing'),
      paths,
      {
        readReview: () => current,
        loadFiles: async () => {
          current = { ...review, baseSha: 'newer-base', status: 'ready' };
          return changedFiles();
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      requires: ['currentReviewRevision'],
    });
    expect(readBoundPrReviewTour(review.id, review.headSha, paths)).toBeNull();
  });

  it('publishes presentation changes only for the matching active PR surface', async () => {
    const { paths, review } = await fixture();
    const result = await replacePrReviewTour(
      { reviewId: review.id, headSha: review.headSha },
      tourDraft('Surface-bound tour'),
      provenance('call-surface'),
      paths,
      { readReview: () => review, loadFiles: async () => changedFiles() },
    );
    const tour = result.tour!;
    const event = {
      action: 'tour-activated' as const,
      surfaceId: 'surface-1',
      tourId: tour.id,
      generation: tour.generation,
      stepId: tour.steps[0]!.id,
      requestId: 'presentation-1',
    };
    const publishEvent = vi.fn<(event: unknown) => void>();
    const navigateSurface = vi.fn<
      NonNullable<PrReviewTourServiceDependencies['navigateSurface']>
    >((surfaceId, request) => ({
      ...request,
      commandId: 'navigation-1',
      requestedAt: '2026-08-27T00:00:00.000Z',
      surfaceId,
    }));
    const surfaceListeners: Array<
      Parameters<
        NonNullable<PrReviewTourServiceDependencies['subscribeSurfaceEvents']>
      >[0]
    > = [];
    const unsubscribeSurfaceEvents = vi.fn<() => void>();
    const subscribeSurfaceEvents = vi.fn<
      NonNullable<PrReviewTourServiceDependencies['subscribeSurfaceEvents']>
    >((listener) => {
      surfaceListeners.push(listener);
      return unsubscribeSurfaceEvents;
    });
    const readMatchingSurface = () =>
      ({
        source: {
          id: 'github-pr:owner/repo#1',
          kind: 'github-pr',
          repository: { repoFullName: review.repoFullName.toUpperCase() },
          revision: {
            state: 'resolved',
            kind: 'git-commit',
            id: review.headSha,
            baseId: review.baseSha,
          },
        },
      }) as never;

    expect(
      publishReviewTourPresentation(event, paths, {
        readReview: () => review,
        readSurface: () => null,
        publishEvent,
      }),
    ).toBe(false);
    expect(
      publishReviewTourPresentation(event, paths, {
        readReview: () => ({ ...review, baseSha: 'newer-base' }),
        readSurface: () =>
          ({
            source: {
              id: 'github-pr:owner/repo#1',
              kind: 'github-pr',
              repository: { repoFullName: review.repoFullName },
              revision: {
                state: 'resolved',
                kind: 'git-commit',
                id: review.headSha,
                baseId: review.baseSha,
              },
            },
          }) as never,
        publishEvent,
      }),
    ).toBe(false);
    expect(
      publishReviewTourPresentation(event, paths, {
        readReview: () => review,
        readSurface: () =>
          ({
            source: {
              id: 'github-pr:someone/else#1',
              kind: 'github-pr',
              repository: { repoFullName: 'someone/else' },
              revision: {
                state: 'resolved',
                kind: 'git-commit',
                id: review.headSha,
                baseId: review.baseSha,
              },
            },
          }) as never,
        publishEvent,
      }),
    ).toBe(false);
    expect(
      publishReviewTourPresentation(event, paths, {
        readReview: () => review,
        readSurface: readMatchingSurface,
        navigateSurface,
        publishEvent,
        subscribeSurfaceEvents,
      }),
    ).toBe(true);
    expect(navigateSurface).toHaveBeenCalledWith('surface-1', {
      revisionKey: tour.revisionKey,
      target: {
        path: tour.steps[0]!.file,
        focus: true,
        anchor: {
          side: tour.steps[0]!.anchor.side,
          startLine: tour.steps[0]!.anchor.startLine,
          endLine: tour.steps[0]!.anchor.endLine,
        },
        annotationId: JSON.stringify(['tour-step', tour.steps[0]!.id]),
        correlationId: 'presentation-1',
      },
    });
    expect(publishEvent).not.toHaveBeenCalled();
    surfaceListeners[0]!(
      surfaceChangeEvent('acknowledged', {
        commandId: 'navigation-1',
        surfaceId: 'surface-1',
        status: 'resolved',
        revisionKey: tour.revisionKey,
        resolvedPath: tour.steps[0]!.file,
        message: null,
        acknowledgedAt: '2026-08-27T00:00:01.000Z',
      }),
    );
    expect(unsubscribeSurfaceEvents).toHaveBeenCalledOnce();
    expect(publishEvent).toHaveBeenCalledTimes(1);

    expect(
      publishReviewTourPresentation(event, paths, {
        readReview: () => review,
        readSurface: readMatchingSurface,
        navigateSurface,
        publishEvent,
        subscribeSurfaceEvents,
      }),
    ).toBe(true);
    surfaceListeners[1]!(
      surfaceChangeEvent('acknowledged', {
        commandId: 'navigation-1',
        surfaceId: 'surface-1',
        status: 'target-unavailable',
        revisionKey: tour.revisionKey,
        resolvedPath: null,
        message: 'The tour annotation is unavailable.',
        acknowledgedAt: '2026-08-27T00:00:02.000Z',
      }),
    );
    expect(unsubscribeSurfaceEvents).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenCalledTimes(2);
    expect(publishEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'tour-activation-failed',
        requestId: 'presentation-1',
        status: 'target-unavailable',
      }),
    );
  });
});

function surfaceChangeEvent(
  action: ReviewSurfaceChangeEvent['action'],
  acknowledgement: ReviewSurfaceChangeEvent['acknowledgement'],
): ReviewSurfaceChangeEvent {
  return {
    id: 'surface-event-1',
    action,
    surfaceId: 'surface-1',
    changedAt: '2026-08-27T00:00:01.000Z',
    surface: null,
    navigation: null,
    acknowledgement,
    findings: null,
    reason: null,
  };
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'neondeck-tour-'));
  homes.push(home);
  const paths = runtimePaths(home);
  await mkdir(dirname(paths.neondeckDatabase), { recursive: true });
  initializeAppDatabase(paths.neondeckDatabase);
  return { paths, review: reviewRecord() };
}

function tourDraft(title: string) {
  return {
    title,
    summary: 'How the exact-revision binding is enforced.',
    sourceFindingId: null,
    steps: [
      {
        key: 'parse',
        file: 'src/auth.ts',
        side: 'additions' as const,
        startLine: 10,
        endLine: 11,
        symbol: 'parseToken',
        explanation: 'The bearer token is parsed here.',
      },
      {
        key: 'reject',
        file: 'src/auth.ts',
        side: 'deletions' as const,
        startLine: 6,
        endLine: 6,
        symbol: null,
        explanation: 'The old permissive branch is removed here.',
      },
    ],
  };
}

function changedFiles() {
  return [
    {
      path: 'src/auth.ts',
      patch:
        '@@ -5,3 +10,4 @@\n context\n-old branch\n+parse header\n+validate token\n context',
      binary: false,
      truncated: false,
    },
  ];
}

function provenance(toolCallId: string) {
  return {
    authorRole: 'pr-reviewer',
    model: null,
    submissionId: 'submission-1',
    toolCallId,
  };
}

function reviewRecord(): PrReviewRecord {
  return {
    id: 'review-1',
    ref: 'owner/repo#1',
    repoFullName: 'owner/repo',
    prNumber: 1,
    title: 'Review guided tours',
    author: 'octocat',
    prUrl: 'https://github.com/owner/repo/pull/1',
    status: 'ready',
    runId: 'submission-1',
    headSha: 'head-1',
    baseSha: 'base-1',
    baseRef: 'main',
    origin: 'panel',
    reviewUrl: '/review?id=review-1',
    reportIds: [],
    recommendation: null,
    recommendationReason: null,
    briefingOverview: null,
    findingCount: 0,
    seededCount: 0,
    reportOnlyCount: 0,
    reportOnlyFindings: [],
    trustBoundary: 'Local only.',
    verdict: null,
    previousVerdict: null,
    githubReviewUrl: null,
    failureMessage: null,
    createdAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:00.000Z',
    readyAt: '2026-08-28T00:00:00.000Z',
    submittedAt: null,
    failedAt: null,
    archivedAt: null,
  };
}
