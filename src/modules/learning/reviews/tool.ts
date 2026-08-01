import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import {
  completeLearningReviewFromModelOutput,
  failPreparedLearningReview,
} from './complete';
import {
  learningReviewerOutputSchema,
  learningReviewOutputSchema,
  type PreparedLearningReview,
} from './schemas';
import { runtimePaths } from '../../../runtime-home';

export type LearningReviewToolState = { failure?: Error };

const learningReviewTimeoutMs = 15 * 60 * 1_000;

export function createSubmitLearningReviewTool(
  prepared: PreparedLearningReview,
  state: LearningReviewToolState = {},
) {
  let execution:
    | Promise<{
        output: v.InferOutput<typeof learningReviewOutputSchema>;
        terminate: true;
      }>
    | undefined;

  return defineTool({
    name: 'neondeck_submit_learning_review',
    description:
      'Run the bounded learning review against its immutable evidence snapshot, validate the structured result, and apply Neondeck learning policy. Call exactly once.',
    input: v.object({}),
    output: learningReviewOutputSchema,
    harness: true,
    durable: true,
    async run({ harness, log, step }) {
      execution ??= (async () => {
        try {
          const output = await step.do('model-output', async () => {
            const response = await harness.prompt(prepared.prompt, {
              result: learningReviewerOutputSchema,
              signal: AbortSignal.timeout(learningReviewTimeoutMs),
            });
            return response.data;
          });
          const result = await completeLearningReviewFromModelOutput(
            prepared,
            output,
            runtimePaths(),
            { runEffect: (name, effect) => step.do(name, effect) },
          );
          if (!result.ok) {
            state.failure = new Error(result.message);
            log.error('Learning review produced an invalid result', {
              reviewId: prepared.reviewId,
              message: result.message,
            });
          }
          return {
            output: v.parse(learningReviewOutputSchema, result),
            terminate: true,
          } as const;
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          state.failure = failure;
          const result = await step.do('fail-review', () =>
            failPreparedLearningReview(prepared, failure, runtimePaths()),
          );
          log.error('Learning review failed', {
            reviewId: prepared.reviewId,
            message: failure.message,
          });
          return {
            output: v.parse(learningReviewOutputSchema, result),
            terminate: true,
          } as const;
        }
      })();
      return execution;
    },
  });
}
