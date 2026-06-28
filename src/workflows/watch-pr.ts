import { defineWorkflow } from '@flue/runtime';
import displayAssistant from '../agents/display-assistant';
import { watchPrAddAction } from '../watch-actions';

export default defineWorkflow({
  agent: displayAssistant,
  action: watchPrAddAction,
});
