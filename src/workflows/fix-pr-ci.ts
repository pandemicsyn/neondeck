import {
  defineWorkflow,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from '@flue/runtime';
import busyworkWorkflow from '../agents/busywork-workflow';
import { ciFixRunAction } from '../modules/autopilot';

export const route: WorkflowRouteHandler = async (_c, next) => next();
export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: busyworkWorkflow,
  action: ciFixRunAction,
});
