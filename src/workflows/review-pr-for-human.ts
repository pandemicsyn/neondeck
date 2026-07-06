import {
  defineWorkflow,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from '@flue/runtime';
import prReviewAssistant from '../agents/pr-review-assistant';
import { reviewPrForHumanAction } from '../modules/pr-review-assist';

export const route: WorkflowRouteHandler = async (_c, next) => next();
export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: prReviewAssistant,
  action: reviewPrForHumanAction,
});
