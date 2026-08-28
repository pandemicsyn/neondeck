// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrReviewTour } from '../../../../shared/pr-review-tour';
import {
  annotationsFromPrReviewTour,
  PrReviewTourReadingView,
  PrReviewTourToolPart,
} from './PrReviewTour';

describe('PR review guided tours', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('creates exact tour annotations and hides them when locally closed', () => {
    expect(
      annotationsFromPrReviewTour(tour, false)['src/b.ts']?.[0],
    ).toMatchObject({
      side: 'additions',
      lineNumber: 11,
      metadata: { kind: 'tour', tourStep: { id: 'step-1' } },
    });
    expect(annotationsFromPrReviewTour(tour, true)).toEqual({});
  });

  it('renders authored order with a code excerpt and opens a selected step', async () => {
    const onActivate = vi.fn<(step: PrReviewTour['steps'][number]) => void>();
    await act(async () => {
      root.render(
        <PrReviewTourReadingView
          activeStepId="step-1"
          files={[
            {
              additions: 3,
              deletions: 0,
              path: 'src/b.ts',
              patch:
                'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -8,2 +8,4 @@\n context\n+const value = load();\n+return value;\n context',
              status: 'modified',
            },
          ]}
          onActivate={onActivate}
          tour={tour}
        />,
      );
    });

    expect(container.textContent).toContain('Follow the value');
    expect(container.textContent).toContain('return value;');
    expect(container.textContent).not.toContain('const value = load();');
    expect(container.textContent).not.toContain('b/src/b.ts');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click();
    });
    expect(onActivate).toHaveBeenCalledWith(tour.steps[0]);
  });

  it('keeps publication failures accessible and explains prior-tour preservation', async () => {
    await act(async () => {
      root.render(
        <PrReviewTourToolPart
          activeTour={tour}
          closed={false}
          part={{
            state: 'output-available',
            input: { title: 'Bad anchors' },
            output: { ok: false, message: 'Line 404 is not visible.' },
          }}
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Line 404 is not visible.',
    );
  });

  it('omits full-diff headers from a line-one added-file excerpt', async () => {
    const addedTour: PrReviewTour = {
      ...tour,
      id: 'tour-added',
      steps: [
        {
          ...tour.steps[0]!,
          id: 'step-added',
          file: 'src/new.ts',
          anchor: {
            kind: 'line-range',
            side: 'additions',
            startLine: 1,
            endLine: 1,
          },
        },
      ],
    };
    await act(async () => {
      root.render(
        <PrReviewTourReadingView
          activeStepId={null}
          files={[
            {
              additions: 1,
              deletions: 0,
              path: 'src/new.ts',
              patch:
                'diff --git a/src/new.ts b/src/new.ts\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+first',
              status: 'added',
            },
          ]}
          onActivate={() => undefined}
          tour={addedTour}
        />,
      );
    });
    expect(container.textContent).toContain('first');
    expect(container.textContent).not.toContain('b/src/new.ts');
  });

  it('does not count no-newline markers as source lines in excerpts', async () => {
    const markerTour: PrReviewTour = {
      ...tour,
      steps: [
        {
          ...tour.steps[0]!,
          anchor: {
            kind: 'line-range',
            side: 'additions',
            startLine: 3,
            endLine: 3,
          },
        },
      ],
    };
    await act(async () => {
      root.render(
        <PrReviewTourReadingView
          activeStepId={null}
          files={[
            {
              additions: 2,
              deletions: 1,
              path: 'src/b.ts',
              patch:
                '@@ -1,2 +1,3 @@\n context\n-old value\n\\ No newline at end of file\n+new value\n+target value',
              status: 'modified',
            },
          ]}
          onActivate={() => undefined}
          tour={markerTour}
        />,
      );
    });

    expect(container.textContent).toContain('target value');
    expect(container.textContent).not.toContain('No newline at end of file');
  });

  it('shows publication syncing instead of claiming a newer output was replaced', async () => {
    await act(async () => {
      root.render(
        <PrReviewTourToolPart
          activeTour={tour}
          closed={false}
          part={{
            state: 'output-available',
            input: { title: 'Replacement' },
            output: { ok: true, tourId: 'tour-2', generation: 2 },
          }}
        />,
      );
    });
    expect(container.textContent).toContain('Syncing guided tour');
    expect(container.textContent).not.toContain('Guided tour replaced');
  });

  it('keeps finding return navigation on the published chat card', async () => {
    const onBackToFinding = vi.fn<() => void>();
    await act(async () => {
      root.render(
        <PrReviewTourToolPart
          activeStepId="step-1"
          activeTour={tour}
          closed={false}
          onBackToFinding={onBackToFinding}
          part={{
            state: 'output-available',
            input: { title: tour.title },
            output: { ok: true, tourId: tour.id, generation: 1 },
          }}
        />,
      );
    });
    const back = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Back to the finding',
    );
    expect(back).toBeDefined();
    expect(container.querySelector('[aria-current="step"]')).not.toBeNull();
    await act(async () => back?.click());
    expect(onBackToFinding).toHaveBeenCalledTimes(1);
  });
});

const tour: PrReviewTour = {
  schemaVersion: 1,
  id: 'tour-1',
  generation: 1,
  conversationId: 'review-1@head',
  reviewId: 'review-1',
  repoFullName: 'pandemicsyn/neondeck',
  headSha: 'head',
  revisionKey: 'git-commit:base:head',
  title: 'Follow the value',
  summary: 'See where the value enters and leaves.',
  steps: [
    {
      id: 'step-1',
      key: 'load',
      ordinal: 1,
      file: 'src/b.ts',
      anchor: {
        kind: 'line-range',
        side: 'additions',
        startLine: 10,
        endLine: 11,
      },
      symbol: 'loadValue',
      explanation: 'The value is loaded and returned here.',
    },
  ],
  sourceFindingId: null,
  provenance: {
    authorRole: 'pr-reviewer',
    model: null,
    submissionId: 'submission-1',
    createdAt: '2026-08-28T00:00:00.000Z',
  },
};
