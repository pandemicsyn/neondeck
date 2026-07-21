import { defineAgent, type AgentRouteHandler } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { readAgentModelSelectionSync } from '../modules/runtime';
import {
  prAutopilotOwnerCompaction,
  prAutopilotOwnerDurability,
} from '../modules/autopilot/owner/config';
import { buildAutopilotOwnerToolRegistry } from '../modules/autopilot/owner/tools';
import {
  readWatchByOwnerInstanceId,
  transitionWatchAutopilot,
} from '../modules/watches';
import { readManagedWorktree } from '../modules/worktrees';
import { runtimePaths } from '../runtime-home';
import {
  clearPendingAutopilotTurn,
  readPendingAutopilotTurn,
  registerPendingAutopilotTurn,
} from '../modules/autopilot/owner/pending';

export { prAutopilotOwnerCompaction, prAutopilotOwnerDurability };

const ownerWorkspaceEnvironment = {
  GITHUB_TOKEN: undefined,
  GH_TOKEN: undefined,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
  GIT_ASKPASS: 'false',
  SSH_ASKPASS: 'false',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_SSH_COMMAND:
    'ssh -F /dev/null -oBatchMode=yes -oGSSAPIAuthentication=no -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no -oPubkeyAuthentication=no',
} as const;

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
  const paths = runtimePaths();
  const watch = readWatchByOwnerInstanceId(paths, instanceId);
  if (
    context.req.method === 'POST' &&
    watch?.autopilotMode === 'autofix-with-approval' &&
    watch.autopilotStatus === 'waiting'
  ) {
    const claimed = transitionWatchAutopilot(paths, watch.id, {
      from: 'waiting',
      to: 'working',
    });
    if (!claimed || !watch.ownerInstanceId) {
      return context.json(
        { ok: false, error: 'The owner already has a turn in progress.' },
        409,
      );
    }
    registerPendingAutopilotTurn(
      paths.home,
      watch.ownerInstanceId,
      undefined,
      watch.autopilotMode,
      'direct-human',
    );
    try {
      return await next();
    } catch (error) {
      clearPendingAutopilotTurn(paths.home, watch.ownerInstanceId);
      transitionWatchAutopilot(paths, watch.id, {
        from: 'working',
        to: 'blocked',
      });
      throw error;
    }
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

export async function buildPrAutopilotOwnerRuntime(
  id: string,
  paths = runtimePaths(),
) {
  const model = readAgentModelSelectionSync(paths);
  const watch = readWatchByOwnerInstanceId(paths, id);
  const pending = readPendingAutopilotTurn(paths.home, id);
  const source = pending?.source ?? 'watch-event';
  const turnWatch =
    watch && pending
      ? {
          ...watch,
          autopilotMode: pending.mode,
          autopilotStatus:
            source === 'direct-human'
              ? ('waiting' as const)
              : watch.autopilotStatus,
        }
      : watch;
  const registry = turnWatch
    ? buildAutopilotOwnerToolRegistry({ watch: turnWatch, source, paths })
    : { capabilities: [], tools: [] };
  const workspace =
    turnWatch?.worktreeId && registry.capabilities.includes('workspace')
      ? await readManagedWorktree(turnWatch.worktreeId, turnWatch.repoId, paths)
      : null;
  return {
    model: model.displayAssistant,
    thinkingLevel: model.displayAssistantThinkingLevel,
    ...(workspace
      ? {
          sandbox: local({
            cwd: workspace.localPath,
            env: ownerWorkspaceEnvironment,
          }),
          cwd: workspace.localPath,
        }
      : { cwd: '/workspace' }),
    compaction: prAutopilotOwnerCompaction,
    durability: prAutopilotOwnerDurability,
    instructions: [
      'You are the private continuing Neondeck owner for exactly one watched pull request.',
      'Each dispatched turn supplies current authoritative facts and the exact capabilities available for that turn.',
      turnWatch
        ? `This turn is ${source}; the watch mode at dispatch was ${turnWatch.autopilotMode}, the loop status is ${turnWatch.autopilotStatus}, and the only available capabilities are: ${registry.capabilities.join(', ') || 'none'}.`
        : 'No active watch binding exists for this instance. Report the missing binding and do not attempt work.',
      workspace
        ? `Your trusted coding workspace is the managed worktree at ${workspace.localPath}. Use the built-in filesystem and shell tools there to inspect and edit files and to run any repository-native commands you need, including tests, formatters, typechecks, generators, builds, and language-specific tooling. Configured checks in the turn facts are useful hints, never an exhaustive command allowlist or a delivery prerequisite. Do not read or modify the primary checkout.`
        : 'This turn has no coding workspace. Do not inspect, edit, or run repository commands.',
      'Workspace commands are for coding and validation only. Never use git push, gh, curl, or another shell/network client to push commits or post PR responses; external delivery must use the mode-scoped Neondeck push and PR-response tools, which bind the destination and credentials.',
      turnWatch?.autopilotMode === 'autofix-push-when-safe' &&
      source === 'watch-event'
        ? 'This is autonomous engineering authority. Judge whether the feedback is reasonable, relevant, technically sound, appropriately scoped, and sufficiently validated. When it is, implement the smallest justified change, validate proportionately, commit, push with the owner push tool, and respond with what changed and what you ran. When it is absurd, ambiguous, scope-exploding, technically unsound, or cannot be validated well enough, do not push: retain any useful committed work and clearly explain why human review is needed. Do not invent a mechanical safety classifier.'
        : 'Make the smallest justified change and commit when a change is warranted. This turn must not deliver unless its explicit mode-scoped delivery tools and the human instruction authorize that effect.',
      'Current facts in the newest turn override stale conversation facts. Report uncertainty rather than guessing.',
      'Never claim a push or PR response succeeded unless the corresponding bounded tool returned success.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tools: registry.tools,
    actions: [],
    subagents: [],
  };
}

export default defineAgent(({ id }) => {
  return buildPrAutopilotOwnerRuntime(id);
});
