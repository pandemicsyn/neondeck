import { describe, expect, it, vi } from 'vitest';
import type { PrReviewTour } from '../shared/pr-review-tour';
import { createPrReviewerTourTool } from './modules/pr-reviewer';
import { replacePrReviewTour } from './modules/pr-review-tours';
import { runtimePaths } from './runtime-home';

describe('PR reviewer guided tour tool', () => {
  it('binds publication to the mounted review and returns a compact renderer result', async () => {
    const replaceTour = vi.fn<typeof replacePrReviewTour>(() =>
      Promise.resolve({
        ok: true as const,
        action: 'replace_pr_tour' as const,
        changed: true,
        message: 'Published.',
        tour,
      }),
    );
    const step = {
      do: vi.fn<
        (name: string, callback: () => Promise<unknown>) => Promise<unknown>
      >(async (_name, callback) => callback()),
    };
    const tool = createPrReviewerTourTool(
      { reviewId: 'review-1', headSha: 'head-1' },
      runtimePaths('/tmp/neondeck-tour-tool-test'),
      { replaceTour },
    );
    const draft = {
      title: 'Authentication',
      summary: 'Follow the request.',
      sourceFindingId: null,
      steps: [
        {
          key: 'entry',
          file: 'src/auth.ts',
          side: 'additions' as const,
          startLine: 10,
          endLine: 11,
          symbol: 'authenticate',
          explanation: 'Authentication starts here.',
        },
      ],
    };

    await expect(
      tool.run({ data: draft, step, toolCallId: 'tool-call-1' } as never),
    ).resolves.toMatchObject({
      output: {
        ok: true,
        action: 'replace_pr_tour',
        tourId: tour.id,
        generation: 1,
        reviewId: 'review-1',
        stepCount: 1,
        firstStepId: 'step-1',
      },
    });
    expect(tool).toMatchObject({ durable: true });
    expect(step.do).toHaveBeenCalledWith(
      'publish-pr-review-tour',
      expect.any(Function),
    );
    expect(replaceTour).toHaveBeenCalledWith(
      { reviewId: 'review-1', headSha: 'head-1' },
      draft,
      expect.objectContaining({ toolCallId: 'tool-call-1', model: null }),
      expect.any(Object),
    );
  });
});

const tour: PrReviewTour = {
  schemaVersion: 1,
  id: 'tour-1',
  generation: 1,
  conversationId: 'review-1@head-1',
  reviewId: 'review-1',
  repoFullName: 'owner/repo',
  headSha: 'head-1',
  revisionKey: 'git-commit:base-1:head-1',
  title: 'Authentication',
  summary: 'Follow the request.',
  sourceFindingId: null,
  provenance: {
    authorRole: 'pr-reviewer',
    model: null,
    submissionId: null,
    createdAt: '2026-08-28T00:00:00.000Z',
  },
  steps: [
    {
      id: 'step-1',
      key: 'entry',
      ordinal: 1,
      file: 'src/auth.ts',
      anchor: {
        kind: 'line-range',
        side: 'additions',
        startLine: 10,
        endLine: 11,
      },
      symbol: 'authenticate',
      explanation: 'Authentication starts here.',
    },
  ],
};
