import {
  defineWorkflow,
  type WorkflowRouteHandler,
  type WorkflowRunsHandler,
} from '@flue/runtime';
import * as v from 'valibot';
import displayAssistant from '../agents/display-assistant';
import { runNeonCommand } from '../commands';

export const route: WorkflowRouteHandler = async (_c, next) => next();
export const runs: WorkflowRunsHandler = async (_c, next) => next();

export default defineWorkflow({
  agent: displayAssistant,
  input: v.object({}),
  async run() {
    return runNeonCommand({ command: '/briefing' });
  },
});
