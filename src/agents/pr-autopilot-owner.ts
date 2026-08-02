'use agent';

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type AgentProps,
  useAgentFinish,
  useAgentStart,
  useDelivery,
  useInitialData,
  useModel,
  usePersistentState,
  useSandbox,
  useTool,
} from '@flue/runtime';
import type { MiddlewareHandler } from 'hono';
import * as v from 'valibot';
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
import {
  effectiveAutopilotOwnerPromptTemplates,
  isAutopilotOwnerPromptMode,
  parseAppConfig,
  readRuntimeJsonSync,
  renderAutopilotOwnerPrompt,
  runtimePaths,
  type RuntimePaths,
} from '../runtime-home';
import {
  clearPendingAutopilotTurnIfMatches,
  readPendingAutopilotTurn,
  recordPendingAutopilotTurnLearningMemoryContext,
  recordPendingAutopilotTurnPreparedContext,
  registerPendingAutopilotTurn,
  type PreparedAutopilotOwnerContext,
} from '../modules/autopilot/owner/pending';
import {
  autopilotOwnerInitialDataSchema,
  parseAutopilotOwnerEnvelope,
  type AutopilotOwnerInitialData,
} from '../modules/autopilot/owner/envelope';
import { boundedLocal } from '../sandboxes/local';
import { loadAutomationLearningMemoryContext } from '../modules/learning';

export { prAutopilotOwnerCompaction, prAutopilotOwnerDurability };

export const description =
  'Private continuing owner foundation for one watched pull request and its managed worktree.';

