import { defineAgent } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';
import neonCiFix from '../skills/neon-ci-fix/SKILL.md' with { type: 'skill' };

export default defineAgent(() => {
  const models = readAgentModelSelectionSync();

  return {
    model: models.displayAssistant,
    thinkingLevel: models.displayAssistantThinkingLevel,
    cwd: '/workspace',
    instructions: [
      'You are a private Neondeck workflow host for bounded busywork workflows.',
      'Workflow actions perform deterministic orchestration. Do not expose chat tools, host tools, or reusable Neondeck actions through this agent.',
    ].join('\n\n'),
    skills: [neonCiFix],
    tools: [],
    actions: [],
    subagents: [],
  };
});
