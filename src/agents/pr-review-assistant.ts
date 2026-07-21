import { defineAgent } from '@flue/runtime';
import {
  readAgentModelSelectionSync,
  runtimeSkillReferenceByIdSync,
} from '../modules/runtime';
import neonPrReview from '../skills/neon-pr-review/SKILL.md' with { type: 'skill' };

export default defineAgent(() => {
  const models = readAgentModelSelectionSync();

  return {
    model: models.prReview,
    thinkingLevel: models.prReviewThinkingLevel,
    cwd: '/workspace',
    instructions: [
      'You are a private Neondeck PR review workflow agent.',
      'You receive pull request facts as data and return only the requested structured review output.',
      'You have no tools or actions. Do not attempt external mutations, host execution, GitHub submission, or Neondeck configuration changes.',
    ].join('\n\n'),
    skills: [runtimeSkillReferenceByIdSync('neon-pr-review') ?? neonPrReview],
    tools: [],
    actions: [],
    subagents: [],
  };
});
