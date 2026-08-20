import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { prReviewerReReviewToolName } from '../../../shared/pr-reviewer-session';
import { runtimePaths, type RuntimePaths } from '../../runtime-home';
import {
  prEventOutputSchema,
  type PrEventActionResult,
} from '../pr-events/schemas';
import {
  readPrReview,
  startBoundPrReview,
  type PrReviewRecord,
} from '../pr-reviews';

type PrReviewerReReviewToolBinding = {
  reviewId: string;
  headSha: string;
};

type PrReviewerReReviewDependencies = {
  readReview: typeof readPrReview;
  startReview: typeof startBoundPrReview;
};

const defaultDependencies: PrReviewerReReviewDependencies = {
  readReview: readPrReview,
  startReview: startBoundPrReview,
};

export function createPrReviewerReReviewTool(
  binding: PrReviewerReReviewToolBinding,
  paths: RuntimePaths = runtimePaths(),
  dependencyOverrides: Partial<PrReviewerReReviewDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  return defineTool({
    name: prReviewerReReviewToolName,
    description:
      'Start a fresh Neon review run for the latest GitHub head of this bound pull request. Use only when the user explicitly asks to re-review, review new changes, or refresh Neon findings. This starts local review work but never submits a review or posts to GitHub. The current revision-bound conversation will be replaced after the new review finishes.',
    input: v.object({}),
    output: prEventOutputSchema,
    durable: true,
    async run({ step }) {
      const output = await step.do('start-pr-review', async () => {
        const current = dependencies.readReview(binding.reviewId, paths);
        if (!current) {
          return failure('The bound PR review is no longer available.', [
            'currentReview',
          ]);
        }
        if (current.status === 'reviewing') {
          return alreadyReviewing(current, binding.headSha);
        }
        if (current.headSha !== binding.headSha) {
          return failure(
            'The reviewer conversation belongs to an older PR revision.',
            ['currentReviewRevision'],
          );
        }
        if (current.status === 'submitting') {
          return failure(
            'A review is currently being submitted and cannot be restarted.',
            ['settledReviewSubmission'],
          );
        }

        const started = await dependencies.startReview(
          {
            ref: current.ref,
            origin: 'chat',
            expectedReview: {
              id: binding.reviewId,
              headSha: binding.headSha,
            },
            returnExistingInProgress: true,
          },
          paths,
        );
        if (started.reason === 'missing') {
          return failure('The bound PR review is no longer available.', [
            'currentReview',
          ]);
        }
        if (started.reason === 'stale') {
          return failure(
            'The reviewer conversation belongs to an older PR revision.',
            ['currentReviewRevision'],
          );
        }
        if (started.reason === 'submitting') {
          return failure(
            'A review is currently being submitted and cannot be restarted.',
            ['settledReviewSubmission'],
          );
        }
        if (started.reason === 'in_progress') {
          return alreadyReviewing(started.review, binding.headSha);
        }
        if (!started.started || !started.review) {
          return failure('The PR review could not be restarted.', [
            'currentReview',
          ]);
        }
        return success(
          started.review,
          binding.headSha,
          started.runId,
          true,
          `Started a fresh Neon review for ${started.review.repoFullName}#${started.review.prNumber}.`,
        );
      });
      return { output };
    },
  });
}

function alreadyReviewing(
  review: PrReviewRecord,
  previousHeadSha: string,
): PrEventActionResult {
  return success(
    review,
    previousHeadSha,
    review.runId,
    false,
    `A Neon review is already in progress for ${review.repoFullName}#${review.prNumber}.`,
  );
}

function success(
  review: PrReviewRecord,
  previousHeadSha: string,
  runId: string | null,
  changed: boolean,
  message: string,
): PrEventActionResult {
  return {
    ok: true,
    action: prReviewerReReviewToolName,
    changed,
    message,
    data: {
      reviewId: review.id,
      runId,
      status: review.status,
      previousHeadSha,
      headSha: review.headSha,
      revisionChanged: previousHeadSha !== review.headSha,
    } as JsonValue,
  };
}

function failure(message: string, requires: string[]): PrEventActionResult {
  return {
    ok: false,
    action: prReviewerReReviewToolName,
    changed: false,
    message,
    requires,
  };
}
