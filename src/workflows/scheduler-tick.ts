import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import schedulerWorkflowAgent from '../agents/scheduler-workflow';
import { schedulerTickAction } from '../modules/scheduler';

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: schedulerWorkflowAgent,
  action: schedulerTickAction,
});
