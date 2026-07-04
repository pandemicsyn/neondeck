import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import displayAssistant from '../agents/display-assistant';
import { fixPrReviewFeedbackAction } from '../modules/autopilot';

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  action: fixPrReviewFeedbackAction,
});
