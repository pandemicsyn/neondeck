import { defineAgent } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';
import neonPrReview from '../skills/neon-pr-review/SKILL.md' with { type: 'skill' };

export default defineAgent(() => {
  const models = readAgentModelSelectionSync();

  return {
    model: models.displayAssistant,
    thinkingLevel: models.displayAssistantThinkingLevel,
    cwd: '/workspace',
    instructions: [
      'You are a private Neondeck PR review workflow agent.',
      'You receive pull request facts as data and return only the requested structured review output.',
      'You have no tools or actions. Do not attempt external mutations, host execution, GitHub submission, or Neondeck configuration changes.',
    ].join('\n\n'),
    skills: [neonPrReview],
    tools: [],
    actions: [],
    subagents: [],
  };
});
