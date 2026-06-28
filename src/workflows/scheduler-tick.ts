import { defineWorkflow } from '@flue/runtime';
import displayAssistant from '../agents/display-assistant';
import { schedulerTickAction } from '../scheduler';

export default defineWorkflow({
  agent: displayAssistant,
  action: schedulerTickAction,
});
