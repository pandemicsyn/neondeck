'use agent';

import {
  useAgentFinish,
  useInitialData,
  useModel,
  useTool,
} from '@flue/runtime';
import { createSubmitLearningReviewTool } from '../modules/learning/reviews/tool';
import {
  preparedLearningReviewSchema,
  type PreparedLearningReview,
} from '../modules/learning/reviews/schemas';
import { getLearningReview } from '../modules/learning/reviews/store';

export function LearningReviewAgent() {
  const prepared = useInitialData<PreparedLearningReview>();
  const executionState: { failure?: Error } = {};
  useModel(prepared.model, { thinkingLevel: prepared.thinkingLevel });
  useTool(createSubmitLearningReviewTool(prepared, executionState));
  useAgentFinish(({ append, response }) => {
    const review = getLearningReview(prepared.reviewId);
    if (review?.status === 'failed') {
      throw new Error(review.error ?? 'The bounded learning review failed.');
    }
    if (executionState.failure) throw executionState.failure;
    const call = response.toolCalls.find(
      (candidate) => candidate.tool === 'neondeck_submit_learning_review',
    );
    if (call?.isError)
      throw new Error('The bounded learning review tool failed.');
    if (call && review?.status !== 'completed') {
      throw new Error(
        'The bounded learning review tool settled without durable completion state.',
      );
    }
    if (!call) {
      append({
        kind: 'signal',
        type: 'neondeck.learning-review.required',
        body: 'Call neondeck_submit_learning_review now. This submission cannot settle without a validated learning result.',
      });
    }
  });
  return 'This is a bounded Neondeck learning review. Follow the scope policy in the prepared evidence: user preferences use user scope; machine, tool, environment, and provider facts use local scope; repository and product conventions use project scope. During curation, prefer rewrite, merge, or archive over duplicate upserts. Call neondeck_submit_learning_review exactly once with an empty object. Do not answer conversationally and do not delegate.';
}

LearningReviewAgent.agentName = 'learning-review-agent';
LearningReviewAgent.initialData = preparedLearningReviewSchema;
