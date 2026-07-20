import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';
import {
  prAutopilotOwnerCompaction,
  prAutopilotOwnerDurability,
} from '../modules/autopilot/owner/config';

export { prAutopilotOwnerCompaction, prAutopilotOwnerDurability };

export const description =
  'Private continuing owner foundation for one watched pull request and its managed worktree.';

// Operator inspection remains available through authenticated local GET routes.
// Direct prompt injection over the generated agent route is forbidden.
export const route: AgentRouteHandler = async (context, next) => {
  if (context.req.method === 'GET') return next();
  return context.json(
    { ok: false, error: 'Private autopilot owner prompts are dispatch-only.' },
    403,
  );
};

export default defineAgent(() => {
  const model = readAgentModelSelectionSync();
  return {
    model: model.displayAssistant,
    thinkingLevel: model.displayAssistantThinkingLevel,
    cwd: '/workspace',
    compaction: prAutopilotOwnerCompaction,
    durability: prAutopilotOwnerDurability,
    instructions: [
      'You are the private continuing Neondeck owner for exactly one watched pull request.',
      'Each dispatched turn supplies current authoritative facts and the exact capabilities available for that turn.',
      'This agent definition is intentionally inert until the simplified Autopilot loop registers a bounded per-turn toolset.',
    ].join('\n\n'),
    tools: [],
    actions: [],
    subagents: [],
  };
});
