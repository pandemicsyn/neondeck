import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import {
  completeLearningReviewFromModelOutput,
  conversationReviewInputSchema,
  failPreparedLearningReview,
  learningReviewCoordinator,
  learningReviewerOutputSchema,
  learningReviewOutputSchema,
  prepareConversationReflection,
} from '../learning-reviews';

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: learningReviewCoordinator,
  input: conversationReviewInputSchema,
  output: learningReviewOutputSchema,
  async run({ harness, input }) {
    const prepared = await prepareConversationReflection(input);
    if (!prepared.ok) return prepared;

    try {
      const response = await (
        await harness.session()
      ).task(prepared.prompt, {
        agent: 'learning_reviewer',
        result: learningReviewerOutputSchema,
      });
      return await completeLearningReviewFromModelOutput(
        prepared,
        response.data,
      );
    } catch (error) {
      return failPreparedLearningReview(prepared, error);
    }
  },
});
