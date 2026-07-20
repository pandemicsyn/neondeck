import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { readAgentModelSelectionSync } from '../modules/runtime';
import {
  prAutopilotOwnerCompaction,
  prAutopilotOwnerDurability,
} from '../modules/autopilot/owner/config';
import { buildAutopilotOwnerToolRegistry } from '../modules/autopilot/owner/tools';
import { readWatchByOwnerInstanceId } from '../modules/watches';
import { runtimePaths } from '../runtime-home';
import { readPendingAutopilotTurn } from '../modules/autopilot/owner/pending';

export { prAutopilotOwnerCompaction, prAutopilotOwnerDurability };

export const description =
  'Private continuing owner foundation for one watched pull request and its managed worktree.';

// Operator inspection remains available through authenticated local GET routes.
// Direct messages are accepted only for the held approval turn.
export const route: AgentRouteHandler = async (context, next) => {
  if (context.req.method === 'GET') return next();
  const instanceId = context.req.param('id');
  if (!instanceId) {
    return context.json(
      { ok: false, error: 'Missing owner instance id.' },
      404,
    );
  }
  const watch = readWatchByOwnerInstanceId(runtimePaths(), instanceId);
  if (
    context.req.method === 'POST' &&
    watch?.autopilotMode === 'autofix-with-approval' &&
    watch.autopilotStatus === 'waiting'
  ) {
    return next();
  }
  return context.json(
    {
      ok: false,
      error:
        'Direct owner messages are available only while an approval-mode watch is waiting for human review.',
    },
    403,
  );
};

export default defineAgent(({ id }) => {
  const model = readAgentModelSelectionSync();
  const paths = runtimePaths();
  const watch = readWatchByOwnerInstanceId(paths, id);
  const source =
    watch?.autopilotMode === 'autofix-with-approval' &&
    watch.autopilotStatus === 'waiting'
      ? ('direct-human' as const)
      : ('watch-event' as const);
  const pending = readPendingAutopilotTurn(paths.home, id);
  const turnWatch =
    watch && source === 'watch-event' && pending
      ? { ...watch, autopilotMode: pending.mode }
      : watch;
  const registry = turnWatch
    ? buildAutopilotOwnerToolRegistry({ watch: turnWatch, source, paths })
    : { capabilities: [], tools: [] };
  return {
    model: model.displayAssistant,
    thinkingLevel: model.displayAssistantThinkingLevel,
    cwd: '/workspace',
    compaction: prAutopilotOwnerCompaction,
    durability: prAutopilotOwnerDurability,
    instructions: [
      'You are the private continuing Neondeck owner for exactly one watched pull request.',
      'Each dispatched turn supplies current authoritative facts and the exact capabilities available for that turn.',
      turnWatch
        ? `This turn is ${source}; the watch mode at dispatch was ${turnWatch.autopilotMode}, the loop status is ${turnWatch.autopilotStatus}, and the only available capabilities are: ${registry.capabilities.join(', ') || 'none'}.`
        : 'No active watch binding exists for this instance. Report the missing binding and do not attempt work.',
      'Current facts in the newest turn override stale conversation facts. Make the smallest justified change, commit when a change is warranted, and report uncertainty rather than guessing.',
      'Never claim a push or PR response succeeded unless the corresponding bounded tool returned success.',
    ].join('\n\n'),
    tools: registry.tools,
    actions: [],
    subagents: [],
  };
});
