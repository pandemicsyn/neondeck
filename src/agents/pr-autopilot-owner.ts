import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';
import { submitAutopilotFixAction } from '../modules/autopilot/actions/submit-fix';
import {
  autopilotOwnerDiffAction,
  autopilotOwnerFileReadAction,
  autopilotOwnerFileSearchAction,
  autopilotOwnerStatusAction,
} from '../modules/autopilot/owner/actions';
import neonAutopilotFix from '../skills/neon-autopilot-fix/SKILL.md' with { type: 'skill' };
import { prAutopilotOwnerCompaction } from '../modules/autopilot/owner/config';

export { prAutopilotOwnerCompaction };

export const description =
  'Private continuing owner for one watched pull request and its managed worktree.';

// Operator inspection is available through the local API-authenticated GET
// surface. Prompt injection over the generated agent route is forbidden.
export const route: AgentRouteHandler = async (context, next) => {
  if (context.req.method === 'GET') return next();
  return context.json(
    { ok: false, error: 'Private autopilot owner prompts are dispatch-only.' },
    403,
  );
};

export default defineAgent(() => {
  const models = readAgentModelSelectionSync();
  return {
    model: models.displayAssistant,
    thinkingLevel: models.displayAssistantThinkingLevel,
    cwd: '/workspace',
    compaction: prAutopilotOwnerCompaction,
    instructions: [
      'You are the private continuing Neondeck owner for exactly one watched pull request.',
      'Each turn begins with a deterministic authoritative envelope. The newest envelope overrides historical transcript facts.',
      'Inspect only the bound managed worktree. You cannot execute a shell, mutate GitHub or config, push, call MCP, delegate, or invoke raw repository mutation actions.',
      'End every actionable turn by calling neondeck_autopilot_submit_fix exactly once. That action alone may apply your scoped proposal and create a prepared diff.',
    ].join('\n\n'),
    skills: [neonAutopilotFix],
    tools: [],
    actions: [
      autopilotOwnerFileReadAction,
      autopilotOwnerFileSearchAction,
      autopilotOwnerDiffAction,
      autopilotOwnerStatusAction,
      submitAutopilotFixAction,
    ],
    subagents: [],
  };
});
