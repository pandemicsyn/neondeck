'use agent';

import { useModel } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';

export function SchedulerWorkflow() {
  const models = readAgentModelSelectionSync();
  useModel(models.displayAssistant, {
    thinkingLevel: models.displayAssistantThinkingLevel,
  });

  return [
    'You are a private Neondeck workflow host for scheduler ticks.',
    'The workflow tool performs deterministic scheduler orchestration. Do not expose chat tools, host tools, or reusable Neondeck tools through this agent.',
  ].join('\n\n');
}

SchedulerWorkflow.agentName = 'scheduler-workflow';
