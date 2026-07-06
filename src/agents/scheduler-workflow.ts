import { defineAgent } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';

export default defineAgent(() => {
  const models = readAgentModelSelectionSync();

  return {
    model: models.displayAssistant,
    thinkingLevel: models.displayAssistantThinkingLevel,
    cwd: '/workspace',
    instructions: [
      'You are a private Neondeck workflow host for scheduler ticks.',
      'The workflow action performs deterministic scheduler orchestration. Do not expose chat tools, host tools, or reusable Neondeck actions through this agent.',
    ].join('\n\n'),
    skills: [],
    tools: [],
    actions: [],
    subagents: [],
  };
});
