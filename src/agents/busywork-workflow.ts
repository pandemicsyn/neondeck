'use agent';

import { useModel, useSkill } from '@flue/runtime';
import {
  readAgentModelSelectionSync,
  runtimeSkillReferenceByIdSync,
} from '../modules/runtime';
import neonCiFix from '../skills/neon-ci-fix/SKILL.md';

export function BusyworkWorkflow() {
  const models = readAgentModelSelectionSync();
  useModel(models.displayAssistant, {
    thinkingLevel: models.displayAssistantThinkingLevel,
  });
  useSkill(runtimeSkillReferenceByIdSync('neon-ci-fix') ?? neonCiFix);

  return [
    'You are a private Neondeck workflow host for bounded busywork workflows.',
    'Workflow tools perform deterministic orchestration. Do not expose chat tools, host tools, or reusable Neondeck tools through this agent.',
  ].join('\n\n');
}

BusyworkWorkflow.agentName = 'busywork-workflow';