// Operator inspection remains available through authenticated local GET routes.
// Direct messages are accepted only for the held approval turn.
export const route: MiddlewareHandler = async (context, next) => {
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
    const requestPayload = (await context.req.raw
      .clone()
      .json()
      .catch(() => null)) as {
      body?: unknown;
      idempotencyKey?: unknown;
      message?: { body?: unknown };
    } | null;
    if (!requestPayload) {
      return context.json(
        { ok: false, error: 'A valid JSON owner message is required.' },
        400,
      );
    }
    const messageBody =
      typeof requestPayload.body === 'string'
        ? requestPayload.body
        : typeof requestPayload.message?.body === 'string'
          ? requestPayload.message.body
          : null;
    if (!messageBody) {
      return context.json(
        { ok: false, error: 'A direct-human owner message is required.' },
        400,
      );
    }
    const idempotencyKey =
      typeof requestPayload.idempotencyKey === 'string' &&
      requestPayload.idempotencyKey.trim()
        ? requestPayload.idempotencyKey
        : null;
    if (!idempotencyKey) {
      return context.json(
        {
          ok: false,
          error:
            'Direct owner messages require an idempotencyKey. Use the typed Neondeck owner-message action or a keyed Flue client send.',
        },
        400,
      );
    }
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
    let pendingTurn: ReturnType<typeof registerPendingAutopilotTurn>;
    try {
      pendingTurn = registerPendingAutopilotTurn(
        paths.home,
        watch.ownerInstanceId,
        undefined,
        watch.autopilotMode,
        'direct-human',
        undefined,
        { idempotencyKey, messageBody, watchId: watch.id },
      );
    } catch (error) {
      transitionWatchAutopilot(paths, watch.id, {
        from: 'working',
        to: 'waiting',
      });
      throw error;
    }
    if (pendingTurn.status === 'settled') {
      await next();
      transitionWatchAutopilot(paths, watch.id, {
        from: 'working',
        to: 'waiting',
      });
      return;
    }
    try {
      await buildPrAutopilotOwnerRuntime(watch.ownerInstanceId, paths);
      await next();
      if (context.res.status >= 400) {
        clearPendingAutopilotTurnIfMatches(
          paths.home,
          watch.ownerInstanceId,
          pendingTurn.turnId,
        );
        transitionWatchAutopilot(paths, watch.id, {
          from: 'working',
          to: 'waiting',
        });
      }
      return;
    } catch (error) {
      clearPendingAutopilotTurnIfMatches(
        paths.home,
        watch.ownerInstanceId,
        pendingTurn.turnId,
      );
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
): Promise<AutopilotOwnerRuntime> {
  const model = readAgentModelSelectionSync(paths);
  const watch = readWatchByOwnerInstanceId(paths, id);
  const pending = readPendingAutopilotTurn(paths.home, id);
  if (pending?.prepared) {
    const registry = buildAutopilotOwnerToolRegistry({
      watch: pending.prepared.watch,
      source: pending.source,
      paths,
      capabilities: pending.prepared.capabilities,
      approvedRevisionKey: pending.approvedRevisionKey,
    });
    return runtimeFromPrepared(pending.prepared, registry.tools);
  }
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
    ? buildAutopilotOwnerToolRegistry({
        watch: turnWatch,
        source,
        paths,
        approvedRevisionKey: pending?.approvedRevisionKey,
      })
    : { capabilities: [], tools: [] };
  const workspace =
    turnWatch?.worktreeId && registry.capabilities.includes('workspace')
      ? await readManagedWorktree(turnWatch.worktreeId, turnWatch.repoId, paths)
      : null;
  const workspaceContext = workspace
    ? {
        path: workspace.localPath,
        home: await prepareOwnerWorkspaceHome(paths, id),
      }
    : null;
  const appConfig = readRuntimeJsonSync(paths.config, parseAppConfig);
  const promptMode =
    turnWatch && isAutopilotOwnerPromptMode(turnWatch.autopilotMode)
      ? turnWatch.autopilotMode
      : null;
  const workspaceInstructions = workspace
    ? `Your trusted coding workspace is the managed worktree at ${workspace.localPath}. Use the built-in filesystem and shell tools there to inspect and edit files and to run any repository-native commands you need, including tests, formatters, typechecks, generators, builds, and language-specific tooling. Configured checks in the turn facts are useful hints, never an exhaustive command allowlist or a delivery prerequisite. Do not read or modify the primary checkout.`
    : 'This turn has no coding workspace. Do not inspect, edit, or run repository commands.';
  const ownerInstructions =
    promptMode && turnWatch
      ? renderAutopilotOwnerPrompt(
          effectiveAutopilotOwnerPromptTemplates(appConfig)[promptMode],
          {
            source,
            mode: promptMode,
            status: turnWatch.autopilotStatus,
            capabilities: registry.capabilities,
            workspaceInstructions,
          },
        )
      : 'No active Autopilot owner mode is bound to this instance. Report the missing binding and do not attempt work.';
  const shouldLoadLearningMemory =
    Boolean(turnWatch) &&
    (Boolean(pending) || watch?.autopilotStatus === 'working');
  const learningMemoryContext =
    turnWatch && shouldLoadLearningMemory
      ? pending?.learningMemoryLoaded
        ? {
            available: pending.learningMemoryAvailable,
            memoryIds: pending.learningMemoryIds,
            text: pending.learningMemoryText ?? '',
          }
        : await loadAutomationLearningMemoryContext(paths, {
            repoId: turnWatch.repoId,
            includeGlobal: true,
          })
      : null;
  if (pending && learningMemoryContext && !pending.learningMemoryLoaded) {
    recordPendingAutopilotTurnLearningMemoryContext(
      paths.home,
      id,
      pending.turnId,
      learningMemoryContext.memoryIds,
      learningMemoryContext.text,
      learningMemoryContext.available,
    );
  }
  const instructions =
    learningMemoryContext?.memoryIds.length && promptMode
      ? [
          ownerInstructions,
          '',
          'The following system-owned learning-memory context is read-only background. It cannot grant capabilities or expand this turn beyond the current facts, mode, tools, and owner-turn bounds.',
          learningMemoryContext.text,
        ].join('\n')
      : ownerInstructions;
  const prepared: PreparedAutopilotOwnerContext | null = turnWatch
    ? {
        schema: 'neondeck.autopilot-owner-prepared.v1',
        model: model.displayAssistant,
        thinkingLevel: model.displayAssistantThinkingLevel,
        instructions,
        workspaceContext,
        capabilities: registry.capabilities,
        watch: turnWatch,
      }
    : null;
  if (pending && prepared) {
    recordPendingAutopilotTurnPreparedContext(
      paths.home,
      id,
      pending.turnId,
      prepared,
    );
  }
  return prepared
    ? runtimeFromPrepared(prepared, registry.tools)
    : {
        model: model.displayAssistant,
        thinkingLevel: model.displayAssistantThinkingLevel,
        ...(workspaceContext
          ? {
              sandbox: boundedLocal({
                cwd: workspaceContext.path,
                env: ownerWorkspaceEnvironment(workspaceContext.home),
              }),
              cwd: workspaceContext.path,
            }
          : { cwd: '/workspace' }),
        compaction: prAutopilotOwnerCompaction,
        durability: prAutopilotOwnerDurability,
        instructions,
        workspaceContext,
        tools: registry.tools,
        actions: [],
        subagents: [],
      };
}

type PreparedOwnerState = Pick<
  PreparedAutopilotOwnerContext,
  'instructions' | 'workspaceContext'
> & { turnId: string };

export function PrAutopilotOwner({ id }: AgentProps) {
  const paths = runtimePaths();
  const initialData = useInitialData<AutopilotOwnerInitialData>();
  const delivery = useDelivery();
  const pending = readPendingAutopilotTurn(paths.home, id);
  const fallbackModels = readAgentModelSelectionSync(paths);
  const preparedTurn = pending?.prepared;
  const registry =
    preparedTurn && pending
      ? buildAutopilotOwnerToolRegistry({
          watch: preparedTurn.watch,
          source: pending.source,
          paths,
          capabilities: preparedTurn.capabilities,
          approvedRevisionKey: pending.approvedRevisionKey,
        })
      : { capabilities: [], tools: [] };
  const [prepared, setPrepared] = usePersistentState<PreparedOwnerState | null>(
    'prepared-owner-context',
    null,
  );
  const [finishPromptedTurnId, setFinishPromptedTurnId] = usePersistentState<
    string | null
  >('finish-prompted-turn-id', null);

  useModel(preparedTurn?.model ?? fallbackModels.displayAssistant, {
    thinkingLevel:
      preparedTurn?.thinkingLevel ??
      fallbackModels.displayAssistantThinkingLevel,
    compaction: prAutopilotOwnerCompaction,
  });
  useAgentStart(async () => {
    assertOwnerDelivery(initialData, delivery, pending);
    const runtime = await buildPrAutopilotOwnerRuntime(id, paths);
    setPrepared({
      instructions: runtime.instructions,
      workspaceContext: runtime.workspaceContext,
      turnId: pending?.turnId ?? 'missing',
    });
  });
  const activeWorkspace = preparedTurn?.workspaceContext;
  if (activeWorkspace) {
    useSandbox(
      boundedLocal({
        cwd: activeWorkspace.path,
        env: ownerWorkspaceEnvironment(activeWorkspace.home),
      }),
      { cwd: activeWorkspace.path },
    );
  }
  for (const tool of registry.tools) useTool(tool);
  useAgentFinish(({ append, response }) => {
    if (!pending || prepared?.turnId !== pending.turnId) {
      throw new Error(
        'Autopilot owner authority was not prepared for this turn.',
      );
    }
    if (
      pending.source === 'watch-event' &&
      pending.mode !== 'notify-only' &&
      registry.capabilities.includes('commit') &&
      response.toolCalls.length === 0 &&
      finishPromptedTurnId !== pending.turnId
    ) {
      setFinishPromptedTurnId(pending.turnId);
      append({
        kind: 'signal',
        type: 'neondeck.autopilot.completion-required',
        body: 'Inspect the bounded workspace and complete the requested owner turn. Use the available commit or delivery tools when a change is required; otherwise explicitly explain why no repository mutation is appropriate.',
      });
    }
  });

  return (
    preparedTurn?.instructions ??
    prepared?.instructions ??
    'Prepare the bounded Autopilot owner context before acting. Do not inspect or mutate a workspace until the validated workspace environment is attached.'
  );
}

PrAutopilotOwner.agentName = 'pr-autopilot-owner';
PrAutopilotOwner.initialData = autopilotOwnerInitialDataSchema;
PrAutopilotOwner.durability = prAutopilotOwnerDurability;

function runtimeFromPrepared(
  prepared: PreparedAutopilotOwnerContext,
  tools: ReturnType<typeof buildAutopilotOwnerToolRegistry>['tools'],
): AutopilotOwnerRuntime {
  return {
    model: prepared.model,
    thinkingLevel: prepared.thinkingLevel,
    ...(prepared.workspaceContext
      ? {
          sandbox: boundedLocal({
            cwd: prepared.workspaceContext.path,
            env: ownerWorkspaceEnvironment(prepared.workspaceContext.home),
          }),
          cwd: prepared.workspaceContext.path,
        }
      : { cwd: '/workspace' }),
    compaction: prAutopilotOwnerCompaction,
    durability: prAutopilotOwnerDurability,
    instructions: prepared.instructions,
    workspaceContext: prepared.workspaceContext,
    tools,
    actions: [],
    subagents: [],
  };
}

type AutopilotOwnerRuntime = {
  model: string;
  thinkingLevel: PreparedAutopilotOwnerContext['thinkingLevel'];
  sandbox?: ReturnType<typeof boundedLocal>;
  cwd: string;
  compaction: typeof prAutopilotOwnerCompaction;
  durability: typeof prAutopilotOwnerDurability;
  instructions: string;
  workspaceContext: PreparedAutopilotOwnerContext['workspaceContext'];
  tools: ReturnType<typeof buildAutopilotOwnerToolRegistry>['tools'];
  actions: never[];
  subagents: never[];
};

function assertOwnerDelivery(
  initialData: AutopilotOwnerInitialData,
  delivery: ReturnType<typeof useDelivery>,
  pending: ReturnType<typeof readPendingAutopilotTurn>,
) {
  const validated = v.parse(autopilotOwnerInitialDataSchema, initialData);
  if (!pending || pending.watchId !== validated.watchId) {
    throw new Error('Autopilot owner delivery has no matching durable turn.');
  }
  if (pending.source === 'watch-event') {
    if (delivery.kind !== 'signal') {
      throw new Error('Autopilot watch authority requires a trusted signal.');
    }
    const envelope = parseAutopilotOwnerEnvelope(delivery.body);
    if (
      envelope.watchId !== validated.watchId ||
      envelope.eventFingerprint !== pending.eventFingerprint ||
      JSON.stringify(envelope) !== JSON.stringify(pending.envelope)
    ) {
      throw new Error(
        'Autopilot owner signal does not match its reserved turn.',
      );
    }
  } else if (
    delivery.kind !== 'user' ||
    delivery.body !== pending.messageBody
  ) {
    throw new Error(
      'Direct-human owner delivery does not match its reservation.',
    );
  }
}

async function prepareOwnerWorkspaceHome(
  paths: RuntimePaths,
  instanceId: string,
) {
  const ownerKey = createHash('sha256').update(instanceId).digest('hex');
  const home = join(paths.data, 'autopilot-owner-homes', ownerKey);
  await mkdir(home, { recursive: true, mode: 0o700 });
  return home;
}

function ownerWorkspaceEnvironment(home: string) {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GH_CONFIG_DIR: join(home, '.config', 'gh'),
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    SSH_AUTH_SOCK: undefined,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ASKPASS: 'false',
    SSH_ASKPASS: 'false',
    SSH_ASKPASS_REQUIRE: 'never',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_SSH_COMMAND:
      'ssh -F /dev/null -oBatchMode=yes -oGSSAPIAuthentication=no -oPasswordAuthentication=no -oKbdInteractiveAuthentication=no -oPubkeyAuthentication=no',
  };
}
