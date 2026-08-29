import { defineTool } from '@flue/runtime';
import { prReviewerPublishTourToolName } from '../../../shared/pr-reviewer-session';
import { currentFlueExecutionContext } from '../flue';
import {
  prReviewTourDraftSchema,
  prReviewTourToolOutputSchema,
  replacePrReviewTour,
} from '../pr-review-tours';
import type { RuntimePaths } from '../../runtime-home';

export function createPrReviewerTourTool(
  binding: { reviewId: string; headSha: string },
  paths: RuntimePaths,
  dependencies: { replaceTour?: typeof replacePrReviewTour } = {},
) {
  return defineTool({
    name: prReviewerPublishTourToolName,
    description:
      'Atomically replace the current guided code tour for this exact PR review revision. Publish one complete ordered set of visible changed-line anchors only after verifying every anchor. A successful call replaces the prior tour; a failed call preserves it. This never creates GitHub comments or local review drafts.',
    input: prReviewTourDraftSchema,
    output: prReviewTourToolOutputSchema,
    durable: true,
    async run({ data, step, toolCallId }) {
      const context = currentFlueExecutionContext();
      const result = await step.do('publish-pr-review-tour', () =>
        (dependencies.replaceTour ?? replacePrReviewTour)(
          binding,
          data,
          {
            authorRole: context?.agentName ?? 'pr-reviewer',
            model: null,
            submissionId: context?.submissionId ?? null,
            toolCallId,
          },
          paths,
        ),
      );
      if (!result.ok || !result.tour) return { output: result };
      return {
        output: {
          ok: true,
          action: 'replace_pr_tour',
          changed: result.changed,
          message: result.message,
          tourId: result.tour.id,
          generation: result.tour.generation,
          reviewId: result.tour.reviewId,
          revisionKey: result.tour.revisionKey,
          stepCount: result.tour.steps.length,
          firstStepId: result.tour.steps[0]?.id ?? null,
        },
      };
    },
  });
}
