import { defineWorkflow, type WorkflowRunsHandler } from '@flue/runtime';
import { DisplayAssistant as displayAssistant } from '../agents/display-assistant';
import { devDoctorRunAction } from '../modules/runtime';

export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  action: devDoctorRunAction,
});
