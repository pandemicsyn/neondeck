import * as v from 'valibot';
import { parseActionInput, failResult, okResult } from '../result';
import { recordConfigChange } from '../history';
import { writeJson } from '../files';
import {
  type AgentModelConfig,
  type AppConfig,
  type LearningConfig,
  type WorktreeCleanupConfig,
  ensureRuntimeHome,
  parseAppConfig,
  readRuntimeJson,
  runtimePaths,
} from '../../../runtime-home';
import {
  updateAgentModelsInputSchema,
  updateLearningConfigInputSchema,
  updateSkillRootsInputSchema,
  updateWorktreePolicyInputSchema,
  type ConfigActionResult,
} from '../schemas';

export async function updateAgentModels(
  rawInput: v.InferInput<typeof updateAgentModelsInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateAgentModelsInputSchema,
    rawInput,
    'config_update_agent_models',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const input = parsed.input;
  if (!hasAgentModelUpdate(input)) {
    return failResult('config_update_agent_models', paths, [paths.config], {
      message: 'At least one model value is required.',
      requires: ['model'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextModels = mergeAgentModelConfig(config.models, input);
  const next = parseAppConfig(
    {
      ...config,
      models: nextModels,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.models ?? {}) !== JSON.stringify(next.models ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_agent_models',
      file: paths.config,
      target: 'models',
      before: config,
      after: next,
    });
  }

  return okResult(
    'config_update_agent_models',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? 'Updated agent model configuration. Start a new session or restart the server for active agents to pick up the change.'
        : 'Agent model configuration already matched the requested values.',
      data: {
        models: next.models,
        appliesAfter: 'new-session-or-server-restart',
        providerRegistration:
          'Model strings must reference providers already registered by Neondeck or Flue runtime configuration.',
      },
    },
  );
}

export async function updateSkillRoots(
  rawInput: v.InferInput<typeof updateSkillRootsInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateSkillRootsInputSchema,
    rawInput,
    'config_update_skill_roots',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextSkillRoots = Array.from(new Set(parsed.input.skillRoots));
  const next = parseAppConfig(
    {
      ...config,
      skillRoots: nextSkillRoots,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.skillRoots ?? []) !==
    JSON.stringify(next.skillRoots ?? []);

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_skill_roots',
      file: paths.config,
      target: 'skillRoots',
      before: config,
      after: next,
    });
  }

  return okResult('config_update_skill_roots', changed, paths, [paths.config], {
    message: changed
      ? 'Updated runtime skill roots. Start a new session for active agents to load changed skills.'
      : 'Runtime skill roots already matched the requested values.',
    data: {
      skillRoots: next.skillRoots ?? [],
      appliesAfter: 'new-session',
    },
  });
}

