import {
  defineWorkflow,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from '@flue/runtime';
import displayAssistant from '../agents/display-assistant';
import { devDoctorRunAction } from '../dev-doctor';

export const route: WorkflowRouteHandler = async (_c, next) => next();
export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  action: devDoctorRunAction,
});
