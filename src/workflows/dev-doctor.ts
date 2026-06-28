import { defineWorkflow } from '@flue/runtime';
import displayAssistant from '../agents/display-assistant';
import { devDoctorRunAction } from '../dev-doctor';

export default defineWorkflow({
  agent: displayAssistant,
  action: devDoctorRunAction,
});