export async function updateLearningConfig(
  rawInput: v.InferInput<typeof updateLearningConfigInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateLearningConfigInputSchema,
    rawInput,
    'config_update_learning',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  if (!hasLearningConfigUpdate(parsed.input)) {
    return failResult('config_update_learning', paths, [paths.config], {
      message: 'At least one learning config value is required.',
      requires: ['learning'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  const nextLearning = mergeLearningConfig(config.learning, parsed.input);
  const next = parseAppConfig(
    {
      ...config,
      learning: nextLearning,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.learning ?? {}) !==
    JSON.stringify(next.learning ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_learning',
      file: paths.config,
      target: 'learning',
      before: config,
      after: next,
    });
  }

  return okResult('config_update_learning', changed, paths, [paths.config], {
    message: changed
      ? 'Updated learning configuration. Existing sessions keep their loaded memory context until a new session or explicit refresh.'
      : 'Learning configuration already matched the requested values.',
    data: {
      learning: next.learning,
      appliesAfter: 'new-session',
    },
  });
}

export async function updateWorktreePolicy(
  rawInput: v.InferInput<typeof updateWorktreePolicyInputSchema>,
  paths = runtimePaths(),
): Promise<ConfigActionResult> {
  await ensureRuntimeHome(paths);
  const parsed = parseActionInput(
    updateWorktreePolicyInputSchema,
    rawInput,
    'config_update_worktree_policy',
    paths,
    [paths.config],
  );
  if (!parsed.ok) return parsed.result;

  const { confirm, ...input } = parsed.input;
  if (!hasWorktreePolicyUpdate(input)) {
    return failResult('config_update_worktree_policy', paths, [paths.config], {
      message: 'At least one worktree policy setting is required.',
      requires: ['defaultStorage', 'cleanup'],
    });
  }

  const config = await readRuntimeJson(paths.config, parseAppConfig);
  if (worktreePolicyDeletesSooner(config.worktrees, input) && !confirm) {
    return failResult('config_update_worktree_policy', paths, [paths.config], {
      message:
        'Changing worktree cleanup policy toward faster deletion requires explicit confirmation.',
      requires: ['confirm'],
    });
  }
  const nextWorktrees = {
    ...config.worktrees,
    ...input,
    cleanup:
      input.cleanup || config.worktrees?.cleanup
        ? {
            ...config.worktrees?.cleanup,
            ...input.cleanup,
          }
        : undefined,
  };
  const next = parseAppConfig(
    {
      ...config,
      worktrees: nextWorktrees,
    },
    paths.config,
  );
  const changed =
    JSON.stringify(config.worktrees ?? {}) !==
    JSON.stringify(next.worktrees ?? {});

  if (changed) {
    await writeJson(paths.config, next);
    recordConfigChange(paths, {
      action: 'config_update_worktree_policy',
      file: paths.config,
      target: 'worktrees',
      before: config,
      after: next,
    });
  }

  return okResult(
    'config_update_worktree_policy',
    changed,
    paths,
    [paths.config],
    {
      message: changed
        ? 'Updated worktree storage and cleanup policy.'
        : 'Worktree policy already matched the requested values.',
      data: {
        worktrees: next.worktrees,
        policy:
          'Cleanup keeps failed, prepared-diff, and adopted worktrees unless policy or explicit confirmation allows removal.',
      },
    },
  );
}

function hasAgentModelUpdate(
  input: v.InferOutput<typeof updateAgentModelsInputSchema>,
) {
  return Boolean(
    input.default ||
    input.defaultThinkingLevel ||
    input.displayAssistant ||
    input.displayAssistantThinkingLevel ||
    input.utility !== undefined ||
    input.utilityThinkingLevel ||
    input.selfImprovement !== undefined ||
    input.selfImprovementThinkingLevel ||
    input.subagents?.default ||
    input.subagents?.defaultThinkingLevel ||
    input.subagents?.repoResearcher ||
    input.subagents?.repoResearcherThinkingLevel ||
    input.subagents?.ciInvestigator ||
    input.subagents?.ciInvestigatorThinkingLevel ||
    input.subagents?.releaseReviewer ||
    input.subagents?.releaseReviewerThinkingLevel,
  );
}

function hasLearningConfigUpdate(
  input: v.InferOutput<typeof updateLearningConfigInputSchema>,
) {
  return Object.values(input).some((value) => value !== undefined);
}

function hasWorktreePolicyUpdate(
  input: Omit<v.InferOutput<typeof updateWorktreePolicyInputSchema>, 'confirm'>,
) {
  const cleanup = input.cleanup as WorktreeCleanupConfig | undefined;
  return Boolean(
    input.defaultStorage !== undefined ||
    cleanup?.retainFailed !== undefined ||
    cleanup?.retainPreparedDiff !== undefined ||
    cleanup?.successfulGraceHours !== undefined ||
    cleanup?.staleAgeHours !== undefined,
  );
}

function worktreePolicyDeletesSooner(
  current: AppConfig['worktrees'] | undefined,
  input: Omit<v.InferOutput<typeof updateWorktreePolicyInputSchema>, 'confirm'>,
) {
  const currentCleanup = (current?.cleanup ?? {}) as WorktreeCleanupConfig;
  const nextCleanup = (input.cleanup ?? {}) as WorktreeCleanupConfig;
  if (
    currentCleanup.retainFailed !== false &&
    nextCleanup.retainFailed === false
  ) {
    return true;
  }
  if (
    currentCleanup.retainPreparedDiff !== false &&
    nextCleanup.retainPreparedDiff === false
  ) {
    return true;
  }
  const currentSuccessfulGrace = currentCleanup.successfulGraceHours ?? 24;
  const currentStaleAge = currentCleanup.staleAgeHours ?? 168;
  return (
    Boolean(
      nextCleanup.successfulGraceHours !== undefined &&
      nextCleanup.successfulGraceHours < currentSuccessfulGrace,
    ) ||
    Boolean(
      nextCleanup.staleAgeHours !== undefined &&
      nextCleanup.staleAgeHours < currentStaleAge,
    )
  );
}

function mergeAgentModelConfig(
  current: AppConfig['models'] | undefined,
  input: v.InferOutput<typeof updateAgentModelsInputSchema>,
): AgentModelConfig {
  const currentModels = { ...current };
  if (input.utility === null) delete currentModels.utility;
  if (input.selfImprovement === null) delete currentModels.selfImprovement;
  const subagents = {
    ...current?.subagents,
    ...input.subagents,
  };

  return {
    ...currentModels,
    ...(input.default !== undefined ? { default: input.default } : {}),
    ...(input.defaultThinkingLevel !== undefined
      ? { defaultThinkingLevel: input.defaultThinkingLevel }
      : {}),
    ...(input.displayAssistant !== undefined
      ? { displayAssistant: input.displayAssistant }
      : {}),
    ...(input.displayAssistantThinkingLevel !== undefined
      ? { displayAssistantThinkingLevel: input.displayAssistantThinkingLevel }
      : {}),
    ...(input.utility !== undefined && input.utility !== null
      ? { utility: input.utility }
      : {}),
    ...(input.utilityThinkingLevel !== undefined
      ? { utilityThinkingLevel: input.utilityThinkingLevel }
      : {}),
    ...(input.selfImprovement !== undefined && input.selfImprovement !== null
      ? { selfImprovement: input.selfImprovement }
      : {}),
    ...(input.selfImprovementThinkingLevel !== undefined
      ? { selfImprovementThinkingLevel: input.selfImprovementThinkingLevel }
      : {}),
    ...(Object.keys(subagents).length > 0 ? { subagents } : {}),
  };
}

function mergeLearningConfig(
  current: AppConfig['learning'] | undefined,
  input: v.InferOutput<typeof updateLearningConfigInputSchema>,
): LearningConfig {
  return {
    ...current,
    ...input,
  };
}
